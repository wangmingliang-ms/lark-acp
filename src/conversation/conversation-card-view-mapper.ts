import type {
  ActionToken,
  CardProjection,
  ResponseCardId,
  ResponseId,
  ResponseSnapshot,
  ResponseState,
  TimelineEntry,
  TopicConversationSnapshot,
} from "./topic-conversation.js";
import type {
  ActiveHeader,
  ArchivedTimelineEntry,
  CardRoute,
  ConversationCardView,
  ConversationTimelineEntry,
  PromptToken,
  SegmentToken,
  TerminalHeader,
  TerminalTimelineEntry,
  ToolStatus,
} from "../presenter/conversation-card-view.js";

function response(topic: TopicConversationSnapshot, responseId: ResponseId): ResponseSnapshot {
  const found = topic.turns.find((turn) => turn.response.id === responseId)?.response;
  if (found === undefined) throw new Error(`unknown response: ${responseId}`);
  return found;
}

function header(
  state: ResponseState,
): "queued" | "interrupting" | "preparing" | ActiveHeader | TerminalHeader {
  if (state.kind === "terminal") return state.outcome as TerminalHeader;
  switch (state.phase) {
    case "received":
      return "queued";
    case "interrupting":
      return "interrupting";
    case "preparing":
      return "preparing";
    case "active":
    case "awaiting_permission":
      return (state.phase === "awaiting_permission" ? "waiting" : state.activity) as ActiveHeader;
  }
}

function toolStatus(status: Extract<TimelineEntry, { kind: "tool" }>["status"]): ToolStatus {
  return status;
}

function entries(items: readonly TimelineEntry[]): ConversationTimelineEntry[] {
  return items.map((entry) => {
    switch (entry.kind) {
      case "text":
      case "thought":
        return entry;
      case "notice":
        return { kind: "text", text: entry.text };
      case "tool":
        return {
          kind: "tool",
          toolCallId: entry.toolCallId,
          title: entry.title,
          toolKind: "tool",
          status: toolStatus(entry.status),
        };
    }
  });
}

function summary(items: readonly ConversationTimelineEntry[]): string {
  const visible = items.find((entry) => entry.kind === "text" || entry.kind === "thought");
  if (visible?.kind === "text" || visible?.kind === "thought") return visible.text;
  const tool = items.find((entry) => entry.kind === "tool");
  return tool?.kind === "tool" ? tool.title : "";
}

export class ConversationCardViewMapper {
  toView(
    topic: TopicConversationSnapshot,
    projection: CardProjection,
    route: CardRoute,
  ): ConversationCardView {
    const aggregateResponse = response(topic, projection.responseId);
    const timeline = entries(projection.entries);
    if (projection.kind === "intermediate") {
      const normalized =
        timeline.length === 0
          ? [{ kind: "text" as const, text: "_本段 Response 已由下一张 Card 接续。_" }]
          : timeline;
      return {
        kind: "archived",
        entries: normalized as [ArchivedTimelineEntry, ...ArchivedTimelineEntry[]],
        summary: summary(normalized),
        route,
      };
    }

    const state = projection.state;
    if (state.kind === "terminal") {
      const body =
        timeline.length === 0 && state.outcome === "complete" ? "empty_complete" : "content";
      return {
        kind: "terminal",
        header: state.outcome,
        entries: timeline as TerminalTimelineEntry[],
        profile: projection.metadata,
        body,
        route,
      };
    }

    switch (state.phase) {
      case "received":
        return {
          kind: "queued",
          header: "queued",
          entries: timeline,
          profile: projection.metadata,
          route,
        };
      case "interrupting":
        return {
          kind: "interrupting",
          header: "interrupting",
          entries: timeline,
          profile: projection.metadata,
          route,
        };
      case "preparing":
        return {
          kind: "starting",
          header: "preparing",
          entries: [],
          profile: projection.metadata,
          route,
        };
      case "active":
      case "awaiting_permission": {
        const cancel = projection.cancelAction;
        return {
          kind: "active",
          header: header(state) as ActiveHeader,
          entries: timeline,
          profile: projection.metadata,
          ...(cancel === null
            ? {}
            : {
                cancelAction: {
                  p: cancel.responseToken as unknown as PromptToken,
                  s: cancel.cardId as unknown as SegmentToken,
                  a: cancel.actionToken as unknown as import("../presenter/conversation-card-view.js").ActionToken,
                },
              }),
          route,
        };
      }
    }
  }
}

export interface ConversationCardDeliveryRequest {
  readonly responseId: ResponseId;
  readonly cardId: ResponseCardId;
  readonly view: ConversationCardView;
}

export type ConversationCardDeliveryOutcome =
  | { readonly outcome: "visible"; readonly cardId: string }
  | { readonly outcome: "patch_failed" }
  | { readonly outcome: "send_failed" };

export interface TopicConversationDeliveryPort {
  render(request: ConversationCardDeliveryRequest): Promise<ConversationCardDeliveryOutcome>;
  revokeAction(responseId: ResponseId, token: ActionToken): void;
}
