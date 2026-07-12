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

function dispatchMessage(bridge: LarkBridge): void {
  const testable = bridge as unknown as {
    handleMessage(event: object): void;
  };
  testable.handleMessage({
    sender: { sender_type: "user", sender_id: { open_id: "user" } },
    message: {
      message_id: "message",
      chat_id: "chat",
      message_type: "text",
      chat_type: "p2p",
      content: JSON.stringify({ text: "hello" }),
    },
  });
}

describe("LarkBridge restart-window intake", () => {
  it("does not route a message received after shutdown begins", async () => {
    const replyNoticeCard = vi.fn(async () => {});
    const bridge = makeBridge(false, { replyNoticeCard } as unknown as LarkPresenter);
    const routeMessage = vi.fn(async () => {});
    (bridge as unknown as { routeMessage: typeof routeMessage }).routeMessage = routeMessage;

    dispatchMessage(bridge);

    expect(routeMessage).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(replyNoticeCard).toHaveBeenCalledWith(
        "message",
        expect.objectContaining({ title: expect.stringContaining("正在重启") }),
      ),
    );
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
