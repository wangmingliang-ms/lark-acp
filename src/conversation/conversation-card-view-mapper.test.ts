import { describe, expect, it } from "vitest";
import {
  ResponseCardProjector,
  TopicConversation,
  type ActionToken,
  type RequestId,
  type ResponseCardId,
  type ResponseId,
  type ResponseToken,
  type TurnId,
} from "./topic-conversation.js";
import { ConversationCardViewMapper } from "./conversation-card-view-mapper.js";

const turnId = "turn" as TurnId;
const requestId = "request" as RequestId;
const responseId = "response" as ResponseId;
const responseToken = "response-token" as ResponseToken;
const card1 = "card-1" as ResponseCardId;
const card2 = "card-2" as ResponseCardId;
const action1 = "action-1" as ActionToken;
const action2 = "action-2" as ActionToken;
const route = { c: "chat", th: "thread" };
const profile = { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" };

function topic(): TopicConversation {
  const conversation = new TopicConversation();
  conversation.accept({
    turnId,
    request: { id: requestId, sourceMessageId: "message", content: "hello" },
    responseId,
    responseToken,
    initialCardId: card1,
    profile,
  });
  return conversation;
}

function view(conversation: TopicConversation, cardId: ResponseCardId) {
  const snapshot = conversation.snapshot();
  const projection = new ResponseCardProjector().project(snapshot, responseId, cardId);
  return new ConversationCardViewMapper().toView(snapshot, projection, route);
}

describe("ConversationCardViewMapper", () => {
  it("maps received and interrupting tails with Metadata and no Cancel", () => {
    const conversation = topic();

    expect(view(conversation, card1)).toEqual({
      kind: "queued",
      header: "queued",
      entries: [],
      profile,
      route,
    });
  });

  it("maps only active owner tail with tokenized Cancel", () => {
    const conversation = topic();
    conversation.prepare(responseId);
    conversation.activate(responseId, action1);

    expect(view(conversation, card1)).toMatchObject({
      kind: "active",
      header: "thinking",
      profile,
      cancelAction: { p: responseToken, s: card1, a: action1 },
    });
  });

  it("uses only the explicit current Tool activity after rotation and completion", () => {
    const conversation = topic();
    conversation.prepare(responseId);
    conversation.activate(responseId, action1);
    conversation.append(responseId, {
      kind: "tool",
      toolCallId: "tool-1",
      title: "Execute",
      status: "in_progress",
    });
    conversation.startToolActivity(responseId, "tool-1", "Execute");
    conversation.rotateTail(responseId, card2, "content_rotation", action2);

    expect(view(conversation, card2)).toMatchObject({
      kind: "active",
      header: "calling_tool",
      activityTitle: "Execute",
      entries: [],
    });

    conversation.finishToolActivity(responseId, "tool-1");

    expect(view(conversation, card2)).toMatchObject({
      kind: "active",
      header: "thinking",
      entries: [],
    });
    expect(view(conversation, card2)).not.toHaveProperty("activityTitle");
  });

  it("maps rotated history without title, metadata, or action", () => {
    const conversation = topic();
    conversation.prepare(responseId);
    conversation.activate(responseId, action1);
    conversation.append(responseId, { kind: "text", text: "history" });
    conversation.rotateTail(responseId, card2, "content_rotation", action2);

    expect(view(conversation, card1)).toEqual({
      kind: "archived",
      entries: [{ kind: "text", text: "history" }],
      summary: "history",
      route,
    });
  });

  it.each(["complete", "cancelled", "failed", "interrupted"] as const)(
    "gives an empty %s terminal tail truthful content",
    (outcome) => {
      const conversation = topic();
      conversation.prepare(responseId);
      conversation.activate(responseId, action1);
      conversation.seal(responseId, outcome);
      const mapped = view(conversation, card1);
      expect(mapped).toMatchObject({ kind: "terminal", header: outcome, body: "content" });
      if (mapped.kind !== "terminal") throw new Error("expected terminal view");
      expect(mapped.entries).toHaveLength(1);
    },
  );

  it("keeps terminal tail title and metadata without Cancel", () => {
    const conversation = topic();
    conversation.prepare(responseId);
    conversation.activate(responseId, action1);
    conversation.append(responseId, { kind: "text", text: "done" });
    conversation.seal(responseId, "interrupted");

    expect(view(conversation, card1)).toEqual({
      kind: "terminal",
      header: "interrupted",
      entries: [{ kind: "text", text: "done" }],
      profile,
      body: "content",
      route,
    });
  });
});
