import type * as acp from "@agentclientprotocol/sdk";

/** Status chip rendered in the unified card header. */
export type AgentStatus =
  | "received"
  | "queued"
  | "interrupting"
  | "preparing"
  | "thinking"
  | "waiting"
  | "calling_tool"
  | "responding"
  | "sealed"
  | "complete"
  | "cancelled"
  | "failed";

/** Tool execution status — mirrors ACP's `tool_call` lifecycle. */
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * One entry in the unified card timeline. Entries appear in agent-emit
 * order; consecutive text / thought entries are coalesced upstream.
 */
export type TimelineEntry =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "thought"; text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      title: string;
      toolKind: string;
      status: ToolStatus;
      detail?: string;
    };

/**
 * Lark interactive card header colour palette. Matches the templates the
 * Lark Open Platform exposes for the `header.template` field.
 */
export type NoticeTemplate = "blue" | "wathet" | "green" | "grey" | "red" | "orange";

/** A short, single-card notice (e.g. lifecycle or control acknowledgement). */
export interface NoticeCardSpec {
  readonly title: string;
  readonly body: string;
  readonly template: NoticeTemplate;
}

/** A slash-command execution result. Uses the same readable body budget as message cards. */
export interface CommandResultCardSpec {
  readonly title: string;
  readonly body: string;
  readonly template: NoticeTemplate;
}

/** Destructive Agent switch warning with confirmation buttons. */
export interface AgentSwitchWarningCardSpec {
  readonly switchId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly repo: string;
  readonly body: string;
}

/** Terminal state rendered back onto an Agent switch warning card. */
export interface AgentSwitchWarningResolution {
  readonly status: "confirmed" | "cancelled" | "expired" | "failed";
  readonly text: string;
}

/** Compact session-control metadata shown at the bottom of a conversation card. */
export interface SessionCardMeta {
  readonly agent: string;
  readonly mode: string;
  readonly model: string;
  readonly permission: string;
}

/** Snapshot the presenter renders into a single Lark interactive card. */
export interface UnifiedCardState {
  status: AgentStatus;
  entries: readonly TimelineEntry[];
  /** Current ACP / bridge control state. Rendered as compact footer text. */
  meta?: SessionCardMeta;
  /** Show the bottom "cancel" button. Typically true while the agent is
   *  still working. */
  cancellable: boolean;
  /** Chat id — embedded in the cancel button's action payload so the
   *  bridge can route the click back to the right runtime. */
  chatId: string;
  /** Feishu topic (话题) id, or `null` for the chat's "main" conversation.
   *  Embedded alongside {@link chatId} so a cancel click routes to the
   *  right per-thread runtime. */
  threadId: string | null;
}

/**
 * Surface the bridge uses to render itself to the user — every visible
 * artefact (replies, reactions, permission cards, unified timeline card)
 * goes through this interface.
 *
 * Default implementation is {@link LarkCardPresenter}. Replace for
 * testing, plain-text mode, or other chat platforms.
 */
export interface LarkPresenter {
  /**
   * Reply to `messageId` with plain-ish text (rendered as a Lark `post`
   * rich-text message). Used for system notices — agent output is
   * rendered into the unified card instead.
   *
   * @throws when the underlying transport rejects.
   */
  replyText(messageId: string, text: string): Promise<void>;

  /**
   * Render an ACP permission request as an interactive card.
   *
   * Returns the new card's id so callers can later patch it. Returns
   * `null` if the transport did not surface one.
   *
   * @throws when the underlying transport rejects.
   */
  sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<string | null>;

  /**
   * Replace an existing empty status/progress card with an ACP permission request.
   * Used when a silence-triggered status card is waiting to be reused by the
   * next visible event.
   */
  updateInterruptCard(
    cardMessageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<boolean>;

  /** Replace a permission card with a "resolved" confirmation. */
  updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
    selectedKind?: string,
  ): Promise<void>;

  /** Replace a permission card with a "no longer actionable" notice. */
  expirePermissionCard(messageId: string, reason: string): Promise<void>;

  /**
   * Reply to `replyToMessageId` with a single-card notice — used for
   * lightweight system acknowledgements where {@link UnifiedCardState} would
   * be overkill. This path is intentionally compact; use
   * {@link replyCommandResultCard} for slash-command listing/query output.
   */
  replyNoticeCard(replyToMessageId: string, notice: NoticeCardSpec): Promise<string | null>;

  /** Patch an existing notice card. Returns false when the transport rejects. */
  updateNoticeCard?(messageId: string, notice: NoticeCardSpec): Promise<boolean>;

  /**
   * Reply to `replyToMessageId` with a slash-command execution result. The body
   * budget tracks message-card readability limits rather than notice/toast limits.
   */
  replyCommandResultCard(replyToMessageId: string, result: CommandResultCardSpec): Promise<void>;

  /**
   * Reply with a destructive Agent-switch warning that requires explicit user
   * confirmation. Optional so non-Lark test/dummy presenters can omit the
   * interactive path; the bridge falls back to a plain notice if absent.
   */
  replyAgentSwitchWarningCard?(
    replyToMessageId: string,
    warning: AgentSwitchWarningCardSpec,
  ): Promise<string | null>;

  /** Patch an Agent-switch warning after confirm/cancel/expiry. */
  updateAgentSwitchWarningCard?(
    cardMessageId: string,
    resolution: AgentSwitchWarningResolution,
  ): Promise<void>;

  /**
   * Send a fresh single-card notice directly into a chat, without replying to
   * a specific message. Used for background state changes such as settings
   * hot-reload detecting that a chat binding was changed by an agent.
   */
  sendNoticeCard(chatId: string, notice: NoticeCardSpec): Promise<string | null>;

  /**
   * Send the per-prompt unified card. Returns the card's message id so
   * the caller can patch it as the timeline grows.
   */
  sendUnifiedCard(replyToMessageId: string, state: UnifiedCardState): Promise<string | null>;

  /** Patch an existing unified card with a new state. Returns false when the transport rejects. */
  updateUnifiedCard(cardMessageId: string, state: UnifiedCardState): Promise<boolean>;
}
