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

function toolUpdateDetail(content: acp.ToolCallUpdate["content"] | undefined): string | undefined {
  if (!content) return undefined;

  const chunks: string[] = [];
  for (const c of content) {
    if (c.type !== "diff") continue;
    const diff = c as acp.Diff;
    const lines: string[] = [`--- ${diff.path}`];
    diff.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
    diff.newText?.split("\n").forEach((l) => lines.push(`+ ${l}`));
    chunks.push("```diff\n" + lines.join("\n") + "\n```");
  }

  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

interface SealedToolMeta {
  readonly title: string;
  readonly kind: string;
}

type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;

interface ToolCardState {
  cardId: string | null;
  cardCreating: Promise<string | null> | null;
  entry: ToolEntry;
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
  /** Render `tool_call` / `tool_call_update` events as standalone tool cards. */
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
 * `acp.Client` implementation for one Lark chat. Builds a unified
 * timeline cards for assistant text/thoughts, split whenever a tool call
 * interrupts the assistant message. Each tool call gets its own standalone
 * card so large tool outputs do not bloat any message card.
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
  private timeline: TimelineEntry[] = [];
  private status: AgentStatus = "thinking";
  private currentMessageId = "";
  private currentChatId = "";
  private currentThreadId: string | null = null;

  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /** Tool-call id → its standalone card state. */
  private readonly toolCards = new Map<string, ToolCardState>();
  /** Tool metadata captured at permission boundaries; used to restore sparse updates in standalone tool cards. */
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
        await this.finishCurrentMessageSegment();
        const rawInput = u.rawInput;
        const detail = typeof rawInput === "string" ? rawInput : undefined;
        this.status = "calling_tool";
        await this.upsertTool(
          toolCallId,
          u.title ?? "unknown",
          u.kind ?? "tool",
          (u.status ?? "in_progress") as ToolStatus,
          detail,
        );
        return;
      }

      case "tool_call_update": {
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
        if (u.status !== "completed" && u.status !== "failed") return;

        const detail = toolUpdateDetail(u.content);
        if (this.status !== "responding") this.status = "calling_tool";
        await this.upsertTool(
          toolCallId,
          u.title ?? "unknown",
          u.kind ?? "tool",
          u.status as ToolStatus,
          detail,
        );
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
   * Finalise the current message card with the given terminal status, then
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
      !hasRenderableState && (this.permissionBoundaryThisPrompt || this.toolCards.size > 0);
    if (!shouldSkipEmptyFinalCard) await this.renderCard({ cancellable: false });
    this.timeline = [];
    this.toolCards.clear();
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

  private async upsertTool(
    toolCallId: string,
    title: string,
    toolKind: string,
    status: ToolStatus,
    detail?: string,
  ): Promise<void> {
    const existing = this.toolCards.get(toolCallId);
    if (existing !== undefined) {
      if (title !== "unknown") existing.entry.title = title;
      if (toolKind !== "tool") existing.entry.toolKind = toolKind;
      existing.entry.status = status;
      if (detail !== undefined) {
        existing.entry.detail = existing.entry.detail
          ? `${existing.entry.detail}\n\n${detail}`
          : detail;
      }
      await this.renderToolCard(toolCallId);
      return;
    }

    const meta = this.sealedToolMeta.get(toolCallId);
    if (meta !== undefined) this.sealedToolMeta.delete(toolCallId);
    const resolvedTitle = title !== "unknown" ? title : (meta?.title ?? title);
    const resolvedKind = toolKind !== "tool" ? toolKind : (meta?.kind ?? toolKind);
    this.toolCards.set(toolCallId, {
      cardId: null,
      cardCreating: null,
      entry: {
        kind: "tool",
        toolCallId,
        title: resolvedTitle,
        toolKind: resolvedKind,
        status,
        ...(detail !== undefined ? { detail } : {}),
      },
    });
    await this.renderToolCard(toolCallId);
  }

  private async renderToolCard(toolCallId: string): Promise<void> {
    if (!this.currentMessageId) return;
    const tool = this.toolCards.get(toolCallId);
    if (!tool) return;

    const state: UnifiedCardState = {
      status: toolStatusToAgentStatus(tool.entry.status),
      entries: [tool.entry],
      cancellable: false,
      chatId: this.currentChatId,
      threadId: this.currentThreadId,
    };

    if (tool.cardId) {
      await this.presenter.updateUnifiedCard(tool.cardId, state);
      return;
    }
    if (tool.cardCreating) {
      const id = await tool.cardCreating;
      if (id) {
        tool.cardId = id;
        await this.presenter.updateUnifiedCard(id, state);
      }
      return;
    }

    const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
    tool.cardCreating = promise;
    try {
      const id = await promise;
      if (id) tool.cardId = id;
    } finally {
      tool.cardCreating = null;
    }
  }

  private hasMainRenderableState(): boolean {
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
      const state: UnifiedCardState = {
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
