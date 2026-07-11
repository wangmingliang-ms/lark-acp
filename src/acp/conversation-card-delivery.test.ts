import { describe, expect, it, vi } from "vitest";
import type { UnifiedCardState } from "../presenter/presenter.js";
import {
  ConversationCardDelivery,
  type CardDeliveryTransport,
} from "./conversation-card-delivery.js";

function cardState(text: string): UnifiedCardState {
  return {
    status: "responding",
    entries: [{ kind: "text", text }],
    cancellable: true,
    chatId: "chat-1",
    threadId: "thread-1",
  };
}

function transport(overrides: Partial<CardDeliveryTransport> = {}): CardDeliveryTransport {
  return {
    send: vi.fn(async () => "card-1"),
    patch: vi.fn(async () => true),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ConversationCardDelivery", () => {
  it("sends the first complete state", async () => {
    const cardTransport = transport();
    const delivery = new ConversationCardDelivery(cardTransport);
    const state = cardState("complete snapshot");

    await expect(delivery.deliver(state)).resolves.toEqual({
      outcome: "visible",
      cardId: "card-1",
    });
    expect(cardTransport.send).toHaveBeenCalledExactlyOnceWith(state);
    expect(cardTransport.patch).not.toHaveBeenCalled();
  });

  it("patches the active card with each later complete state", async () => {
    const cardTransport = transport();
    const delivery = new ConversationCardDelivery(cardTransport);
    const firstState = cardState("first");
    const laterState = cardState("later complete snapshot");

    await delivery.deliver(firstState);

    await expect(delivery.deliver(laterState)).resolves.toEqual({
      outcome: "visible",
      cardId: "card-1",
    });
    expect(cardTransport.send).toHaveBeenCalledTimes(1);
    expect(cardTransport.patch).toHaveBeenCalledExactlyOnceWith("card-1", laterState);
  });

  it("abandons a rejected card and sends the same complete state on a replacement", async () => {
    const send = vi.fn().mockResolvedValueOnce("old-card").mockResolvedValueOnce("new-card");
    const patch = vi.fn(async () => false);
    const delivery = new ConversationCardDelivery({ send, patch });
    const rejectedState = cardState("full state at rejection");
    await delivery.deliver(cardState("initial"));

    await expect(delivery.deliver(rejectedState)).resolves.toEqual({
      outcome: "visible",
      cardId: "new-card",
    });
    expect(patch).toHaveBeenCalledExactlyOnceWith("old-card", rejectedState);
    expect(send).toHaveBeenNthCalledWith(2, rejectedState);
  });

  it("patches the replacement and never retries the abandoned card", async () => {
    const send = vi.fn().mockResolvedValueOnce("old-card").mockResolvedValueOnce("new-card");
    const patch = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const delivery = new ConversationCardDelivery({ send, patch });
    await delivery.deliver(cardState("initial"));
    await delivery.deliver(cardState("rollover"));
    const nextState = cardState("after rollover");

    await delivery.deliver(nextState);

    expect(patch).toHaveBeenNthCalledWith(2, "new-card", nextState);
    expect(patch).not.toHaveBeenCalledWith("old-card", nextState);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent delivery through one replacement and patches it with the newest state", async () => {
    const rejectedPatch = deferred<boolean>();
    const replacementSend = deferred<string | null>();
    const send = vi
      .fn()
      .mockResolvedValueOnce("old-card")
      .mockImplementationOnce(() => replacementSend.promise);
    const patch = vi
      .fn()
      .mockImplementationOnce(() => rejectedPatch.promise)
      .mockResolvedValue(true);
    const delivery = new ConversationCardDelivery({ send, patch });
    await delivery.deliver(cardState("initial"));
    const rejectedState = cardState("state that rejects");
    const newestState = cardState("newest complete state");

    const rejectedDelivery = delivery.deliver(rejectedState);
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledExactlyOnceWith("old-card", rejectedState),
    );
    rejectedPatch.resolve(false);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    const newestDelivery = delivery.deliver(newestState);
    replacementSend.resolve("new-card");

    await expect(rejectedDelivery).resolves.toEqual({ outcome: "visible", cardId: "new-card" });
    await expect(newestDelivery).resolves.toEqual({ outcome: "visible", cardId: "new-card" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenNthCalledWith(2, "new-card", newestState);
  });

  it("ignores an obsolete patch rejection after a newer card is adopted", async () => {
    const oldPatch = deferred<boolean>();
    const send = vi.fn(async () => "unexpected-third-card");
    const patch = vi
      .fn()
      .mockImplementationOnce(() => oldPatch.promise)
      .mockResolvedValue(true);
    const delivery = new ConversationCardDelivery({ send, patch });
    delivery.adopt("old-card");
    const obsoleteDelivery = delivery.deliver(cardState("obsolete state"));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    delivery.detach();
    delivery.adopt("new-card");
    oldPatch.resolve(false);

    await expect(obsoleteDelivery).resolves.toEqual({ outcome: "skipped" });
    expect(send).not.toHaveBeenCalled();
    const currentState = cardState("current state");
    await expect(delivery.deliver(currentState)).resolves.toEqual({
      outcome: "visible",
      cardId: "new-card",
    });
    expect(patch).toHaveBeenNthCalledWith(2, "new-card", currentState);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["returns null", null],
    ["throws", new Error("replacement send failed")],
  ])(
    "retries the newest complete state on a later delivery after replacement send %s",
    async (_, failure) => {
      const send = vi
        .fn()
        .mockResolvedValueOnce("old-card")
        .mockImplementationOnce(async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        })
        .mockResolvedValueOnce("new-card");
      const patch = vi.fn(async () => false);
      const delivery = new ConversationCardDelivery({ send, patch });
      await delivery.deliver(cardState("initial"));
      const failedState = cardState("failed replacement state");

      const failedDelivery = delivery.deliver(failedState);
      if (failure instanceof Error) {
        await expect(failedDelivery).rejects.toBe(failure);
      } else {
        await expect(failedDelivery).resolves.toEqual({ outcome: "pending" });
      }
      expect(send).toHaveBeenCalledTimes(2);

      const newestState = cardState("newest state on independent retry");
      await expect(delivery.deliver(newestState)).resolves.toEqual({
        outcome: "visible",
        cardId: "new-card",
      });
      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenNthCalledWith(3, newestState);
      expect(delivery.hasCard()).toBe(true);
    },
  );

  it("treats a thrown patch as rejection and propagates replacement send errors", async () => {
    const replacementError = new Error("replacement send failed");
    const send = vi.fn().mockResolvedValueOnce("old-card").mockRejectedValueOnce(replacementError);
    const patch = vi.fn(async () => {
      throw new Error("patch rejected");
    });
    const delivery = new ConversationCardDelivery({ send, patch });
    await delivery.deliver(cardState("initial"));
    const replacementState = cardState("must survive thrown patch");

    await expect(delivery.deliver(replacementState)).rejects.toBe(replacementError);
    expect(send).toHaveBeenNthCalledWith(2, replacementState);
    expect(delivery.hasCard()).toBe(false);
  });

  it("adopts an external card for patch delivery", async () => {
    const cardTransport = transport();
    const delivery = new ConversationCardDelivery(cardTransport);
    const state = cardState("adopted state");

    delivery.adopt("external-card");

    expect(delivery.hasCard()).toBe(true);
    await expect(delivery.deliver(state)).resolves.toEqual({
      outcome: "visible",
      cardId: "external-card",
    });
    expect(cardTransport.patch).toHaveBeenCalledExactlyOnceWith("external-card", state);
    expect(cardTransport.send).not.toHaveBeenCalled();
  });

  it("takes active ownership once and makes the next delivery create a card", async () => {
    const cardTransport = transport({ send: vi.fn(async () => "new-card") });
    const delivery = new ConversationCardDelivery(cardTransport);
    delivery.adopt("handed-off-card");

    expect(delivery.takeActiveCardId()).toBe("handed-off-card");
    expect(delivery.takeActiveCardId()).toBeNull();
    expect(delivery.hasCard()).toBe(false);

    await delivery.deliver(cardState("after handoff"));
    expect(cardTransport.send).toHaveBeenCalledOnce();
    expect(cardTransport.patch).not.toHaveBeenCalled();
  });

  it("detaches active ownership so the next delivery creates a card", async () => {
    const cardTransport = transport({ send: vi.fn(async () => "new-card") });
    const delivery = new ConversationCardDelivery(cardTransport);
    delivery.adopt("detached-card");

    delivery.detach();

    expect(delivery.hasCard()).toBe(false);
    await delivery.deliver(cardState("after detach"));
    expect(cardTransport.send).toHaveBeenCalledExactlyOnceWith(cardState("after detach"));
    expect(cardTransport.patch).not.toHaveBeenCalled();
  });

  it("reset skips queued work from the old lifecycle and protects a fresh delivery", async () => {
    const inFlightPatch = deferred<boolean>();
    const send = vi.fn(async () => "fresh-card");
    const patch = vi
      .fn()
      .mockImplementationOnce(() => inFlightPatch.promise)
      .mockResolvedValue(true);
    const delivery = new ConversationCardDelivery({ send, patch });
    delivery.adopt("old-card");
    const inFlight = delivery.deliver(cardState("old in flight"));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const queued = delivery.deliver(cardState("old queued"));

    delivery.reset();
    const freshState = cardState("fresh lifecycle");
    const fresh = delivery.deliver(freshState);
    inFlightPatch.resolve(false);

    await expect(inFlight).resolves.toEqual({ outcome: "skipped" });
    await expect(queued).resolves.toEqual({ outcome: "skipped" });
    await expect(fresh).resolves.toEqual({ outcome: "visible", cardId: "fresh-card" });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(freshState);
  });

  it("reset clears active ownership before a new delivery lifecycle", async () => {
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("new-card");
    const patch = vi.fn(async () => true);
    const delivery = new ConversationCardDelivery({ send, patch });
    await delivery.deliver(cardState("retained while pending"));
    delivery.adopt("active-card");

    delivery.reset();

    const freshState = cardState("fresh lifecycle");
    expect(delivery.hasCard()).toBe(false);
    await delivery.deliver(freshState);
    expect(send).toHaveBeenNthCalledWith(2, freshState);
    expect(patch).not.toHaveBeenCalled();
  });
});
