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

  it("evicts a settled intermediate but never the current tail", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    topic.rotateTail(a, id.card("card-a-2"), "content_rotation", id.action("action-a-2"));

    expect(topic.evictSettledIntermediate(a, id.card("card-a-2"))).toBe(false);
    expect(topic.evictSettledIntermediate(a, id.card("card-a-1"))).toBe(true);
    expect(topic.snapshot().turns.find((turn) => turn.response.id === a)?.response.cards).toEqual([
      expect.objectContaining({ id: "card-a-2", isTail: true }),
    ]);
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

  it("Card Cancel revokes A immediately, then preserves the pending batch after A stops", () => {
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
      executionOwnerResponseId: a,
      cancelAuthority: { kind: "none" },
      pendingBatch: { carrierResponseId: c, state: "collecting" },
    });
    expect(response(topic, a).state).toMatchObject({ kind: "in_progress", phase: "active" });
    expect(response(topic, c).state).toMatchObject({ kind: "in_progress", phase: "interrupting" });

    const batch = topic.sealOwnerForPendingBatch("cancelled");
    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(batch).toMatchObject({ carrierResponseId: c, state: "sealed" });
  });

  it("topic /cancel revokes waiting work immediately but keeps owner until stop confirmation", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    const b = accept(topic, "b");
    const c = append(topic, "c");

    topic.beginTopicCancel();

    expect(response(topic, a).state).toMatchObject({ kind: "in_progress" });
    expect(response(topic, b).state).toEqual({ kind: "terminal", outcome: "merged" });
    expect(response(topic, c).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: a,
      pendingBatch: null,
      cancelAuthority: { kind: "none" },
    });

    topic.confirmTopicCancel();
    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "cancelled" });
    expect(topic.snapshot().executionOwnerResponseId).toBeNull();
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
    const snapshot = topic.snapshot();

    expect(snapshot.permission).toMatchObject({ status: "expired" });
    expect(snapshot.executionOwnerResponseId).toBe(a);
    expect(snapshot.cancelAuthority).toMatchObject({ kind: "cancel", responseId: a });
    expect(response(topic, b).state).toMatchObject({ kind: "in_progress", phase: "interrupting" });
  });

  it("keeps consecutive permission continuation intermediates non-empty", () => {
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
    topic.resolvePermission(id.permission("permission-1"), "allow");
    topic.requestPermission({
      responseId: a,
      permissionToken: id.permission("permission-2"),
      requestId: "permission-request-2",
      allowedOptionIds: new Set(["allow"]),
      continuationCardId: id.card("card-a-3"),
      continuationActionToken: id.action("action-a-3"),
    });

    expect(response(topic, a).cards[1]?.entries).toContainEqual({
      kind: "notice",
      text: "等待权限处理完成。",
    });
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

    topic.beginPermissionDisplayFailure(a);

    expect(response(topic, a).state).toMatchObject({ kind: "in_progress" });
    expect(topic.snapshot()).toMatchObject({
      executionOwnerResponseId: a,
      cancelAuthority: { kind: "none" },
      permission: { status: "display_failed" },
    });
    expect(response(topic, a).cards.at(-1)?.entries).toContainEqual({
      kind: "notice",
      text: "权限请求无法显示，正在停止本次执行。",
    });

    topic.seal(a, "failed");
    expect(response(topic, a).state).toEqual({ kind: "terminal", outcome: "failed" });
  });

  it("routes repeated accept calls into the same collecting batch", () => {
    const topic = new TopicConversation();
    const a = accept(topic, "a");
    start(topic, a, "a");
    const b = accept(topic, "b");
    const c = accept(topic, "c");

    expect(response(topic, b).state).toEqual({ kind: "terminal", outcome: "merged" });
    expect(topic.snapshot().pendingBatch).toMatchObject({
      messages: [{ content: "b" }, { content: "c" }],
      carrierResponseId: c,
      state: "collecting",
    });
    expect(() => topic.prepare(c)).toThrow("cannot prepare while execution is owned");
  });

  it("does not duplicate terminal tool results across Cards", () => {
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
    topic.append(a, {
      kind: "tool",
      toolCallId: "tool-1",
      title: "Build",
      status: "completed",
    });
    topic.append(a, {
      kind: "tool",
      toolCallId: "tool-1",
      title: "Build duplicate",
      status: "completed",
    });

    expect(response(topic, a).cards.at(-1)?.entries).toEqual([
      { kind: "tool", toolCallId: "tool-1", title: "Build", status: "completed" },
    ]);
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
