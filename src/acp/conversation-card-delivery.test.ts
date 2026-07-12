import { describe, expect, it, vi } from "vitest";
import type { ConversationCardView, OwnershipToken } from "../presenter/conversation-card-view.js";
import type { UnifiedCardState } from "../presenter/presenter.js";
import type {
  DiagnosticCorrelation,
  LifecycleDiagnosticEvent,
  LifecycleDiagnosticSink,
} from "./lifecycle-diagnostics.js";
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

function ownerToken(value: string): OwnershipToken {
  return value as OwnershipToken;
}

function correlation(ownerSequence: number): DiagnosticCorrelation {
  return {
    runtimeSequence: 1,
    promptSequence: 2,
    segmentSequence: 3,
    ownerSequence,
  };
}

function startingView(text = "route"): ConversationCardView {
  return {
    kind: "starting",
    header: "preparing",
    entries: [],
    profile: null,
    route: { c: text },
  };
}

function archivedView(text = "done"): Extract<ConversationCardView, { kind: "archived" }> {
  return {
    kind: "archived",
    entries: [{ kind: "text", text }],
    summary: text,
    route: { c: "route" },
  };
}

function promptToken(value: string) {
  return value as import("../presenter/conversation-card-view.js").PromptToken;
}

function segmentToken(value: string) {
  return value as import("../presenter/conversation-card-view.js").SegmentToken;
}

function permissionToken(value: string) {
  return value as import("../presenter/conversation-card-view.js").PermissionToken;
}

function diagnosticSink(): LifecycleDiagnosticSink & { events: LifecycleDiagnosticEvent[] } {
  const events: LifecycleDiagnosticEvent[] = [];
  return { events, record: (event) => events.push(event) };
}

describe("ConversationCardDelivery", () => {
  it("registers a supplied semantic owner and adopts a card for immutable view delivery", async () => {
    const sink = diagnosticSink();
    const sendView = vi.fn(async () => "unexpected-card");
    const patchView = vi.fn(async () => true);
    const delivery = new ConversationCardDelivery(
      transport(),
      sink,
      () => ownerToken("generated-owner"),
      { sendView, patchView },
    );
    const owner = ownerToken("owner-1");
    const view = startingView();

    expect(delivery.createOwner({ messageSequence: 1 }, correlation(1), owner)).toBe(owner);
    expect(delivery.adopt(owner, "card-1")).toBe("adopted");
    await expect(delivery.deliver(owner, view)).resolves.toEqual({
      outcome: "visible",
      cardId: "card-1",
    });

    expect(patchView).toHaveBeenCalledExactlyOnceWith("card-1", view);
    expect(sendView).not.toHaveBeenCalled();
    expect(sink.events).toEqual([
      {
        category: "delivery",
        correlation: correlation(1),
        operation: "adopt",
        outcome: "visible",
      },
      {
        category: "delivery",
        correlation: correlation(1),
        operation: "patch",
        outcome: "pending",
      },
      {
        category: "delivery",
        correlation: correlation(1),
        operation: "patch",
        outcome: "visible",
      },
    ]);
  });

  it("closes an owner synchronously so a detached successor proceeds while its patch hangs", async () => {
    const oldPatch = deferred<boolean>();
    const sendView = vi.fn(async () => "successor-card");
    const patchView = vi.fn(() => oldPatch.promise);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView, patchView },
    );
    const oldOwner = delivery.createOwner(
      { messageSequence: 1 },
      correlation(1),
      ownerToken("old"),
    );
    delivery.adopt(oldOwner, "old-card");
    const running = delivery.deliver(oldOwner, startingView("running"));
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(1));

    const successor = delivery.close(
      oldOwner,
      archivedView(),
      correlation(2),
      ownerToken("successor"),
    );
    await expect(delivery.deliver(oldOwner, startingView("stale"))).resolves.toEqual({
      outcome: "skipped",
    });
    await expect(delivery.deliver(successor, startingView("fresh"))).resolves.toEqual({
      outcome: "visible",
      cardId: "successor-card",
    });

    expect(sendView).toHaveBeenNthCalledWith(1, archivedView());
    expect(sendView).toHaveBeenNthCalledWith(2, startingView("fresh"));
    oldPatch.resolve(true);
    await expect(running).resolves.toEqual({ outcome: "skipped" });
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(2));
    expect(patchView).toHaveBeenNthCalledWith(2, "old-card", archivedView());
    expect(sendView).toHaveBeenCalledTimes(2);
  });

  it("submits terminal close immediately instead of waiting behind a hung queued patch", async () => {
    const hungPatch = deferred<boolean>();
    const sendView = vi.fn(async () => "terminal-card");
    const patchView = vi
      .fn()
      .mockImplementationOnce(() => hungPatch.promise)
      .mockResolvedValueOnce(true);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView, patchView },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "card");
    const waiting = delivery.deliver(owner, {
      kind: "active",
      header: "waiting",
      entries: [],
      profile: null,
      cancelAction: {
        p: promptToken("prompt"),
        s: segmentToken("segment"),
        a: "action" as import("../presenter/conversation-card-view.js").ActionToken,
      },
      route: { c: "route" },
    });
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(1));

    delivery.close(owner, archivedView("terminal wins"), correlation(2), ownerToken("next"));
    await vi.waitFor(() => expect(sendView).toHaveBeenCalledTimes(1));
    expect(sendView).toHaveBeenCalledWith(archivedView("terminal wins"));

    hungPatch.resolve(true);
    await expect(waiting).resolves.toEqual({ outcome: "skipped" });
  });

  it("reasserts terminal after an older in-flight patch completes last", async () => {
    const hungPatch = deferred<boolean>();
    const visibleState: ConversationCardView[] = [];
    const patchView = vi.fn(async (_cardId: string, view: ConversationCardView) => {
      if (view.kind === "active") await hungPatch.promise;
      visibleState.splice(0, visibleState.length, view);
      return true;
    });
    const sendView = vi.fn(async (view: ConversationCardView) => {
      visibleState.splice(0, visibleState.length, view);
      return "terminal-card";
    });
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView, patchView },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "card");
    const running = delivery.deliver(owner, {
      kind: "active",
      header: "waiting",
      entries: [],
      profile: null,
      cancelAction: {
        p: promptToken("prompt"),
        s: segmentToken("segment"),
        a: "action" as import("../presenter/conversation-card-view.js").ActionToken,
      },
      route: { c: "route" },
    });
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(1));
    delivery.close(owner, archivedView("terminal"), correlation(2), ownerToken("next"));
    await vi.waitFor(() => expect(visibleState.at(-1)?.kind).toBe("archived"));

    hungPatch.resolve(true);
    await running;
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(2));
    expect(visibleState.at(-1)?.kind).toBe("archived");
  });

  it("does not reuse a card while an old conversation patch is in flight for permission handoff", async () => {
    const hungPatch = deferred<boolean>();
    const patchView = vi.fn(() => hungPatch.promise);
    const patchPermission = vi.fn(async () => true);
    const sendPermission = vi.fn(async () => "permission-card");
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(), patchView },
      { patchPermission, sendPermission, reconcilePermissionArtifact: vi.fn() },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "card");
    const old = delivery.deliver(owner, startingView("old"));
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledOnce());

    await expect(
      delivery.handoffToPermission(owner, {
        promptToken: promptToken("prompt"),
        segmentToken: segmentToken("segment"),
        permissionToken: permissionToken("permission"),
        permission: {},
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ outcome: "sent_fresh", permissionCardId: "permission-card" });
    expect(patchPermission).not.toHaveBeenCalled();
    hungPatch.resolve(true);
    await old;
  });

  it("rejects permission handoff from an already closed owner", async () => {
    const sendPermission = vi.fn(async () => "ghost");
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(async () => "terminal"), patchView: vi.fn() },
      { patchPermission: vi.fn(), sendPermission, reconcilePermissionArtifact: vi.fn() },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.close(owner, archivedView(), correlation(2), ownerToken("next"));

    await expect(
      delivery.handoffToPermission(owner, {
        promptToken: promptToken("prompt"),
        segmentToken: segmentToken("segment"),
        permissionToken: permissionToken("permission"),
        permission: {},
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ outcome: "failed" });
    expect(sendPermission).not.toHaveBeenCalled();
  });

  it("freezes every semantic transport boundary before queued work can observe mutation", async () => {
    const firstPatch = deferred<boolean>();
    const patchView = vi
      .fn()
      .mockImplementationOnce(() => firstPatch.promise)
      .mockResolvedValueOnce(true);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(async () => "card"), patchView },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "card");
    const blocking = delivery.deliver(owner, startingView("block"));
    await vi.waitFor(() => expect(patchView).toHaveBeenCalledTimes(1));
    const mutable = startingView("original") as {
      route: { c: string };
    };

    const queued = delivery.deliver(owner, mutable);
    mutable.route.c = "mutated";
    firstPatch.resolve(true);

    await blocking;
    await queued;
    expect(patchView).toHaveBeenNthCalledWith(2, "card", startingView("original"));
  });

  it("retries a rejected permission reuse exactly once with a fresh send", async () => {
    const patchPermission = vi.fn(async () => false);
    const sendPermission = vi.fn(async () => "permission-card");
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(), patchView: vi.fn() },
      {
        patchPermission,
        sendPermission,
        reconcilePermissionArtifact: vi.fn(),
      },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "idle-card");
    const request = {
      promptToken: promptToken("prompt"),
      segmentToken: segmentToken("segment"),
      permissionToken: permissionToken("permission"),
      permission: { title: "original", options: [{ id: "allow" }] },
      isCurrent: () => true,
    };

    await expect(delivery.handoffToPermission(owner, request)).resolves.toEqual({
      outcome: "sent_fresh",
      permissionCardId: "permission-card",
    });
    expect(patchPermission).toHaveBeenCalledExactlyOnceWith("idle-card", request);
    expect(sendPermission).toHaveBeenCalledExactlyOnceWith(request);
    await expect(delivery.deliver(owner, startingView())).resolves.toEqual({ outcome: "skipped" });
  });

  it("returns explicit permission reconciliation when finish wins a deferred fresh send", async () => {
    const pendingPermission = deferred<string | null>();
    let current = true;
    const sendPermission = vi.fn(() => pendingPermission.promise);
    const reconcilePermissionArtifact = vi.fn(async () => undefined);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(), patchView: vi.fn() },
      {
        patchPermission: vi.fn(),
        sendPermission,
        reconcilePermissionArtifact,
      },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    const request = {
      promptToken: promptToken("prompt"),
      segmentToken: segmentToken("segment"),
      permissionToken: permissionToken("permission"),
      permission: { title: "permission" },
      isCurrent: () => current,
    };

    const handoff = delivery.handoffToPermission(owner, request);
    await vi.waitFor(() => expect(sendPermission).toHaveBeenCalledTimes(1));
    current = false;
    pendingPermission.resolve("late-permission-card");

    await expect(handoff).resolves.toEqual({
      outcome: "superseded",
      permissionCardId: "late-permission-card",
      reconciliation: {
        type: "reconcile_permission_artifact",
        cardId: "late-permission-card",
        promptToken: request.promptToken,
        permissionToken: request.permissionToken,
        reason: "stale_handoff",
      },
    });
    expect(reconcilePermissionArtifact).toHaveBeenCalledExactlyOnceWith(
      "late-permission-card",
      request,
    );
  });

  it("reports a fresh permission send failure without implicit retries", async () => {
    const sendPermission = vi.fn(async () => null);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(), patchView: vi.fn() },
      {
        patchPermission: vi.fn(),
        sendPermission,
        reconcilePermissionArtifact: vi.fn(),
      },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));

    await expect(
      delivery.handoffToPermission(owner, {
        promptToken: promptToken("prompt"),
        segmentToken: segmentToken("segment"),
        permissionToken: permissionToken("permission"),
        permission: {},
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ outcome: "failed" });
    expect(sendPermission).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a closed owner token", () => {
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView: vi.fn(), patchView: vi.fn() },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.close(owner, archivedView(), correlation(2), ownerToken("successor"));

    expect(() =>
      delivery.createOwner({ messageSequence: 2 }, correlation(3), ownerToken("owner")),
    ).toThrow("ownership token has already been registered");
  });

  it("reports patch rejection, replacement failure, and a later independent retry", async () => {
    const sink = diagnosticSink();
    const sendView = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("replacement");
    const patchView = vi.fn(async () => false);
    const delivery = new ConversationCardDelivery(
      transport(),
      sink,
      () => ownerToken("generated"),
      { sendView, patchView },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    delivery.adopt(owner, "rejected-card");

    await expect(delivery.deliver(owner, startingView("failed"))).resolves.toEqual({
      outcome: "pending",
    });
    await expect(delivery.deliver(owner, startingView("newest"))).resolves.toEqual({
      outcome: "visible",
      cardId: "replacement",
    });
    expect(sendView).toHaveBeenCalledTimes(2);
    expect(sendView).toHaveBeenNthCalledWith(2, startingView("newest"));
    expect(sink.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "patch", outcome: "rejected" }),
        expect.objectContaining({ operation: "send", outcome: "failed" }),
        expect.objectContaining({ operation: "send", outcome: "visible" }),
      ]),
    );
  });

  it("reports a stale successful send and reconciles it without changing successor ownership", async () => {
    const oldSend = deferred<string | null>();
    const sendView = vi
      .fn()
      .mockImplementationOnce(() => oldSend.promise)
      .mockResolvedValue("successor-card");
    const patchView = vi.fn(async () => true);
    const delivery = new ConversationCardDelivery(
      transport(),
      diagnosticSink(),
      () => ownerToken("generated"),
      { sendView, patchView },
    );
    const owner = delivery.createOwner({ messageSequence: 1 }, correlation(1), ownerToken("owner"));
    const sending = delivery.deliver(owner, startingView("old"));
    await vi.waitFor(() => expect(sendView).toHaveBeenCalledTimes(1));
    const successor = delivery.close(
      owner,
      archivedView(),
      correlation(2),
      ownerToken("successor"),
    );
    oldSend.resolve("orphan-card");

    await expect(sending).resolves.toEqual({ outcome: "superseded", cardId: "orphan-card" });
    await delivery.reconcileSuperseded(owner, "orphan-card", {
      kind: "orphaned",
      header: "orphaned",
      entries: [],
      reason: "superseded_send",
      route: { c: "route" },
    });
    expect(patchView).toHaveBeenCalledWith(
      "orphan-card",
      expect.objectContaining({ kind: "orphaned", reason: "superseded_send" }),
    );
    await expect(delivery.deliver(successor, startingView("successor"))).resolves.toEqual({
      outcome: "visible",
      cardId: "successor-card",
    });
  });

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
  ])("does not let queued updates retry a replacement send that %s", async (_, failure) => {
    const replacementSend = deferred<string | null>();
    const send = vi
      .fn()
      .mockResolvedValueOnce("old-card")
      .mockImplementationOnce(() =>
        replacementSend.promise.then((cardId) => {
          if (failure instanceof Error) throw failure;
          return cardId;
        }),
      )
      .mockResolvedValueOnce("new-card");
    const patch = vi.fn(async () => false);
    const delivery = new ConversationCardDelivery({ send, patch });
    await delivery.deliver(cardState("initial"));

    const failedDelivery = delivery.deliver(cardState("failed replacement"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const queuedOne = delivery.deliver(cardState("queued one"));
    const queuedTwo = delivery.deliver(cardState("queued two"));
    replacementSend.resolve(null);

    if (failure instanceof Error) {
      await expect(failedDelivery).rejects.toBe(failure);
    } else {
      await expect(failedDelivery).resolves.toEqual({ outcome: "pending" });
    }
    await expect(queuedOne).resolves.toEqual({ outcome: "skipped" });
    await expect(queuedTwo).resolves.toEqual({ outcome: "skipped" });
    expect(send).toHaveBeenCalledTimes(2);

    const newestState = cardState("newest state on independent retry");
    await expect(delivery.deliver(newestState)).resolves.toEqual({
      outcome: "visible",
      cardId: "new-card",
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(3, newestState);
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

  it("reports current lifecycle delivery work while card creation is in flight", async () => {
    const pendingSend = deferred<string | null>();
    const delivery = new ConversationCardDelivery(
      transport({ send: vi.fn(() => pendingSend.promise) }),
    );

    expect(delivery.hasCardOrPendingDelivery()).toBe(false);
    const inFlight = delivery.deliver(cardState("in flight"));
    expect(delivery.hasCardOrPendingDelivery()).toBe(true);

    pendingSend.resolve(null);
    await expect(inFlight).resolves.toEqual({ outcome: "pending" });
    expect(delivery.hasCardOrPendingDelivery()).toBe(false);
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

  it.each(["reset", "detach"] as const)(
    "%s starts a fresh queue while an old send is still in flight and reports its stale card id",
    async (transition) => {
      const oldSend = deferred<string | null>();
      const send = vi
        .fn()
        .mockImplementationOnce(() => oldSend.promise)
        .mockResolvedValueOnce("fresh-card");
      const patch = vi.fn(async () => true);
      const delivery = new ConversationCardDelivery({ send, patch });
      const oldDelivery = delivery.deliver(cardState("old lifecycle"));
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      delivery[transition]();
      const freshState = cardState("fresh lifecycle");
      await expect(delivery.deliver(freshState)).resolves.toEqual({
        outcome: "visible",
        cardId: "fresh-card",
      });
      expect(send).toHaveBeenNthCalledWith(2, freshState);

      oldSend.resolve("stale-card");
      await expect(oldDelivery).resolves.toEqual({
        outcome: "superseded",
        cardId: "stale-card",
      });
      expect(delivery.takeActiveCardId()).toBe("fresh-card");
    },
  );

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
