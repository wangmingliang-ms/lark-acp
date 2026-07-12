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
