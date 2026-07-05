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
} from "../presenter/presenter.js";

const CARD_FLUSH_DEBOUNCE_MS = 100;

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

export interface LarkAcpClientOptions {
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
export class LarkAcpClient implements acp.Client {
  private readonly presenter: LarkPresenter;
  private readonly logger: LarkLogger;
  private readonly showThoughts: boolean;
  private readonly showTools: boolean;
  private readonly showCancelButton: boolean;
  private readonly permissionTimeoutMs: number;
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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private permissionBoundaryThisPrompt = false;

  constructor(opts: LarkAcpClientOptions) {
    this.presenter = opts.presenter;
    this.logger = opts.logger.child({ name: "acp-client" });
    this.showThoughts = opts.showThoughts;
    this.showTools = opts.showTools;
    this.showCancelButton = opts.showCancelButton;
    this.permissionTimeoutMs = opts.permissionTimeoutMs;
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
  }

  // ----- Permission flow --------------------------------------------------

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
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
    const toolCallId = params.toolCall?.toolCallId;
    if (toolCallId) {
      const toolStatus = (params.toolCall?.status ?? "pending") as ToolStatus;
      const display = formatToolDisplay(
        params.toolCall?.kind ?? "tool",
        params.toolCall?.title ?? "unknown",
        params.toolCall?.rawInput,
        params.toolCall?.locations,
      );
      if (this.showTools) {
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
    await this.finishCurrentConversationSegment();
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

      this.presenter
        .sendInterruptCard(
          this.currentMessageId,
          params,
          requestId,
          this.currentChatId,
          this.currentThreadId,
        )
        .then((cardMessageId) => {
          const stillPending = this.pendingPermissions.get(requestId);
          if (stillPending) stillPending.cardMessageId = cardMessageId;
        })
        .catch((err) => {
          this.logger.warn({ err, requestId }, "sendInterruptCard failed");
          this.disposePending(requestId);
          resolve({ outcome: { outcome: "cancelled" } });
        });
    });
  }

  private async finishCurrentConversationSegment(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
        if (u.content.type === "text") {
          this.appendText("text", u.content.text);
          this.status = "responding";
          this.scheduleFlush();
        }
        return;

      case "agent_thought_chunk":
        if (u.content.type === "text" && this.showThoughts) {
          this.appendText("thought", u.content.text);
          if (this.status !== "responding") this.status = "thinking";
          this.scheduleFlush();
        }
        return;

      case "tool_call": {
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
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

      // Session-control updates are consumed by ChatRuntime's capability
      // tracker. They are not user-renderable timeline content.
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
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
    // Wait for any in-flight flush so we don't race the final patch.
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));
    const hasRenderableState = this.hasRenderableState();
    const shouldSkipEmptyFinalCard = !hasRenderableState && this.permissionBoundaryThisPrompt;
    if (!shouldSkipEmptyFinalCard) await this.renderCard({ cancellable: false });
    this.timeline = [];
    this.sealedToolMeta.clear();
    this.cardId = null;
    this.cardCreating = null;
    this.permissionBoundaryThisPrompt = false;
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

  private async renderCard(opts: { cancellable: boolean }): Promise<void> {
    if (!this.currentMessageId && !this.cardId) return;
    this.flushing = true;
    try {
      const state = {
        status: this.status,
        entries: this.timeline,
        cancellable: opts.cancellable && this.showCancelButton,
        chatId: this.currentChatId,
        threadId: this.currentThreadId,
      };

      if (this.cardId) {
        await this.presenter.updateUnifiedCard(this.cardId, state);
        return;
      }
      if (this.cardCreating) {
        const id = await this.cardCreating;
        if (id) {
          this.cardId = id;
          await this.presenter.updateUnifiedCard(id, state);
        }
        return;
      }
      const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
      this.cardCreating = promise;
      try {
        const id = await promise;
        if (id) this.cardId = id;
      } finally {
        this.cardCreating = null;
      }
    } finally {
      this.flushing = false;
    }
  }
}
