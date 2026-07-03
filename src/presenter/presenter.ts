import type * as acp from "@agentclientprotocol/sdk";

/** Status chip rendered in the unified card header. */
export type AgentStatus =
  | "thinking"
  | "calling_tool"
  | "responding"
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

/** A short, single-card notice (e.g. command acknowledgement). */
export interface NoticeCardSpec {
  readonly title: string;
  readonly body: string;
  readonly template: NoticeTemplate;
}

/** Snapshot the presenter renders into a single Lark interactive card. */
export interface UnifiedCardState {
  status: AgentStatus;
  entries: readonly TimelineEntry[];
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

  /** Add a "typing" indicator. Returns an opaque id (or null on failure). */
  addReaction(messageId: string, emoji?: string): Promise<string | null>;

  /** Remove a previously-added reaction. Best-effort. */
  removeReaction(messageId: string, reactionId: string): Promise<void>;

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

  /** Replace a permission card with a "resolved" confirmation. */
  updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
  ): Promise<void>;

  /** Replace a permission card with a "no longer actionable" notice. */
  expirePermissionCard(messageId: string, reason: string): Promise<void>;

  /**
   * Reply to `replyToMessageId` with a single-card notice — used for
   * lightweight system acknowledgements (e.g. confirming a chat command
   * was accepted) where {@link UnifiedCardState} would be overkill.
   */
  replyNoticeCard(replyToMessageId: string, notice: NoticeCardSpec): Promise<void>;

  /**
   * Send the per-prompt unified card. Returns the card's message id so
   * the caller can patch it as the timeline grows.
   */
  sendUnifiedCard(replyToMessageId: string, state: UnifiedCardState): Promise<string | null>;

  /** Patch an existing unified card with a new state. */
  updateUnifiedCard(cardMessageId: string, state: UnifiedCardState): Promise<void>;
}
