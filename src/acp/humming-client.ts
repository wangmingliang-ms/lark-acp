import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type {
  AgentStatus,
  LarkPresenter,
  TimelineEntry,
  ToolStatus,
  SessionCardMeta,
} from "../presenter/presenter.js";

const CARD_FLUSH_DEBOUNCE_MS = 100;
// Feishu's own SDK documents the per markdown element ceiling as 30,000
// characters for streaming card content; above that card updates fail with
// code 230099 / ErrCode 11310 "element exceeds the limit".
export const CARD_MARKDOWN_ELEMENT_CHAR_LIMIT = 30_000;
// Prefer readability over maximum density. Once a card reaches this soft
// threshold, wait for a safe structural boundary (the next tool call) and fold
// earlier prose instead of cutting markdown in the middle.
export const CARD_MARKDOWN_SOFT_CHAR_LIMIT = 4_096;

const CARD_COMPACTION_NOTICE_PREFIX = "_前面内容较长，已在安全边界折叠_";

type CardUpdateFailurePhase = "running" | "terminal";
type CardCompactionReason = "tool" | "final" | "emergency";

const PERMISSION_TIMEOUT_REASON = "用户未在规定时间内响应，已自动取消";
const PERMISSION_SHUTDOWN_REASON = "会话已结束，本次确认已失效";

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Card message id, set once `sendInterruptCard` resolves. */
  cardMessageId: string | null;
}

function assertNeverToolStatus(x: never): never {
  throw new Error(`unexpected tool status: ${String(x)}`);
}

function isTerminalStatus(status: AgentStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "failed";
}

function normalizeToolStatus(status: ToolStatus): ToolStatus {
  switch (status) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return status;
    default:
      return assertNeverToolStatus(status);
  }
}

interface SealedToolMeta {
  readonly title: string;
  readonly kind: string;
  readonly detail?: string;
}

type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;

interface ToolDisplay {
  readonly title: string;
  readonly detail?: string;
}

function entryTextLength(entry: TimelineEntry): number {
  switch (entry.kind) {
    case "text":
    case "thought":
      return entry.text.length;
    case "tool":
      return entry.title.length + entry.toolKind.length + (entry.detail?.length ?? 0);
    default:
      return assertNeverEntry(entry);
  }
}

function timelineTextLength(entries: readonly TimelineEntry[]): number {
  return entries.reduce((sum, entry) => sum + entryTextLength(entry), 0);
}

function compactionNoticeReason(reason: CardCompactionReason): string {
  switch (reason) {
    case "tool":
      return "下一次 tool call 开始前";
    case "final":
      return "任务结束前";
    case "emergency":
      return "发送卡片前";
    default:
      return assertNeverReason(reason);
  }
}

function compactedEntry(removedChars: number, reason: CardCompactionReason): TimelineEntry {
  return {
    kind: "text",
    text: `${CARD_COMPACTION_NOTICE_PREFIX}：${compactionNoticeReason(reason)}折叠约 ${removedChars.toLocaleString("en-US")} 个字符。完整内容请查看 Agent 本地会话记录或日志。`,
  };
}

function assertNeverEntry(x: never): never {
  throw new Error(`unexpected timeline entry: ${String(x)}`);
}

function assertNeverReason(x: never): never {
  throw new Error(`unexpected compaction reason: ${String(x)}`);
}

function formatToolDisplay(
  kind: string,
  title: string,
  rawInput: unknown,
  locations: readonly acp.ToolCallLocation[] | null | undefined,
): ToolDisplay {
  if (kind === "execute") {
    const command = commandFromRawInput(rawInput);
    if (command) {
      const displayTitle =
        title === "unknown" || title === command || title.length > 80 ? "Command" : title;
      return { title: displayTitle, detail: fencedCode(redactCommand(command), "bash") };
    }
    return { title };
  }

  if (isFileToolKind(kind)) {
    const filePath = firstPath(locations, rawInput);
    if (filePath) return { title: path.basename(filePath) || filePath };
  }

  return { title };
}

function isFileToolKind(kind: string): boolean {
  return kind === "read" || kind === "edit" || kind === "delete" || kind === "move";
}

function firstPath(
  locations: readonly acp.ToolCallLocation[] | null | undefined,
  rawInput: unknown,
): string | undefined {
  const locationPath = locations?.find(
    (loc) => typeof loc.path === "string" && loc.path.length > 0,
  )?.path;
  if (locationPath) return locationPath;
  return stringField(rawInput, [
    "path",
    "file",
    "filePath",
    "filepath",
    "filename",
    "target",
    "source",
  ]);
}

function commandFromRawInput(rawInput: unknown): string | undefined {
  if (typeof rawInput === "string") return rawInput.trim() || undefined;
  if (!isRecord(rawInput)) return undefined;

  const direct = stringField(rawInput, ["command", "cmd", "commandLine", "shellCommand", "script"]);
  const args = arrayOfStrings(rawInput["args"]) ?? arrayOfStrings(rawInput["argv"]);
  if (direct && args && args.length > 0) return [direct, ...args.map(shellQuote)].join(" ");
  if (direct) return direct.trim() || undefined;
  return undefined;
}

function commandTokensFromRawInput(rawInput: unknown): readonly string[] {
  if (typeof rawInput === "string") return shellWords(rawInput);
  if (!isRecord(rawInput)) return [];
  const args = arrayOfStrings(rawInput["args"]) ?? arrayOfStrings(rawInput["argv"]);
  const direct = stringField(rawInput, ["command", "cmd", "commandLine", "shellCommand", "script"]);
  if (args) return direct ? [direct, ...args] : args;
  return direct ? shellWords(direct) : [];
}

function shellWords(command: string): readonly string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function isHummingCliPermissionRequest(params: acp.RequestPermissionRequest): boolean {
  const tokens = commandTokensFromRawInput(params.toolCall?.rawInput);
  if (tokens.length === 0) return false;
  const binary = commandBasename(tokens[0] ?? "");
  return binary === "humming" || binary === "humming.cmd" || binary === "humming.ps1";
}

function commandBasename(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase();
}

function stringField(raw: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function fencedCode(text: string, language: string): string {
  const safe = text.replaceAll("```", "`\u200b``");
  return `\`\`\`${language}\n${safe}\n\`\`\``;
}

// Best-effort secret masking for commands echoed into cards. It covers the
// common shapes (`FOO_TOKEN=...`, `--api-key xxx`, `Authorization: Bearer ...`)
// but is not a security boundary: obscure conventions such as `mysql -pSECRET`
// or values piped via stdin can still slip through. Prefer over-redaction.
const SECRET_WORD = "key|token|secret|password|pass|pwd";

function redactCommand(command: string): string {
  return (
    command
      .replace(
        new RegExp(`(\\b[A-Z0-9_]*(?:${SECRET_WORD})[A-Z0-9_]*\\s*=\\s*)([^\\s'";]+)`, "gi"),
        "$1[REDACTED]",
      )
      .replace(new RegExp(`(\\b(?:${SECRET_WORD})\\s*[=:]\\s*)([^\\s'";]+)`, "gi"), "$1[REDACTED]")
      // Space-separated flag values: `--token abc`, `--api-key xyz`. The `(?!-)`
      // guard keeps a valueless flag from eating the next flag as its "value".
      .replace(
        new RegExp(`(--?[A-Za-z0-9-]*(?:${SECRET_WORD})[A-Za-z0-9-]*\\s+)(?!-)([^\\s'";]+)`, "gi"),
        "$1[REDACTED]",
      )
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
  );
}

/**
 * Strategy for handling agent-side permission requests.
 *
 * - `alwaysAsk` (default) — forward every request to the user as a Lark card
 *   and block the agent until they pick an option.
 * - `alwaysAllow` — auto-pick the agent's first `allow_*` option without
 *   bothering the user. Falls back to `cancelled` if no allow option exists.
 * - `alwaysDeny` — auto-pick the agent's first `reject_*` option, falling
 *   back to `cancelled` (which the agent treats as a denial).
 */
export type PermissionMode = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "alwaysAsk",
  "alwaysAllow",
  "alwaysDeny",
] as const;

export interface HummingClientOptions {
  presenter: LarkPresenter;
  logger: LarkLogger;
  /** Include `agent_thought_chunk` updates in the unified card. */
  showThoughts: boolean;
  /** Render `tool_call` / `tool_call_update` events in the conversation card. */
  showTools: boolean;
  /**
   * Render the "中断当前任务" button at the bottom of the running card.
   * When `false`, the only way to cancel is via a chat command.
   */
  showCancelButton: boolean;
  /** Resolve a pending permission as `cancelled` after this many ms (0 = never). */
  permissionTimeoutMs: number;
  /** Permission gate strategy — see {@link PermissionMode}. */
  permissionMode: PermissionMode;
  /**
   * After a content-bearing card goes quiet for this many ms, create a fresh
   * empty status card. The next visible event reuses that card slot. 0 disables.
   */
  idleStatusCardMs: number;
  /** Lazily returns current agent/model/mode/permission metadata for card footer. */
  metaProvider?: () => SessionCardMeta;
  /** Receives ACP session metadata updates so the runtime can persist them. */
  onSessionInfoUpdate?: (
    update: Extract<acp.SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ) => void;
}

/**
 * `acp.Client` implementation for one Lark chat. Builds compact conversation
 * cards containing assistant text, thoughts, and tool-call markers in one
 * chronological timeline. Approval cards are the hard boundary: before an
 * approval request the current conversation card is sealed, then the approval
 * card is shown, and any post-approval output starts a fresh conversation card.
 *
 * One instance per chat — it holds per-prompt state (current message id,
 * timeline entries, unified card id, pending permissions).
 */
export class HummingClient implements acp.Client {
  private readonly presenter: LarkPresenter;
  private readonly logger: LarkLogger;
  private readonly showThoughts: boolean;
  private readonly showTools: boolean;
  private readonly showCancelButton: boolean;
  private readonly permissionTimeoutMs: number;
  private readonly idleStatusCardMs: number;
  private readonly metaProvider?: () => SessionCardMeta;
  private readonly onSessionInfoUpdate?: (
    update: Extract<acp.SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ) => void;
  private permissionMode: PermissionMode;
  private timeline: TimelineEntry[] = [];
  private status: AgentStatus = "thinking";
  private currentMessageId = "";
  private currentChatId = "";
  private currentThreadId: string | null = null;

  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /** Tool metadata captured at approval boundaries; used to restore sparse post-approval updates. */
  private readonly sealedToolMeta = new Map<string, SealedToolMeta>();

  private cardId: string | null = null;
  private cardCreating: Promise<string | null> | null = null;
  private idleStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private idleStatusCardPending = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private permissionBoundaryThisPrompt = false;
  private needsBoundaryCompaction = false;
  private readonly cardFailureNoticePhases = new Set<CardUpdateFailurePhase>();
  /**
   * True only between {@link setContext} and terminal {@link finalize}. ACP
   * adapters can still deliver buffered session updates after a prompt has
   * already resolved or after the runtime has been superseded. Those late
   * updates must not reopen a sealed card and make it look in-progress again.
   */
  private acceptingRenderableUpdates = false;

  constructor(opts: HummingClientOptions) {
    this.presenter = opts.presenter;
    this.logger = opts.logger.child({ name: "acp-client" });
    this.showThoughts = opts.showThoughts;
    this.showTools = opts.showTools;
    this.showCancelButton = opts.showCancelButton;
    this.permissionTimeoutMs = opts.permissionTimeoutMs;
    this.idleStatusCardMs = opts.idleStatusCardMs;
    this.metaProvider = opts.metaProvider;
    this.onSessionInfoUpdate = opts.onSessionInfoUpdate;
    this.permissionMode = opts.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /** Bind the current Lark message context so cards reply to the right message. */
  setContext(messageId: string, chatId: string, threadId: string | null): void {
    this.currentMessageId = messageId;
    this.currentChatId = chatId;
    this.currentThreadId = threadId;
    this.cardFailureNoticePhases.clear();
    this.acceptingRenderableUpdates = true;
  }

  /** Continue rendering into a progress card the bridge already created for this prompt. */
  adoptProgressCard(cardMessageId: string | null | undefined): void {
    if (!cardMessageId) return;
    this.cardId = cardMessageId;
    this.cardCreating = null;
  }

  /** Show that the runtime is bootstrapping or connecting to the target agent. */
  async showPreparing(): Promise<void> {
    this.status = "preparing";
    await this.renderCard({ cancellable: false });
  }

  /** Show that the user's message has been forwarded and Humming is waiting for agent output. */
  async showForwarded(): Promise<void> {
    this.status = "thinking";
    await this.renderCard({ cancellable: true });
  }

  // ----- Permission flow --------------------------------------------------

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (isHummingCliPermissionRequest(params)) {
      return this.autoResolvePermission(params, "alwaysAllow");
    }
    if (this.permissionMode !== "alwaysAsk") {
      return this.autoResolvePermission(params, this.permissionMode);
    }

    if (!this.currentMessageId) {
      this.logger.warn(
        { tool: params.toolCall?.title ?? "unknown" },
        "no message context — cancelling permission request",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    const requestId = crypto.randomUUID();
    const reuseStatusCard = this.hasReusableStatusCard();
    const toolCallId = params.toolCall?.toolCallId;
    if (toolCallId) {
      const toolStatus = (params.toolCall?.status ?? "pending") as ToolStatus;
      const display = formatToolDisplay(
        params.toolCall?.kind ?? "tool",
        params.toolCall?.title ?? "unknown",
        params.toolCall?.rawInput,
        params.toolCall?.locations,
      );
      if (this.showTools && !reuseStatusCard) {
        this.upsertTool(
          toolCallId,
          display.title,
          params.toolCall?.kind ?? "tool",
          normalizeToolStatus(toolStatus),
          display.detail,
        );
      }
      this.sealedToolMeta.set(toolCallId, {
        title: display.title,
        kind: params.toolCall?.kind ?? "tool",
        ...(display.detail !== undefined ? { detail: display.detail } : {}),
      });
    }
    if (!reuseStatusCard) await this.finishCurrentConversationSegment();
    this.permissionBoundaryThisPrompt = true;

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        resolve,
        timer: null,
        cardMessageId: null,
      };
      this.pendingPermissions.set(requestId, pending);

      if (this.permissionTimeoutMs > 0) {
        pending.timer = setTimeout(
          () => this.expirePendingPermission(requestId, PERMISSION_TIMEOUT_REASON),
          this.permissionTimeoutMs,
        );
      }

      this.sendOrUpdatePermissionCard(params, requestId)
        .then((cardMessageId) => {
          const stillPending = this.pendingPermissions.get(requestId);
          if (stillPending) stillPending.cardMessageId = cardMessageId;
        })
        .catch((err) => {
          this.logger.warn({ err, requestId }, "send permission card failed");
          this.disposePending(requestId);
          resolve({ outcome: { outcome: "cancelled" } });
        });
    });
  }

  private async sendOrUpdatePermissionCard(
    params: acp.RequestPermissionRequest,
    requestId: string,
  ): Promise<string | null> {
    const pendingStatusCardId = this.consumeIdleStatusCardId();
    if (pendingStatusCardId) {
      const updated = await this.presenter.updateInterruptCard(
        pendingStatusCardId,
        params,
        requestId,
        this.currentChatId,
        this.currentThreadId,
      );
      if (updated) return pendingStatusCardId;
    }
    return this.presenter.sendInterruptCard(
      this.currentMessageId,
      params,
      requestId,
      this.currentChatId,
      this.currentThreadId,
    );
  }

  private async finishCurrentConversationSegment(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.clearIdleStatusTimer();
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));

    if (!this.hasRenderableState()) return;

    this.status = "sealed";
    await this.renderCard({ cancellable: false });

    this.timeline = [];
    this.cardId = null;
    this.cardCreating = null;
    this.status = "thinking";
  }

  private autoResolvePermission(
    params: acp.RequestPermissionRequest,
    mode: "alwaysAllow" | "alwaysDeny",
  ): acp.RequestPermissionResponse {
    const wantAllow = mode === "alwaysAllow";
    const prefix = wantAllow ? "allow_" : "reject_";
    const match = params.options.find((o) => o.kind.startsWith(prefix));
    const tool = params.toolCall?.title ?? "unknown";

    if (!match) {
      this.logger.warn(
        { mode, tool, kinds: params.options.map((o) => o.kind) },
        "permissionMode auto-resolve found no matching option, falling back to cancelled",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    this.logger.info(
      { mode, tool, optionId: match.optionId, kind: match.kind },
      "permissionMode auto-resolved",
    );
    return { outcome: { outcome: "selected", optionId: match.optionId } };
  }

  handleCardAction(requestId: string, optionId: string): boolean {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return false;
    this.disposePending(requestId);
    this.createPostInteractionStatusCard().catch((err) =>
      this.logger.warn({ err, requestId }, "post-approval status card creation failed"),
    );
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  cancelPendingPermission(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.expirePendingPermission(requestId, PERMISSION_SHUTDOWN_REASON);
    }
  }

  private expirePendingPermission(requestId: string, reason: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    this.disposePending(requestId);
    pp.resolve({ outcome: { outcome: "cancelled" } });

    const cardId = pp.cardMessageId;
    if (cardId) {
      this.presenter
        .expirePermissionCard(cardId, reason)
        .catch((err) => this.logger.debug({ err, cardId }, "expirePermissionCard rejected"));
    }
  }

  private disposePending(requestId: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    if (pp.timer) clearTimeout(pp.timer);
    this.pendingPermissions.delete(requestId);
  }

  // ----- Session updates → timeline --------------------------------------

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (!this.acceptingRenderableUpdates) return;
        if (u.content.type === "text") {
          this.markVisibleContentArriving();
          this.appendText("text", u.content.text);
          this.markCompactionNeededIfOverSoftLimit();
          this.status = "responding";
          this.scheduleFlush();
        }
        return;

      case "agent_thought_chunk":
        if (!this.acceptingRenderableUpdates) return;
        if (u.content.type === "text" && this.showThoughts) {
          this.markVisibleContentArriving();
          this.appendText("thought", u.content.text);
          this.markCompactionNeededIfOverSoftLimit();
          if (this.status !== "responding") this.status = "thinking";
          this.scheduleFlush();
        }
        return;

      case "tool_call": {
        if (!this.acceptingRenderableUpdates) return;
        this.compactTimelineAtBoundary("tool");
        if (!this.showTools) {
          this.scheduleFlush();
          return;
        }
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
        this.markVisibleContentArriving();
        this.status = "calling_tool";
        const display = formatToolDisplay(
          u.kind ?? "tool",
          u.title ?? "unknown",
          u.rawInput,
          u.locations,
        );
        this.upsertTool(
          toolCallId,
          display.title,
          u.kind ?? "tool",
          normalizeToolStatus((u.status ?? "in_progress") as ToolStatus),
          display.detail,
        );
        this.scheduleFlush();
        return;
      }

      case "tool_call_update": {
        if (!this.acceptingRenderableUpdates) return;
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
        if (u.status !== "completed" && u.status !== "failed") return;

        const display = formatToolDisplay(
          u.kind ?? "tool",
          u.title ?? "unknown",
          u.rawInput,
          u.locations,
        );
        // Card v2 stays compact: tool entries are timeline markers, so we keep
        // the formatted command/detail only and drop raw stdout/diff output,
        // which would blow past Lark card size limits.
        const detail = display.detail;
        this.markVisibleContentArriving();
        if (this.status !== "responding") this.status = "calling_tool";
        this.upsertTool(
          toolCallId,
          display.title,
          u.kind ?? "tool",
          normalizeToolStatus(u.status as ToolStatus),
          detail,
        );
        this.scheduleFlush();
        return;
      }

      // Session metadata updates are persisted by ChatRuntime. They are not
      // user-renderable timeline content.
      case "session_info_update":
        this.onSessionInfoUpdate?.(u);
        return;

      // Session-control updates are consumed by ChatRuntime's capability
      // tracker. They are not user-renderable timeline content.
      case "current_mode_update":
      case "config_option_update":
      case "usage_update":
      case "available_commands_update":
      case "plan":
      case "user_message_chunk":
        return;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.promises.readFile(params.path, "utf-8");
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.promises.writeFile(params.path, params.content, "utf-8");
    return {};
  }

  /**
   * Finalise the current conversation card with the given terminal status, then
   * reset per-prompt state so the next prompt starts clean.
   */
  async finalize(status: AgentStatus): Promise<void> {
    this.status = status;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.clearIdleStatusTimer();
    // Wait for any in-flight flush so we don't race the final patch.
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));
    const hasRenderableState = this.hasRenderableState();
    const shouldSkipEmptyFinalCard = !hasRenderableState && this.permissionBoundaryThisPrompt;
    if (!shouldSkipEmptyFinalCard) {
      if (!hasRenderableState && isTerminalStatus(status)) {
        this.logger.warn(
          { status, currentMessageId: this.currentMessageId },
          "agent prompt finalized with no renderable output",
        );
      }
      this.compactTimelineForFinalCard();
      await this.renderCard({ cancellable: false });
    }
    this.timeline = [];
    this.sealedToolMeta.clear();
    this.cardId = null;
    this.cardCreating = null;
    this.idleStatusCardPending = false;
    this.permissionBoundaryThisPrompt = false;
    this.needsBoundaryCompaction = false;
    this.acceptingRenderableUpdates = false;
    this.status = "thinking";
  }

  // ----- Timeline mutators ------------------------------------------------

  private appendText(kind: "text" | "thought", text: string): void {
    if (!text) return;
    const last = this.timeline.at(-1);
    if (last && last.kind === kind) {
      last.text += text;
      return;
    }
    this.timeline.push({ kind, text });
  }

  private markCompactionNeededIfOverSoftLimit(): void {
    if (this.needsBoundaryCompaction) return;
    if (timelineTextLength(this.timeline) >= CARD_MARKDOWN_SOFT_CHAR_LIMIT) {
      this.needsBoundaryCompaction = true;
    }
  }

  private compactTimelineAtBoundary(reason: CardCompactionReason): void {
    if (
      !this.needsBoundaryCompaction &&
      timelineTextLength(this.timeline) < CARD_MARKDOWN_SOFT_CHAR_LIMIT
    ) {
      return;
    }
    this.timeline = this.compactEntriesKeepingTail(
      this.timeline,
      reason,
      CARD_MARKDOWN_SOFT_CHAR_LIMIT,
    );
    this.needsBoundaryCompaction = false;
  }

  private compactTimelineForFinalCard(): void {
    if (timelineTextLength(this.timeline) >= CARD_MARKDOWN_SOFT_CHAR_LIMIT) {
      this.timeline = this.compactEntriesKeepingTail(
        this.timeline,
        "final",
        CARD_MARKDOWN_SOFT_CHAR_LIMIT,
      );
    }
    if (timelineTextLength(this.timeline) >= CARD_MARKDOWN_ELEMENT_CHAR_LIMIT) {
      this.timeline = this.compactEntriesKeepingTail(
        this.timeline,
        "emergency",
        CARD_MARKDOWN_SOFT_CHAR_LIMIT,
      );
    }
    this.needsBoundaryCompaction = false;
  }

  private compactEntriesKeepingTail(
    entries: readonly TimelineEntry[],
    reason: CardCompactionReason,
    targetChars: number,
  ): TimelineEntry[] {
    let tailLength = 0;
    const kept: TimelineEntry[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry) continue;
      const nextLength = tailLength + entryTextLength(entry);
      if (nextLength > targetChars) break;
      kept.unshift(entry);
      tailLength = nextLength;
    }

    if (kept.length === entries.length) return [...entries];
    const keptCount = kept.length;
    const removed = entries.slice(0, entries.length - keptCount);
    const removedChars = timelineTextLength(removed);
    return [compactedEntry(removedChars, reason), ...kept];
  }

  private upsertTool(
    toolCallId: string,
    title: string,
    toolKind: string,
    status: ToolStatus,
    detail?: string,
  ): void {
    const existing = this.timeline.find(
      (entry): entry is ToolEntry => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    if (existing !== undefined) {
      if (title !== "unknown") existing.title = title;
      if (toolKind !== "tool") existing.toolKind = toolKind;
      existing.status = status;
      if (detail !== undefined) {
        existing.detail = existing.detail ? `${existing.detail}\n\n${detail}` : detail;
      }
      return;
    }

    const meta = this.sealedToolMeta.get(toolCallId);
    if (meta !== undefined) this.sealedToolMeta.delete(toolCallId);
    const resolvedTitle = title !== "unknown" ? title : (meta?.title ?? title);
    const resolvedKind = toolKind !== "tool" ? toolKind : (meta?.kind ?? toolKind);
    const resolvedDetail = detail ?? meta?.detail;
    this.timeline.push({
      kind: "tool",
      toolCallId,
      title: resolvedTitle,
      toolKind: resolvedKind,
      status,
      ...(resolvedDetail !== undefined ? { detail: resolvedDetail } : {}),
    });
  }

  private hasRenderableState(): boolean {
    return this.timeline.length > 0 || this.cardId !== null || this.cardCreating !== null;
  }

  private hasReusableStatusCard(): boolean {
    return this.idleStatusCardPending && this.timeline.length === 0 && this.cardId !== null;
  }

  private consumeIdleStatusCardId(): string | null {
    if (!this.hasReusableStatusCard()) return null;
    const cardId = this.cardId;
    this.idleStatusCardPending = false;
    this.cardId = null;
    this.cardCreating = null;
    this.timeline = [];
    return cardId;
  }

  private clearIdleStatusTimer(): void {
    if (!this.idleStatusTimer) return;
    clearTimeout(this.idleStatusTimer);
    this.idleStatusTimer = null;
  }

  private markVisibleContentArriving(): void {
    this.clearIdleStatusTimer();
    if (this.idleStatusCardPending) this.idleStatusCardPending = false;
  }

  private scheduleIdleStatusTimer(
    renderedEntries: readonly TimelineEntry[],
    cancellable: boolean,
  ): void {
    this.clearIdleStatusTimer();
    if (this.idleStatusCardMs <= 0) return;
    if (!this.acceptingRenderableUpdates || !cancellable) return;
    if (this.idleStatusCardPending || renderedEntries.length === 0) return;

    this.idleStatusTimer = setTimeout(() => {
      this.idleStatusTimer = null;
      this.createIdleStatusCard().catch((err) =>
        this.logger.warn({ err }, "idle status card creation failed"),
      );
    }, this.idleStatusCardMs);
  }

  private async createIdleStatusCard(): Promise<void> {
    if (
      !this.acceptingRenderableUpdates ||
      this.idleStatusCardPending ||
      this.timeline.length === 0
    ) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));
    if (
      !this.acceptingRenderableUpdates ||
      this.idleStatusCardPending ||
      this.timeline.length === 0
    ) {
      return;
    }

    this.status = "sealed";
    await this.renderCard({ cancellable: false });

    this.timeline = [];
    this.cardId = null;
    this.cardCreating = null;
    this.status = "thinking";
    this.idleStatusCardPending = true;
    await this.renderCard({ cancellable: true });
    if (this.cardId === null) this.idleStatusCardPending = false;
  }

  private async createPostInteractionStatusCard(): Promise<void> {
    if (!this.acceptingRenderableUpdates || this.idleStatusCardPending) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));
    if (!this.acceptingRenderableUpdates || this.idleStatusCardPending) return;

    this.timeline = [];
    this.cardId = null;
    this.cardCreating = null;
    this.status = "thinking";
    this.idleStatusCardPending = true;
    await this.renderCard({ cancellable: true });
    if (this.cardId === null) this.idleStatusCardPending = false;
  }

  // ----- Card flush -------------------------------------------------------

  private scheduleFlush(): void {
    if (!this.currentMessageId) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.renderCard({ cancellable: true }).catch((err) =>
        this.logger.warn({ err }, "card flush failed"),
      );
    }, CARD_FLUSH_DEBOUNCE_MS);
  }

  private async notifyCardUpdateFailure(phase: CardUpdateFailurePhase): Promise<void> {
    if (!this.currentMessageId || this.cardFailureNoticePhases.has(phase)) return;
    this.cardFailureNoticePhases.add(phase);
    const terminal = phase === "terminal";
    await this.presenter
      .replyNoticeCard(this.currentMessageId, {
        title: terminal ? "⚠️ Humming 卡片更新失败" : "⚠️ Humming 卡片暂时无法更新",
        body: terminal
          ? "Agent 任务已经结束，但飞书拒绝更新原始进度卡片。Humming 已写入日志；原卡片可能仍显示旧状态。"
          : "Agent 任务仍在继续，但飞书拒绝更新当前进度卡片。Humming 已写入日志，后续仍会尝试更新。",
        template: terminal ? "orange" : "grey",
      })
      .catch((err) => this.logger.warn({ err, phase }, "card update failure notice failed"));
  }

  private previewEntriesForRender(): readonly TimelineEntry[] {
    if (timelineTextLength(this.timeline) < CARD_MARKDOWN_ELEMENT_CHAR_LIMIT) return this.timeline;
    return this.compactEntriesKeepingTail(
      this.timeline,
      "emergency",
      CARD_MARKDOWN_SOFT_CHAR_LIMIT,
    );
  }

  private async renderCard(opts: { cancellable: boolean }): Promise<void> {
    if (!this.currentMessageId && !this.cardId) return;
    this.flushing = true;
    try {
      const renderedEntries = this.previewEntriesForRender();
      const state = {
        status: this.status,
        entries: renderedEntries,
        cancellable: opts.cancellable && this.showCancelButton,
        chatId: this.currentChatId,
        threadId: this.currentThreadId,
        meta: this.metaProvider?.(),
      };

      if (this.cardId) {
        const updated = await this.presenter.updateUnifiedCard(this.cardId, state);
        if (!updated) await this.notifyCardUpdateFailure(opts.cancellable ? "running" : "terminal");
        this.scheduleIdleStatusTimer(renderedEntries, opts.cancellable);
        return;
      }
      if (this.cardCreating) {
        const id = await this.cardCreating;
        if (id) {
          this.cardId = id;
          const updated = await this.presenter.updateUnifiedCard(id, state);
          if (!updated)
            await this.notifyCardUpdateFailure(opts.cancellable ? "running" : "terminal");
          this.scheduleIdleStatusTimer(renderedEntries, opts.cancellable);
        }
        return;
      }
      const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
      this.cardCreating = promise;
      try {
        const id = await promise;
        if (id) this.cardId = id;
        this.scheduleIdleStatusTimer(renderedEntries, opts.cancellable);
      } finally {
        this.cardCreating = null;
      }
    } finally {
      this.flushing = false;
    }
  }
}
