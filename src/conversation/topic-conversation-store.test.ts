import { describe, expect, it } from "vitest";
import { TopicConversationStore } from "./topic-conversation-store.js";
import type {
  ActionToken,
  ResponseCardId,
  ResponseId,
  ResponseToken,
  TurnId,
} from "./topic-conversation.js";

function accept(store: TopicConversationStore, content: unknown = { value: 1 }) {
  store.transaction((topic) =>
    topic.accept({
      turnId: "turn" as TurnId,
      request: { id: "request" as never, sourceMessageId: "message", content },
      responseId: "response" as ResponseId,
      responseToken: "response-token" as ResponseToken,
      initialCardId: "card" as ResponseCardId,
      profile: null,
    }),
  );
}

describe("TopicConversationStore", () => {
  it("discards every aggregate mutation when a transaction throws", () => {
    const store = new TopicConversationStore();
    expect(() =>
      store.transaction((topic) => {
        topic.accept({
          turnId: "turn" as TurnId,
          request: { id: "request" as never, sourceMessageId: "message", content: "x" },
          responseId: "response" as ResponseId,
          responseToken: "response-token" as ResponseToken,
          initialCardId: "card" as ResponseCardId,
          profile: null,
        });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.snapshot.turns).toHaveLength(0);
    expect(store.revision).toBe(0);

    accept(store);
    expect(store.snapshot.turns).toHaveLength(1);
  });

  it("deeply isolates request content from caller mutation", () => {
    const content = { nested: { value: 1 } };
    const store = new TopicConversationStore();
    accept(store, content);
    content.nested.value = 9;
    expect(store.snapshot.turns[0]?.request.content).toEqual({ nested: { value: 1 } });
    expect(store.revision).toBe(1);
  });

  it("keeps terminal tool deduplication after its settled intermediate Card is evicted", () => {
    const store = new TopicConversationStore();
    accept(store);
    store.transaction((topic) => topic.prepare("response" as ResponseId));
    store.transaction((topic) => topic.activate("response" as ResponseId, "action" as ActionToken));
    store.transaction((topic) =>
      topic.append("response" as ResponseId, {
        kind: "tool",
        toolCallId: "tool-1",
        title: "Tool",
        status: "completed",
      }),
    );
    store.transaction((topic) =>
      topic.rotateTail(
        "response" as ResponseId,
        "next-card" as ResponseCardId,
        "content_rotation",
        "next-action" as ActionToken,
      ),
    );
    store.transactionIfChanged((topic) =>
      topic.evictSettledIntermediate("response" as ResponseId, "card" as ResponseCardId),
    );
    const revision = store.revision;
    store.transaction((topic) =>
      topic.append("response" as ResponseId, {
        kind: "tool",
        toolCallId: "tool-1",
        title: "Tool",
        status: "completed",
      }),
    );
    expect(store.revision).toBe(revision);
    expect(store.snapshot.turns[0]?.response.cards.at(-1)?.entries).toEqual([]);
  });

  it("does not publish stale no-op commands", () => {
    const store = new TopicConversationStore();
    accept(store);
    const revision = store.revision;
    const result = store.transaction((topic) =>
      topic.consumeCardCancel({
        responseId: "response" as ResponseId,
        cardId: "stale" as ResponseCardId,
        token: "stale" as ActionToken,
      }),
    );
    expect(result).toBe("stale");
    expect(store.revision).toBe(revision);
  });
});
