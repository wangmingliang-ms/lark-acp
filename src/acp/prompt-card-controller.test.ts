import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  ActionToken,
  ConversationCardView,
  OwnershipToken,
  PermissionToken,
  PromptToken,
  SegmentToken,
} from "../presenter/conversation-card-view.js";
import type { SessionCardMeta } from "../presenter/presenter.js";
import {
  ConversationCardDelivery,
  type CardDeliveryResult,
  type PermissionHandoffResult,
} from "./conversation-card-delivery.js";
import type { LifecycleDiagnosticEvent, LifecycleDiagnosticSink } from "./lifecycle-diagnostics.js";
import {
  PromptCardController,
  type PromptCardControllerDelivery,
  type PromptCardTokenFactory,
} from "./prompt-card-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tokens(): PromptCardTokenFactory {
  let prompt = 0;
  let segment = 0;
  let action = 0;
  let permission = 0;
  let owner = 0;
  return {
    prompt: () => `prompt-${++prompt}` as PromptToken,
    segment: () => `segment-${++segment}` as SegmentToken,
    action: () => `action-${++action}` as ActionToken,
    permission: () => `permission-${++permission}` as PermissionToken,
    ownership: () => `owner-${++owner}` as OwnershipToken,
  };
}

function sink(): LifecycleDiagnosticSink & { events: LifecycleDiagnosticEvent[] } {
  const events: LifecycleDiagnosticEvent[] = [];
  return { events, record: (event) => events.push(event) };
}

function delivery(overrides: Partial<PromptCardControllerDelivery> = {}) {
  const value: PromptCardControllerDelivery = {
    createOwner: vi.fn((_context, _correlation, token) => token),
    deliver: vi.fn(async () => ({ outcome: "visible", cardId: "card" })),
    close: vi.fn((_owner, _view, _correlation, next) => next),
    handoffToPermission: vi.fn(async () => ({
      outcome: "sent_fresh",
      permissionCardId: "permission-card",
    })),
    reconcileSuperseded: vi.fn(async () => undefined),
    ...overrides,
  };
  return value;
}

const profile: SessionCardMeta = {
  agent: "copilot",
  mode: "agent",
  model: "gpt",
  permission: "ask",
};

function controller(
  options: {
    delivery?: PromptCardControllerDelivery;
    diagnostics?: LifecycleDiagnosticSink;
    acknowledge?: {
      add(messageId: string): Promise<string | null>;
      remove(messageId: string, reactionId: string): Promise<boolean>;
    };
    cancel?: () => void;
    permissionTimeoutMs?: number;
  } = {},
) {
  return new PromptCardController({
    initialPhase: "starting",
    profile,
    route: { c: "chat", th: "thread" },
    correlation: { runtimeSequence: 4, promptSequence: 7 },
    tokens: tokens(),
    delivery: options.delivery ?? delivery(),
    diagnostics: options.diagnostics ?? sink(),
    acknowledgement: options.acknowledge,
    cancel: options.cancel,
    permissionTimeoutMs: options.permissionTimeoutMs,
  });
}

function textUpdate(text: string): acp.SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function permissionParams(
  options = [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
): acp.RequestPermissionRequest {
  return {
    sessionId: "session",
    options,
    toolCall: {
      toolCallId: "tool",
      title: "Run command",
      kind: "execute",
      status: "pending",
    },
  };
}

describe("PromptCardController", () => {
  it("commits forwarded state synchronously and coalesces chunks into one latest render", async () => {
    vi.useFakeTimers();
    const port = delivery();
    const subject = controller({ delivery: port });

    const identity = subject.markForwarded();
    subject.applyAgentUpdate(textUpdate("hel"));
    subject.applyAgentUpdate(textUpdate("lo"));

    expect(identity).toEqual({
      promptToken: "prompt-1",
      segmentToken: "segment-1",
      actionToken: "action-1",
    });
    expect(port.deliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(port.deliver).toHaveBeenCalledTimes(2);
    expect(port.deliver).toHaveBeenLastCalledWith(
      "owner-1",
      expect.objectContaining({ entries: [{ kind: "text", text: "hello" }] }),
    );
    vi.useRealTimers();
  });

  it("commits terminal close while an earlier render hangs and never reopens for late updates", () => {
    const hung = deferred<CardDeliveryResult>();
    const port = delivery({ deliver: vi.fn(() => hung.promise) });
    const subject = controller({ delivery: port });
    subject.markForwarded();

    subject.finish("complete");
    subject.applyAgentUpdate(textUpdate("late secret"));

    expect(port.close).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({ kind: "terminal", header: "complete" }),
      expect.anything(),
      "owner-2",
    );
    expect(port.deliver).toHaveBeenCalledTimes(1);
  });

  it("invalidates the pending coalesced flush when permission starts", async () => {
    vi.useFakeTimers();
    const port = delivery();
    const subject = controller({ delivery: port });
    subject.markForwarded();
    subject.applyAgentUpdate(textUpdate("content"));

    subject.requestPermission({ requestId: "request", params: permissionParams() });
    await vi.advanceTimersByTimeAsync(100);

    expect(port.deliver).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({ kind: "archived" }),
      expect.anything(),
      "owner-2",
    );
    expect(port.handoffToPermission).toHaveBeenCalledWith(
      "owner-2",
      expect.objectContaining({ reuseCard: false }),
    );
    vi.useRealTimers();
  });

  it("reuses an empty conversation card at the permission boundary", async () => {
    const port = delivery();
    const subject = controller({ delivery: port });
    subject.markForwarded();

    subject.requestPermission({ requestId: "request", params: permissionParams() });
    await Promise.resolve();

    expect(port.close).not.toHaveBeenCalled();
    expect(port.handoffToPermission).toHaveBeenCalledWith(
      "owner-1",
      expect.objectContaining({ reuseCard: true }),
    );
  });

  it("owns one immutable permission response and accepts an allowed selection exactly once", async () => {
    const subject = controller();
    const identity = subject.markForwarded();
    const pending = subject.requestPermission({ requestId: "request", params: permissionParams() });

    expect(Object.isFrozen(pending.allowedOptionIds)).toBe(true);
    expect(
      subject.consumePermission({
        promptToken: identity.promptToken,
        permissionToken: pending.permissionToken,
        requestId: "request",
        optionId: "allow",
      }),
    ).toBe("accepted");
    await expect(pending.response).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(
      subject.consumePermission({
        promptToken: identity.promptToken,
        permissionToken: pending.permissionToken,
        requestId: "request",
        optionId: "allow",
      }),
    ).toBe("duplicate");
  });

  it("leaves invalid and stale permission actions pending until explicit cancellation", async () => {
    const subject = controller();
    const identity = subject.markForwarded();
    const pending = subject.requestPermission({ requestId: "request", params: permissionParams() });
    let settled = false;
    void pending.response.then(() => (settled = true));

    expect(
      subject.consumePermission({
        promptToken: identity.promptToken,
        permissionToken: pending.permissionToken,
        requestId: "request",
        optionId: "deny",
      }),
    ).toBe("invalid_option");
    expect(
      subject.consumePermission({
        promptToken: "stale" as PromptToken,
        permissionToken: pending.permissionToken,
        requestId: "request",
        optionId: "allow",
      }),
    ).toBe("stale");
    await Promise.resolve();
    expect(settled).toBe(false);

    subject.cancelPendingPermissions("connection_shutdown");
    await expect(pending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels a permission once on timeout and once when handoff fails", async () => {
    vi.useFakeTimers();
    const timed = controller({ permissionTimeoutMs: 250 });
    timed.markForwarded();
    const timeoutPending = timed.requestPermission({
      requestId: "timeout",
      params: permissionParams(),
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(timeoutPending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    const failedPort = delivery({
      handoffToPermission: vi.fn(async () => ({ outcome: "failed" })),
    });
    const failed = controller({ delivery: failedPort });
    failed.markForwarded();
    const failedPending = failed.requestPermission({
      requestId: "failed",
      params: permissionParams(),
    });
    await expect(failedPending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    vi.useRealTimers();
  });

  it("supersedes a pending permission and rejects malformed requests", async () => {
    const subject = controller();
    subject.markForwarded();
    const first = subject.requestPermission({ requestId: "first", params: permissionParams() });
    expect(() => subject.requestPermission({ requestId: "", params: permissionParams() })).toThrow(
      "requestId",
    );
    expect(() =>
      subject.requestPermission({ requestId: "empty", params: permissionParams([]) }),
    ).toThrow("options");

    const second = subject.requestPermission({ requestId: "second", params: permissionParams() });
    await expect(first.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    subject.finish("superseded");
    await expect(second.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("accepts only the exact current cancel identity and invokes cancellation once", () => {
    const cancel = vi.fn();
    const subject = controller({ cancel });
    const identity = subject.markForwarded();

    expect(subject.consumeCancel({ ...identity, actionToken: "stale-action" as ActionToken })).toBe(
      "stale",
    );
    expect(subject.consumeCancel(identity)).toBe("accepted");
    expect(subject.consumeCancel(identity)).toBe("duplicate");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("removes acknowledgement on first real visibility at most once", async () => {
    const visible = deferred<CardDeliveryResult>();
    const remove = vi.fn(async () => true);
    const port = delivery({ deliver: vi.fn(() => visible.promise) });
    const subject = controller({ delivery: port, acknowledge: { add: vi.fn(), remove } });
    subject.acknowledge({ messageId: "message", reactionId: "reaction" });
    subject.markForwarded();
    visible.resolve({ outcome: "visible", cardId: "card" });
    await subject.awaitEffects(100);

    expect(remove).toHaveBeenCalledExactlyOnceWith("message", "reaction");
    subject.finish("complete");
    await subject.awaitEffects(100);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("finish removes an attached acknowledgement before any card becomes visible", async () => {
    const remove = vi.fn(async () => false);
    const subject = controller({ acknowledge: { add: vi.fn(), remove } });
    subject.acknowledge({ messageId: "message", reactionId: "reaction" });

    subject.finish("abandoned");
    await subject.awaitEffects(100);

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("awaitEffects is bounded and rejected effects do not poison later waits", async () => {
    vi.useFakeTimers();
    const diagnostics = sink();
    const hung = deferred<CardDeliveryResult>();
    const port = delivery({ deliver: vi.fn(() => hung.promise) });
    const subject = controller({ delivery: port, diagnostics });
    subject.markForwarded();
    const waiting = subject.awaitEffects(50);
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(diagnostics.events).toContainEqual(
      expect.objectContaining({
        category: "controller",
        operation: "await_effects",
        outcome: "timeout",
      }),
    );

    hung.reject(new Error("transport secret"));
    await Promise.resolve();
    await subject.awaitEffects(50);
    expect(JSON.stringify(diagnostics.events)).not.toContain("transport secret");
    vi.useRealTimers();
  });

  it("resumes the lifecycle after permission handoff failure", async () => {
    const failedPort = delivery({
      handoffToPermission: vi.fn(async () => ({ outcome: "failed" })),
    });
    const subject = controller({ delivery: failedPort });
    subject.markForwarded();
    const pending = subject.requestPermission({ requestId: "failed", params: permissionParams() });

    await expect(pending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await vi.waitFor(() => expect(failedPort.deliver).toHaveBeenCalledTimes(2));
    expect(failedPort.deliver).toHaveBeenLastCalledWith(
      "owner-2",
      expect.objectContaining({ kind: "active", header: "thinking" }),
    );
  });

  it("removes a reaction that attaches only after terminal", async () => {
    const remove = vi.fn(async () => true);
    const subject = controller({ acknowledge: { add: vi.fn(), remove } });
    subject.finish("abandoned");
    subject.acknowledge({ messageId: "message", reactionId: "late-reaction" });
    await subject.awaitEffects(100);

    expect(remove).toHaveBeenCalledExactlyOnceWith("message", "late-reaction");
  });

  it("removes ACK attached after visibility and deduplicates terminal late callbacks", async () => {
    const remove = vi.fn(async () => true);
    const subject = controller({ acknowledge: { add: vi.fn(), remove } });
    subject.markForwarded();
    await subject.awaitEffects(100);
    subject.acknowledge({ messageId: "message", reactionId: "reaction" });
    await subject.awaitEffects(100);
    expect(remove).toHaveBeenCalledTimes(1);

    subject.finish("complete");
    subject.acknowledge({ messageId: "message", reactionId: "reaction" });
    subject.acknowledge({ messageId: "message", reactionId: "reaction" });
    await subject.awaitEffects(100);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("removes an asynchronously added ACK when visibility wins the race", async () => {
    const reaction = deferred<string | null>();
    const remove = vi.fn(async () => true);
    const subject = controller({
      acknowledge: { add: vi.fn(() => reaction.promise), remove },
    });
    subject.acknowledge({ messageId: "message" });
    subject.markForwarded();
    await subject.awaitEffects(0);

    reaction.resolve("reaction");
    await subject.awaitEffects(100);
    expect(remove).toHaveBeenCalledExactlyOnceWith("message", "reaction");
  });

  it("settles and resumes when permission handoff rejects", async () => {
    const failedPort = delivery({
      handoffToPermission: vi.fn(async () => {
        throw new Error("transport secret");
      }),
    });
    const diagnostics = sink();
    const subject = controller({ delivery: failedPort, diagnostics });
    subject.markForwarded();
    const pending = subject.requestPermission({
      requestId: "rejected",
      params: permissionParams(),
    });

    await expect(pending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await vi.waitFor(() => expect(failedPort.deliver).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(diagnostics.events)).not.toContain("transport secret");
  });

  it("integrates with ConversationCardDelivery across a deferred content permission handoff", async () => {
    const archivePatch = deferred<boolean>();
    const patchView = vi.fn(() => archivePatch.promise);
    const sendPermission = vi.fn(async () => "permission-card");
    const real = new ConversationCardDelivery(
      { send: vi.fn(), patch: vi.fn() },
      sink(),
      () => "unused" as OwnershipToken,
      { sendView: vi.fn(async () => "card"), patchView },
      { patchPermission: vi.fn(), sendPermission, reconcilePermissionArtifact: vi.fn() },
    );
    const subject = controller({ delivery: real });
    subject.markForwarded();
    await subject.awaitEffects(100);
    subject.applyAgentUpdate(textUpdate("before"));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();

    const pending = subject.requestPermission({ requestId: "request", params: permissionParams() });
    await vi.waitFor(() => expect(sendPermission).toHaveBeenCalledTimes(1));
    archivePatch.resolve(true);
    subject.finish("cancelled");
    await expect(pending.response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });
});
