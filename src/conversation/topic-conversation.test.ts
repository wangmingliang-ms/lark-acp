import { describe, expect, it } from "vitest";
import {
  ResponseCardProjector,
  TopicConversation,
  type ActionToken,
  type PermissionToken,
  type RequestId,
  type ResponseCardId,
  type ResponseId,
  type ResponseToken,
  type TurnId,
} from "./topic-conversation.js";

const id = {
  turn: (value: string) => value as TurnId,
  request: (value: string) => value as RequestId,
  response: (value: string) => value as ResponseId,
  card: (value: string) => value as ResponseCardId,
  responseToken: (value: string) => value as ResponseToken,
  action: (value: string) => value as ActionToken,
  permission: (value: string) => value as PermissionToken,
};

function accept(topic: TopicConversation, name: string): ResponseId {
  return topic.accept({
    turnId: id.turn(`turn-${name}`),
    request: {
      id: id.request(`request-${name}`),
      sourceMessageId: `message-${name}`,
      content: name,
    },
    responseId: id.response(`response-${name}`),
    responseToken: id.responseToken(`response-token-${name}`),
    initialCardId: id.card(`card-${name}-1`),
    profile: { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" },
  });
}

function append(topic: TopicConversation, name: string): ResponseId {
  return topic.appendToInterruptBatch({
    turnId: id.turn(`turn-${name}`),
    request: {
      id: id.request(`request-${name}`),
      sourceMessageId: `message-${name}`,
      content: name,
    },
    responseId: id.response(`response-${name}`),
    responseToken: id.responseToken(`response-token-${name}`),
    initialCardId: id.card(`card-${name}-1`),
    profile: { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" },
  });
}

function start(topic: TopicConversation, responseId: ResponseId, name: string): void {
  topic.prepare(responseId);
  topic.activate(responseId, id.action(`action-${name}`));
}

function response(topic: TopicConversation, responseId: ResponseId) {
  const found = topic.snapshot().turns.find((turn) => turn.response.id === responseId)?.response;
  if (found === undefined) throw new Error("missing response");
  return found;
}

describe("TopicConversation canonical lifecycle", () => {
  it("projects only the active execution owner's tail with Cancel", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");

    const projection = new ResponseCardProjector().project(
      topic.snapshot(),
      a,
      id.card("card-a-1"),
    );

    expect(projection).toMatchObject({
      kind: "tail",
      titleVisible: true,
      metadata: { agent: "copilot" },
      cancelAction: { actionToken: "action-a" },
    });
  });

  it("demotes an old tail to a plain immutable intermediate Card on rotation", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    topic.append(a, {
      kind: "tool",
      toolCallId: "tool-1",
      title: "Build",
      status: "in_progress",
    });

    topic.rotateTail(a, id.card("card-a-2"), "content_rotation", id.action("action-a-2"));
    const snapshot = topic.snapshot();
    const projector = new ResponseCardProjector();
    const oldCard = projector.project(snapshot, a, id.card("card-a-1"));
    const newCard = projector.project(snapshot, a, id.card("card-a-2"));

    expect(oldCard).toMatchObject({
      kind: "intermediate",
      titleVisible: false,
      metadata: null,
      cancelAction: null,
      entries: [{ kind: "tool", status: "continued" }],
    });
    expect(newCard).toMatchObject({
      kind: "tail",
      titleVisible: true,
      cancelAction: { actionToken: "action-a-2" },
    });
  });

  it("keeps terminal tail Title and Metadata but removes Cancel", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");

    topic.seal(a, "complete");
    const projection = new ResponseCardProjector().project(
      topic.snapshot(),
      a,
      id.card("card-a-1"),
    );

    expect(projection).toMatchObject({
      kind: "tail",
      state: { kind: "terminal", outcome: "complete" },
      titleVisible: true,
      metadata: { agent: "copilot" },
      cancelAction: null,
    });
  });

  it("keeps A as sole Cancel owner while B interrupts it", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    const b = accept(topic, "b");
    const snapshot = topic.snapshot();
    const projector = new ResponseCardProjector();

    expect(projector.project(snapshot, a, id.card("card-a-1")).cancelAction).not.toBeNull();
    expect(projector.project(snapshot, b, id.card("card-b-1"))).toMatchObject({
      state: { kind: "in_progress", phase: "interrupting" },
      cancelAction: null,
    });
  });

  it("merges B into C and transfers the collecting batch carrier", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    const b = accept(topic, "b");
    const c = append(topic, "c");
    const snapshot = topic.snapshot();

    expect(response(topic, b).state).toEqual({ kind: "terminal", outcome: "merged" });
    expect(response(topic, c).state).toMatchObject({ kind: "in_progress", phase: "interrupting" });
    expect(snapshot.pendingBatch).toMatchObject({
      messages: [{ content: "b" }, { content: "c" }],
      carrierResponseId: c,
      state: "collecting",
    });
    expect(snapshot.executionOwnerResponseId).toBe(a);
  });

  it("seals A, seals the batch once, then activates only carrier C", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    accept(topic, "b");
    const c = append(topic, "c");

    const batch = topic.sealOwnerForPendingBatch("interrupted");
    expect(batch).toMatchObject({ carrierResponseId: c, state: "sealed" });
    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "interrupted" });
    expect(topic.snapshot().executionOwnerResponseId).toBeNull();

    topic.prepare(c);
    topic.activate(c, id.action("action-c"));
    topic.clearSealedBatch();

    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: c,
      pendingBatch: null,
      cancelAuthority: { kind: "cancel", responseId: c },
    });
  });

  it("Card Cancel cancels only A and preserves the pending batch", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    accept(topic, "b");
    const c = append(topic, "c");

    expect(
      topic.consumeCardCancel({
        responseId: a,
        cardId: id.card("card-a-1"),
        token: id.action("action-a"),
      }),
    ).toBe("accepted");

    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: null,
      pendingBatch: { carrierResponseId: c, state: "collecting" },
    });
    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(response(topic, c).state).toMatchObject({ kind: "in_progress", phase: "interrupting" });

    const batch = topic.commitPendingBatchAfterOwnerEnded();
    expect(batch).toMatchObject({ carrierResponseId: c, state: "sealed" });
  });

  it("topic /cancel cancels every unfinished Response but preserves merged history", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    const b = accept(topic, "b");
    const c = append(topic, "c");

    topic.cancelTopic();

    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(response(topic, b).state).toEqual({ kind: "terminal", outcome: "merged" });
    expect(response(topic, c).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: null,
      pendingBatch: null,
      cancelAuthority: { kind: "none" },
    });
  });

  it("creates a continuation tail with Cancel while Permission choices remain current", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");

    topic.requestPermission({
      responseId: a,
      permissionToken: id.permission("permission-1"),
      requestId: "permission-request-1",
      allowedOptionIds: new Set(["allow", "deny"]),
      continuationCardId: id.card("card-a-2"),
      continuationActionToken: id.action("action-a-2"),
    });
    const snapshot = topic.snapshot();
    const projector = new ResponseCardProjector();

    expect(projector.project(snapshot, a, id.card("card-a-1"))).toMatchObject({
      kind: "intermediate",
      titleVisible: false,
      metadata: null,
      cancelAction: null,
    });
    expect(projector.project(snapshot, a, id.card("card-a-2"))).toMatchObject({
      kind: "tail",
      state: { kind: "in_progress", phase: "awaiting_permission" },
      cancelAction: { actionToken: "action-a-2" },
    });
    expect(snapshot.permission).toMatchObject({
      status: "current",
      requestId: "permission-request-1",
    });
  });

  it("revokes Permission immediately when B arrives but retains A Cancel until A stops", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    topic.requestPermission({
      responseId: a,
      permissionToken: id.permission("permission-1"),
      requestId: "permission-request-1",
      allowedOptionIds: new Set(["allow"]),
      continuationCardId: id.card("card-a-2"),
      continuationActionToken: id.action("action-a-2"),
    });
    const b = accept(topic, "b");

    topic.revokePermissionForInterrupt(a);
    const snapshot = topic.snapshot();

    expect(snapshot.permission).toMatchObject({ status: "expired" });
    expect(snapshot.executionOwnerResponseId).toBe(a);
    expect(snapshot.cancelAuthority).toMatchObject({ kind: "cancel", responseId: a });
    expect(response(topic, b).state).toMatchObject({ kind: "in_progress", phase: "interrupting" });
  });

  it("fails the Response when its mandatory Permission Card cannot be displayed", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    topic.requestPermission({
      responseId: a,
      permissionToken: id.permission("permission-1"),
      requestId: "permission-request-1",
      allowedOptionIds: new Set(["allow"]),
      continuationCardId: id.card("card-a-2"),
      continuationActionToken: id.action("action-a-2"),
    });

    topic.permissionDisplayFailed(a);

    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "failed" });
    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: null,
      cancelAuthority: { kind: "none" },
      permission: { status: "display_failed" },
    });
  });

  it("rejects late updates and stale Cancel after terminal", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    topic.seal(a, "interrupted");

    expect(() => topic.append(a, { kind: "text", text: "late" })).toThrow();
    expect(
      topic.consumeCardCancel({
        responseId: a,
        cardId: id.card("card-a-1"),
        token: id.action("action-a"),
      }),
    ).toBe("stale");
  });
});
