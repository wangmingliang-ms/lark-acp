import type {
  CardRoute,
  ConversationCardView,
  PermissionToken,
  PromptToken,
} from "./conversation-card-view.js";

/** Status chip rendered in the unified card header. */
export type AgentStatus =
  | "received"
  | "queued"
  | "interrupting"
  | "preparing"
  | "thinking"
  | "processing"
  | "waiting_user"
  | "calling_tool"
  | "responding"
  | "sealed"
  | "complete"
  | "cancelled"
  | "failed";

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

/** Semantic permission request rendered by the v2 card presenter. */
export interface PermissionCardView {
  readonly route: CardRoute;
  readonly promptToken: PromptToken;
  readonly permissionToken: PermissionToken;
  readonly requestId: string;
  readonly title: string;
  readonly toolKind: string;
  readonly toolTitle: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind?: string;
  }[];
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
  /** Semantic conversation-card send path. */
  sendConversationCard(
    replyToMessageId: string,
    view: ConversationCardView,
  ): Promise<string | null>;

  /** Semantic conversation-card patch path. */
  updateConversationCard(cardMessageId: string, view: ConversationCardView): Promise<boolean>;

  /** Semantic permission-card send path. */
  sendPermissionRequestCard(
    replyToMessageId: string,
    view: PermissionCardView,
  ): Promise<string | null>;

  /**
   * Reply to `messageId` with plain-ish text (rendered as a Lark `post`
   * rich-text message). Used for system notices — agent output is
   * rendered into the unified card instead.
   *
   * @throws when the underlying transport rejects.
   */
  replyText(messageId: string, text: string): Promise<void>;

  /**
   * Reply to `messageId` with a standalone image message. Uploads `bytes` to
   * Feishu and sends the resulting `image_key`. Returns `true` on success,
   * `false` when upload or send fails (the caller degrades to a text
   * placeholder). Never throws.
   */
  replyImage(messageId: string, bytes: Buffer): Promise<boolean>;

  /** Replace a permission card with a "no longer actionable" notice. */
  expirePermissionCard(messageId: string, reason: string): Promise<void>;

  /**
   * Reply to `replyToMessageId` with a single-card notice — used for
   * lightweight system acknowledgements. This path is intentionally compact; use
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
}
