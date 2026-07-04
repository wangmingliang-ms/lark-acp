import fs from "node:fs";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type {
  AgentStatus,
  LarkPresenter,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "../presenter/presenter.js";

// Hermes Agent uses a deliberately slower edit cadence for chat-platform
// streaming. Feishu `message.update` is an edit API, not a card patch stream;
// keep updates well below high-frequency token cadence and rotate before the
// per-message edit budget is exhausted.
const DEFAULT_POST_FLUSH_DEBOUNCE_MS = 800;
const DEFAULT_MAX_POST_EDITS = 18;

const PERMISSION_TIMEOUT_REASON = "用户未在规定时间内响应，已自动取消";
const PERMISSION_SHUTDOWN_REASON = "会话已结束，本次确认已失效";

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Card message id, set once `sendInterruptCard` resolves. */
  cardMessageId: string | null;
}

function toolStatusToAgentStatus(status: ToolStatus): AgentStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
      return "calling_tool";
    default:
      return assertNeverToolStatus(status);
  }
}

function assertNeverToolStatus(x: never): never {
  throw new Error(`unexpected tool status: ${String(x)}`);
}

function hasToolUpdateResult(update: acp.ToolCallUpdate): boolean {
  return (
    Object.prototype.hasOwnProperty.call(update, "rawOutput") ||
    (Array.isArray(update.content) && update.content.length > 0)
  );
}

interface SealedToolMeta {
  readonly title: string;
  readonly kind: string;
}

type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;

interface ToolGroupState {
  cardId: string | null;
  cardCreating: Promise<string | null> | null;
  editCount: number;
  entries: ToolEntry[];
}

interface ToolEntryState {
  group: ToolGroupState;
  entry: ToolEntry;
}

function cloneEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return structuredClone(entries) as TimelineEntry[];
}

function sameRenderableEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "text":
    case "thought":
      return a.text === (b as typeof a).text;
    case "tool": {
      const other = b as typeof a;
      return (
        a.toolCallId === other.toolCallId &&
        a.title === other.title &&
        a.toolKind === other.toolKind &&
        a.status === other.status
      );
    }
    default:
      return assertNeverEntry(a);
  }
}

function assertNeverEntry(x: never): never {
  throw new Error(`unexpected timeline entry: ${String(x)}`);
}

function sameRenderableEntries(a: readonly TimelineEntry[], b: readonly TimelineEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => sameRenderableEntry(entry, b[i]!));
}

function timelineContinuation(
  previous: readonly TimelineEntry[],
  current: readonly TimelineEntry[],
): TimelineEntry[] {
  if (previous.length === 0) return cloneEntries(current);

  const tail: TimelineEntry[] = [];
  for (let i = 0; i < current.length; i += 1) {
    const currentEntry = current[i]!;
    const previousEntry = previous[i];
    if (previousEntry === undefined) {
      tail.push(...cloneEntries(current.slice(i)));
      break;
    }
    if (sameRenderableEntry(previousEntry, currentEntry)) continue;
    if (
      (currentEntry.kind === "text" || currentEntry.kind === "thought") &&
      previousEntry.kind === currentEntry.kind &&
      currentEntry.text.startsWith(previousEntry.text)
    ) {
      const suffix = currentEntry.text.slice(previousEntry.text.length);
      if (suffix) tail.push({ kind: currentEntry.kind, text: suffix });
      tail.push(...cloneEntries(current.slice(i + 1)));
      break;
    }
    tail.push(...cloneEntries(current.slice(i)));
    break;
  }

  return tail;
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
  /** Include `agent_thought_chunk` updates in the unified output stream. */
  showThoughts: boolean;
  /** Render `tool_call` / `tool_call_update` events as standalone tool posts. */
  showTools: boolean;
  /**
   * Render the "中断当前任务" button in legacy card renderers. Hermes-style
   * post output cannot display buttons; cancellation is via chat commands.
   */
  showCancelButton: boolean;
  /** Debounce for post-message streaming edits. Defaults to Hermes' slower cadence. */
  postFlushDebounceMs?: number;
  /** Safe per-post edit budget before a new post is opened. */
  maxPostEdits?: number;
  /** Resolve a pending permission as `cancelled` after this many ms (0 = never). */
  permissionTimeoutMs: number;
  /** Permission gate strategy — see {@link PermissionMode}. */
  permissionMode: PermissionMode;
}

/**
 * `acp.Client` implementation for one Lark chat. Builds a unified
 * post timelines for assistant text/thoughts, split whenever a tool call
 * interrupts the assistant message. Consecutive tool calls are grouped into
 * an editable tool-progress post until assistant text lands below them.
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
  private readonly permissionMode: PermissionMode;
  private readonly postFlushDebounceMs: number;
  private readonly maxPostEdits: number;
  private timeline: TimelineEntry[] = [];
  private status: AgentStatus = "thinking";
  private currentMessageId = "";
  private currentChatId = "";
  private currentThreadId: string | null = null;

  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /** Consecutive tool calls are grouped into editable post bubbles, mirroring Hermes Agent. */
  private readonly toolEntries = new Map<string, ToolEntryState>();
  private readonly toolGroups: ToolGroupState[] = [];
  private currentToolGroup: ToolGroupState | null = null;
  /** Tool metadata captured at permission boundaries; used to restore sparse updates. */
  private readonly sealedToolMeta = new Map<string, SealedToolMeta>();

  private cardId: string | null = null;
  private cardCreating: Promise<string | null> | null = null;
  private mainPostEditCount = 0;
  private mainPostSealedForEdits = false;
  private lastRenderedMainEntries: TimelineEntry[] = [];
  private mainPostCreatingEntries: TimelineEntry[] = [];
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
    this.postFlushDebounceMs = opts.postFlushDebounceMs ?? DEFAULT_POST_FLUSH_DEBOUNCE_MS;
    this.maxPostEdits = opts.maxPostEdits ?? DEFAULT_MAX_POST_EDITS;
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
    await this.finishCurrentMessageSegment();
    const toolCallId = params.toolCall?.toolCallId;
    if (toolCallId) {
      this.sealedToolMeta.set(toolCallId, {
        title: params.toolCall?.title ?? "unknown",
        kind: params.toolCall?.kind ?? "tool",
      });
    }
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

  private async finishCurrentMessageSegment(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));

    if (!this.hasMainRenderableState()) return;

    this.status = "complete";
    await this.renderCard({ cancellable: false });
    this.sealCurrentToolGroup();

    this.resetMainPostState();
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
        await this.finishCurrentMessageSegment();
        this.status = "calling_tool";
        await this.upsertTool(
          toolCallId,
          u.title ?? "unknown",
          u.kind ?? "tool",
          (u.status ?? "in_progress") as ToolStatus,
        );
        return;
      }

      case "tool_call_update": {
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;

        const status = this.resolveToolUpdateStatus(toolCallId, u);
        if (this.status !== "responding") this.status = "calling_tool";
        await this.upsertTool(toolCallId, u.title ?? "unknown", u.kind ?? "tool", status);
        return;
      }
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
   * Finalise the current message post with the given terminal status, then
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
    const hasRenderableState =
      this.timeline.length > 0 || this.cardId !== null || this.cardCreating !== null;
    const shouldSkipEmptyFinalCard =
      !hasRenderableState && (this.permissionBoundaryThisPrompt || this.toolEntries.size > 0);
    if (!shouldSkipEmptyFinalCard) await this.renderCard({ cancellable: false });
    await this.finalizeOutstandingToolCards(status);
    this.resetMainPostState();
    this.resetToolGroups();
    this.sealedToolMeta.clear();
    this.permissionBoundaryThisPrompt = false;
    this.status = "thinking";
  }

  // ----- Timeline mutators ------------------------------------------------

  private appendText(kind: "text" | "thought", text: string): void {
    if (!text) return;
    this.startFreshMainPostIfSealed();
    const last = this.timeline.at(-1);
    if (last && last.kind === kind) {
      last.text += text;
      return;
    }
    this.timeline.push({ kind, text });
  }

  private resolveToolUpdateStatus(toolCallId: string, update: acp.ToolCallUpdate): ToolStatus {
    if (update.status !== undefined && update.status !== null) return update.status as ToolStatus;
    if (hasToolUpdateResult(update)) return "completed";
    return this.toolEntries.get(toolCallId)?.entry.status ?? "in_progress";
  }

  private async finalizeOutstandingToolCards(promptStatus: AgentStatus): Promise<void> {
    const terminalStatus: ToolStatus = promptStatus === "complete" ? "completed" : "failed";
    const touchedGroups = new Set<ToolGroupState>();
    for (const tool of this.toolEntries.values()) {
      if (tool.entry.status === "completed" || tool.entry.status === "failed") continue;
      tool.entry.status = terminalStatus;
      touchedGroups.add(tool.group);
    }
    for (const group of touchedGroups) {
      await this.renderToolGroup(group);
    }
  }

  private async upsertTool(
    toolCallId: string,
    title: string,
    toolKind: string,
    status: ToolStatus,
  ): Promise<void> {
    const existing = this.toolEntries.get(toolCallId);
    if (existing !== undefined) {
      if (title !== "unknown") existing.entry.title = title;
      if (toolKind !== "tool") existing.entry.toolKind = toolKind;
      existing.entry.status = status;
      await this.renderToolGroup(existing.group);
      return;
    }

    const meta = this.sealedToolMeta.get(toolCallId);
    if (meta !== undefined) this.sealedToolMeta.delete(toolCallId);
    const resolvedTitle = title !== "unknown" ? title : (meta?.title ?? title);
    const resolvedKind = toolKind !== "tool" ? toolKind : (meta?.kind ?? toolKind);
    const group = this.ensureToolGroup();
    const entry: ToolEntry = {
      kind: "tool",
      toolCallId,
      title: resolvedTitle,
      toolKind: resolvedKind,
      status,
    };
    group.entries.push(entry);
    this.toolEntries.set(toolCallId, { group, entry });
    await this.renderToolGroup(group);
  }

  private ensureToolGroup(): ToolGroupState {
    if (this.currentToolGroup) return this.currentToolGroup;
    const group: ToolGroupState = {
      cardId: null,
      cardCreating: null,
      editCount: 0,
      entries: [],
    };
    this.toolGroups.push(group);
    this.currentToolGroup = group;
    return group;
  }

  private sealCurrentToolGroup(): void {
    this.currentToolGroup = null;
  }

  private resetToolGroups(): void {
    this.toolEntries.clear();
    this.toolGroups.length = 0;
    this.currentToolGroup = null;
  }

  private async renderToolGroup(group: ToolGroupState): Promise<void> {
    if (!this.currentMessageId) return;

    const state: UnifiedCardState = {
      status: this.toolGroupStatus(group),
      entries: cloneEntries(group.entries),
      cancellable: false,
      chatId: this.currentChatId,
      threadId: this.currentThreadId,
    };

    if (group.cardId) {
      if (group.editCount >= this.maxPostEdits) {
        await this.recreateToolGroupPost(group, state);
        return;
      }
      try {
        await this.presenter.updateUnifiedCard(group.cardId, state);
        group.editCount += 1;
      } catch (err) {
        this.logger.warn({ err }, "tool group post update failed; sending fresh post");
        await this.recreateToolGroupPost(group, state);
      }
      return;
    }
    if (group.cardCreating) {
      const id = await group.cardCreating;
      if (id) {
        group.cardId = id;
        await this.updateToolGroupPostOrRecreate(group, id, state);
      }
      return;
    }

    const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
    group.cardCreating = promise;
    try {
      const id = await promise;
      if (id) {
        group.cardId = id;
        group.editCount = 0;
      }
    } finally {
      group.cardCreating = null;
    }
  }

  private toolGroupStatus(group: ToolGroupState): AgentStatus {
    if (group.entries.some((entry) => entry.status === "failed")) return "failed";
    if (group.entries.every((entry) => entry.status === "completed")) return "complete";
    return "calling_tool";
  }

  private async updateToolGroupPostOrRecreate(
    group: ToolGroupState,
    postId: string,
    state: UnifiedCardState,
  ): Promise<void> {
    try {
      await this.presenter.updateUnifiedCard(postId, state);
      group.cardId = postId;
      group.editCount += 1;
    } catch (err) {
      this.logger.warn(
        { err },
        "tool group post update failed during creation; sending fresh post",
      );
      await this.recreateToolGroupPost(group, state);
    }
  }

  private async recreateToolGroupPost(
    group: ToolGroupState,
    state: UnifiedCardState,
  ): Promise<void> {
    group.cardId = null;
    group.cardCreating = null;
    group.editCount = 0;
    const id = await this.presenter.sendUnifiedCard(this.currentMessageId, state);
    if (id) group.cardId = id;
  }

  private resetMainPostState(): void {
    this.timeline = [];
    this.cardId = null;
    this.cardCreating = null;
    this.mainPostEditCount = 0;
    this.mainPostSealedForEdits = false;
    this.lastRenderedMainEntries = [];
    this.mainPostCreatingEntries = [];
  }

  private startFreshMainPostIfSealed(): void {
    if (!this.mainPostSealedForEdits) return;
    this.resetMainPostState();
  }

  private markMainPostSent(state: UnifiedCardState): void {
    this.mainPostEditCount = 0;
    this.mainPostSealedForEdits = false;
    this.lastRenderedMainEntries = cloneEntries(state.entries);
    this.mainPostCreatingEntries = [];
  }

  private markMainPostEdited(state: UnifiedCardState): void {
    this.mainPostEditCount += 1;
    this.mainPostSealedForEdits = this.mainPostEditCount >= this.maxPostEdits;
    this.lastRenderedMainEntries = cloneEntries(state.entries);
  }

  private async updateMainPostOrRecreate(postId: string, state: UnifiedCardState): Promise<void> {
    if (this.lastRenderedMainEntries.length === 0 && this.mainPostCreatingEntries.length > 0) {
      this.lastRenderedMainEntries = cloneEntries(this.mainPostCreatingEntries);
    }
    try {
      await this.presenter.updateUnifiedCard(postId, state);
      this.cardId = postId;
      this.markMainPostEdited(state);
    } catch (err) {
      this.logger.warn(
        { err },
        "main post update failed during creation; sending continuation post",
      );
      await this.recreateMainPostWithContinuation(state);
    }
  }

  private async recreateMainPostWithContinuation(state: UnifiedCardState): Promise<void> {
    const continuation = timelineContinuation(this.lastRenderedMainEntries, state.entries);
    if (continuation.length === 0) {
      this.mainPostSealedForEdits = true;
      return;
    }

    const continuationState: UnifiedCardState = {
      ...state,
      entries: continuation,
    };

    this.timeline = cloneEntries(continuation);
    this.cardId = null;
    this.cardCreating = null;
    this.mainPostEditCount = 0;
    this.mainPostSealedForEdits = false;
    this.lastRenderedMainEntries = [];
    this.mainPostCreatingEntries = [];

    const id = await this.presenter.sendUnifiedCard(this.currentMessageId, continuationState);
    if (id) {
      this.cardId = id;
      this.markMainPostSent(continuationState);
    }
  }

  private hasMainRenderableState(): boolean {
    return this.timeline.length > 0 || this.cardId !== null || this.cardCreating !== null;
  }

  // ----- Post flush -------------------------------------------------------

  private scheduleFlush(): void {
    if (!this.currentMessageId) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.renderCard({ cancellable: true }).catch((err) =>
        this.logger.warn({ err }, "card flush failed"),
      );
    }, this.postFlushDebounceMs);
  }

  private async renderCard(opts: { cancellable: boolean }): Promise<void> {
    if (!this.currentMessageId && !this.cardId) return;
    this.flushing = true;
    try {
      const state: UnifiedCardState = {
        status: this.status,
        entries: cloneEntries(this.timeline),
        cancellable: opts.cancellable && this.showCancelButton,
        chatId: this.currentChatId,
        threadId: this.currentThreadId,
      };

      if (this.cardId) {
        if (
          this.mainPostSealedForEdits &&
          sameRenderableEntries(this.lastRenderedMainEntries, state.entries)
        ) {
          return;
        }
        if (this.mainPostEditCount >= this.maxPostEdits) {
          await this.recreateMainPostWithContinuation(state);
          return;
        }
        try {
          await this.presenter.updateUnifiedCard(this.cardId, state);
          this.markMainPostEdited(state);
        } catch (err) {
          this.logger.warn({ err }, "main post update failed; sending continuation post");
          await this.recreateMainPostWithContinuation(state);
        }
        return;
      }
      if (this.cardCreating) {
        const id = await this.cardCreating;
        if (id) {
          await this.updateMainPostOrRecreate(id, state);
        }
        return;
      }
      const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
      this.cardCreating = promise;
      this.mainPostCreatingEntries = cloneEntries(state.entries);
      try {
        const id = await promise;
        if (id) {
          this.cardId = id;
          this.markMainPostSent(state);
        }
      } finally {
        this.cardCreating = null;
      }
    } finally {
      this.flushing = false;
    }
  }
}
