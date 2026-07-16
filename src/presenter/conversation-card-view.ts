import type { SessionCardMeta } from "./presenter.js";

declare const promptTokenBrand: unique symbol;
declare const segmentTokenBrand: unique symbol;
declare const actionTokenBrand: unique symbol;
declare const permissionTokenBrand: unique symbol;
declare const ownershipTokenBrand: unique symbol;

export type PromptToken = string & { readonly [promptTokenBrand]: true };
export type SegmentToken = string & { readonly [segmentTokenBrand]: true };
export type ActionToken = string & { readonly [actionTokenBrand]: true };
export type PermissionToken = string & { readonly [permissionTokenBrand]: true };
export type OwnershipToken = string & { readonly [ownershipTokenBrand]: true };

export interface CardRoute {
  readonly c: string;
  readonly th?: string;
}

export interface CancelAction {
  readonly p: PromptToken;
  readonly s: SegmentToken;
  readonly a: ActionToken;
}

export interface CancelActionPayloadV2 {
  readonly v: 2;
  readonly cancel: true;
  readonly c: string;
  readonly th?: string;
  readonly p: string;
  readonly s: string;
  readonly a: string;
}

export type ToolStatus =
  "pending" | "in_progress" | "continued" | "completed" | "failed" | "interrupted";

export type ConversationTimelineEntry =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind: string;
      readonly status: ToolStatus;
      readonly detail?: string;
    };

export type ActiveTimelineEntry = ConversationTimelineEntry;
export type ArchivedTimelineEntry =
  | Extract<ConversationTimelineEntry, { readonly kind: "text" | "thought" }>
  | (Omit<Extract<ConversationTimelineEntry, { readonly kind: "tool" }>, "status"> & {
      readonly status: Exclude<ToolStatus, "pending" | "in_progress">;
    });
export type TerminalTimelineEntry = ArchivedTimelineEntry;

export type QueueHeader = "queued" | "interrupting";
export type StartingHeader = "preparing";
export type ActiveHeader =
  /** Agent busy, no displayable content yet — "⚙️ 处理中". */
  | "processing"
  /** Real thought content is streaming — "💭 思考中". */
  | "thinking"
  | "calling_tool"
  | "responding"
  /** Waiting on the user to resolve a permission request — "🙋 待确认". */
  | "waiting_user";
export type OrphanHeader = "orphaned";
export type TerminalHeader =
  | "complete"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "merged"
  /** @deprecated compatibility only; new domain code must use interrupted/failed. */
  | "superseded"
  /** @deprecated compatibility only; new domain code must use interrupted/failed. */
  | "abandoned";

export type ConversationCardView =
  | {
      readonly kind: "queued";
      readonly header: "queued";
      readonly entries: readonly ConversationTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly route: CardRoute;
    }
  | {
      readonly kind: "interrupting";
      readonly header: "interrupting";
      readonly entries: readonly ConversationTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly route: CardRoute;
    }
  | {
      readonly kind: "starting";
      readonly header: StartingHeader;
      readonly entries: readonly [];
      readonly profile: SessionCardMeta | null;
      readonly route: CardRoute;
    }
  | {
      readonly kind: "orphaned";
      readonly header: OrphanHeader;
      readonly entries: readonly ConversationTimelineEntry[];
      readonly reason: "superseded_send" | "stale_handoff";
      readonly route: CardRoute;
    }
  | {
      readonly kind: "active";
      readonly header: ActiveHeader;
      readonly activityTitle?: string;
      readonly entries: readonly ActiveTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly cancelAction?: CancelAction;
      readonly route: CardRoute;
    }
  | {
      readonly kind: "archived";
      readonly entries: readonly [ArchivedTimelineEntry, ...ArchivedTimelineEntry[]];
      readonly summary: string;
      readonly route: CardRoute;
    }
  | {
      readonly kind: "terminal";
      readonly header: TerminalHeader;
      readonly entries: readonly TerminalTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly body: "content" | "empty_complete";
      readonly route: CardRoute;
    }
  | {
      /**
       * A neutral post-turn Supplement Card. It never shows a
       * processing/ended status, profile footer, Cancel, permission, or any
       * other execution authority — only a fixed "补充更新" label and content.
       */
      readonly kind: "supplement";
      readonly entries: readonly ConversationTimelineEntry[];
      readonly route: CardRoute;
    };

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function freezeRecursively<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;

  for (const nested of Object.values(value)) freezeRecursively(nested);
  return Object.freeze(value);
}

export function cloneCardView<T extends ConversationCardView>(view: T): DeepReadonly<T> {
  const snapshot = structuredClone(view);
  return (
    process.env.NODE_ENV === "production" ? snapshot : freezeRecursively(snapshot)
  ) as DeepReadonly<T>;
}
