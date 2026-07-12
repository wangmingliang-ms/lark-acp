import { describe, expect, it, vi } from "vitest";
import type { BindingStore } from "../binding-store/binding-store.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
import { LarkBridge } from "./bridge.js";

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function makeBridge(v2Enabled = false, presenter: LarkPresenter = {} as LarkPresenter): LarkBridge {
  return new LarkBridge({
    lark: { appId: "test", appSecret: "test" },
    agent: {
      resolver: () => ({ command: "test", args: [], label: "test" }),
    },
    bindingStore: {} as BindingStore,
    sessionStore: {} as SessionStore,
    presenter,
    logger,
    conversationCardFeature: { v2Enabled },
  });
}

function dispatchCardAction(bridge: LarkBridge, value: object): void {
  const testable = bridge as unknown as {
    handleCardAction(event: {
      readonly action: { readonly value: object };
      readonly messageId: string;
    }): void;
  };
  testable.handleCardAction({ action: { value }, messageId: "message" });
}

describe("LarkBridge prompt ingress ordering", () => {
  it("serializes hydration and enqueue per topic while keeping topics independent", async () => {
    const bridge = makeBridge(true);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const testable = bridge as unknown as {
      enqueueWithContext(
        event: unknown,
        chatId: string,
        threadId: string | null,
        userId: string,
        messageId: string,
        segments: unknown[],
      ): Promise<void>;
      enqueueWithContextSerial: ReturnType<typeof vi.fn>;
    };
    testable.enqueueWithContextSerial = vi.fn(async (_event, _chat, _thread, _user, messageId) => {
      calls.push(`start:${messageId}`);
      if (messageId === "b") await firstBlocked;
      calls.push(`end:${messageId}`);
    });

    const event = {};
    const b = testable.enqueueWithContext(event, "chat", "topic", "user", "b", []);
    const c = testable.enqueueWithContext(event, "chat", "topic", "user", "c", []);
    const other = testable.enqueueWithContext(event, "chat", "other", "user", "x", []);
    await vi.waitFor(() => expect(calls).toContain("end:x"));
    expect(calls).not.toContain("start:c");
    releaseFirst();
    await Promise.all([b, c, other]);
    expect(calls.indexOf("end:b")).toBeLessThan(calls.indexOf("start:c"));
  });
});

describe("LarkBridge Cancel card compatibility", () => {
  it("rejects a versioned Cancel action before runtime lookup", () => {
    const bridge = makeBridge();
    const get = vi.fn();
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, { v: 2, cancel: true, c: "chat", th: "topic" });

    expect(get).not.toHaveBeenCalled();
  });

  it("makes unversioned legacy Cancel actions inert", () => {
    const bridge = makeBridge();
    const cancel = vi.fn(async () => {});
    const get = vi.fn(() => ({ cancel }));
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, { cancel: true, c: "chat", th: "topic" });

    expect(get).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("LarkBridge semantic card actions", () => {
  it("passes the production v2 gate to the default Lark presenter", () => {
    const bridge = new LarkBridge({
      lark: { appId: "test", appSecret: "test" },
      agent: { resolver: () => ({ command: "test", args: [], label: "test" }) },
      bindingStore: {} as BindingStore,
      sessionStore: {} as SessionStore,
      logger,
      conversationCardFeature: { v2Enabled: true },
    });
    const presenter = (bridge as unknown as { presenter: { feature: { v2Enabled: boolean } } })
      .presenter;
    expect(presenter.feature.v2Enabled).toBe(true);
  });

  it("routes only the exact v2 Cancel schema to runtime token authority", () => {
    const bridge = makeBridge(true);
    const consumeCancelAction = vi.fn(() => "accepted" as const);
    const get = vi.fn(() => ({ consumeCancelAction }));
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, {
      v: 2,
      c: "chat",
      th: "topic",
      cancel: true,
      p: "prompt",
      s: "segment",
      a: "action",
    });

    expect(consumeCancelAction).toHaveBeenCalledExactlyOnceWith({
      promptToken: "prompt",
      segmentToken: "segment",
      actionToken: "action",
    });
    for (const invalid of [
      { v: 3, c: "chat", cancel: true, p: "prompt", s: "segment", a: "action" },
      { v: 2, c: "chat", cancel: true },
      { v: 2, c: "chat", cancel: true, p: "prompt", s: "segment", a: "action", x: 1 },
    ]) {
      dispatchCardAction(bridge, invalid);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("routes only the exact v2 permission schema to runtime token authority", () => {
    const bridge = makeBridge(true);
    const consumePermissionAction = vi.fn(() => "accepted" as const);
    const get = vi.fn(() => ({ consumePermissionAction }));
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, {
      v: 2,
      c: "chat",
      p: "prompt",
      q: "permission",
      r: "request",
      o: "option",
    });

    expect(consumePermissionAction).toHaveBeenCalledExactlyOnceWith({
      promptToken: "prompt",
      permissionToken: "permission",
      requestId: "request",
      optionId: "option",
    });
    for (const invalid of [
      { v: 99, c: "chat", p: "prompt", q: "permission", r: "request", o: "option" },
      { v: 2, c: "chat", r: "request", o: "option" },
      { v: 2, c: "chat", p: "prompt", q: "permission", r: "request", o: "option", n: "old" },
    ]) {
      dispatchCardAction(bridge, invalid);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("wires production acknowledgement removal as best effort", async () => {
    const bridge = makeBridge(true);
    const removeMessageReaction = vi.fn(async () => {});
    (bridge as unknown as { http: { removeMessageReaction: typeof removeMessageReaction } }).http =
      {
        removeMessageReaction,
      };
    const acknowledgement = (
      bridge as unknown as {
        acknowledgement: {
          remove(messageId: string, reactionId: string): Promise<boolean>;
        };
      }
    ).acknowledgement;

    await expect(acknowledgement.remove("message", "reaction")).resolves.toBe(true);
    expect(removeMessageReaction).toHaveBeenCalledExactlyOnceWith("message", "reaction");
    removeMessageReaction.mockRejectedValueOnce(new Error("transport"));
    await expect(acknowledgement.remove("message", "reaction-2")).resolves.toBe(false);
    expect(removeMessageReaction).toHaveBeenCalledTimes(2);
  });

  it("keeps semantic routing disabled by default", () => {
    const bridge = makeBridge();
    const get = vi.fn();
    (bridge as unknown as { chats: { get: typeof get } }).chats = { get };

    dispatchCardAction(bridge, {
      v: 2,
      c: "chat",
      cancel: true,
      p: "prompt",
      s: "segment",
      a: "action",
    });

    expect(get).not.toHaveBeenCalled();
  });
});
