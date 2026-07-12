import { describe, expect, it, vi } from "vitest";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { ConversationCardReconciler } from "./conversation-card-reconciler.js";
import { TopicConversationStore } from "./topic-conversation-store.js";
import type {
  ActionToken,
  RequestId,
  ResponseCardId,
  ResponseId,
  ResponseToken,
  TurnId,
} from "./topic-conversation.js";

const logger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function ids() {
  let value = 0;
  const next = (name: string) => `${name}-${++value}`;
  return {
    turn: () => next("turn") as TurnId,
    request: () => next("request") as RequestId,
    response: () => next("response") as ResponseId,
    responseToken: () => next("response-token") as ResponseToken,
    card: () => next("card") as ResponseCardId,
    action: () => next("action") as ActionToken,
  };
}

function accept(store: TopicConversationStore, token: ReturnType<typeof ids>) {
  const responseId = token.response();
  const cardId = token.card();
  store.transaction((topic) =>
    topic.accept({
      turnId: token.turn(),
      request: { id: token.request(), sourceMessageId: "message", content: "request" },
      responseId,
      responseToken: token.responseToken(),
      initialCardId: cardId,
      profile: { agent: "agent", mode: "mode", model: "model", permission: "ask" },
    }),
  );
  return { responseId, cardId };
}

function fixture(overrides: Partial<LarkPresenter> = {}) {
  const sent: unknown[] = [];
  const patched: unknown[] = [];
  const store = new TopicConversationStore();
  const presenter = {
    sendConversationCard: vi.fn(async (_anchor, view) => {
      sent.push(view);
      return `external-${sent.length}`;
    }),
    updateConversationCard: vi.fn(async (_id, view) => {
      patched.push(view);
      return true;
    }),
    ...overrides,
  } as unknown as LarkPresenter;
  const evicted: Array<{ cardId: ResponseCardId; kind: string }> = [];
  const reconciler = new ConversationCardReconciler({
    store,
    presenter,
    logger,
    route: { c: "chat", th: "thread" },
    showCancelButton: true,
    retryDelayMs: 0,
    onSettledImmutable: (responseId, cardId, kind) => {
      evicted.push({ cardId, kind });
      if (kind === "intermediate") {
        store.transactionIfChanged((topic) => topic.evictSettledIntermediate(responseId, cardId));
      }
    },
  });
  return { store, presenter, reconciler, sent, patched, evicted };
}

describe("ConversationCardReconciler", () => {
  it("drops expired in-flight Permission records from the bounded hot state", async () => {
    const never = new Promise<string | null>(() => undefined);
    const { store, reconciler } = fixture({ sendPermissionRequestCard: vi.fn(() => never) });
    for (let index = 0; index < 5; index += 1) {
      const id = `permission-${index}`;
      const visible = reconciler.presentPermission(id, "message", {
        route: { c: "chat", th: "thread" },
        promptToken: `prompt-${index}` as never,
        permissionToken: `token-${index}` as never,
        requestId: id,
        title: "Permission",
        toolKind: "other",
        toolTitle: "Tool",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      });
      await vi.waitFor(() => expect(store.deliveryState.permissions[id]?.status).toBe("sending"));
      reconciler.expirePermission(id, "expired");
      await expect(visible).resolves.toBeNull();
    }
    expect(Object.keys(store.deliveryState.permissions)).toHaveLength(0);
  });

  it("archives an old Card whose initial active send completes after rotation", async () => {
    let releaseOldSend!: () => void;
    const oldSendBlocked = new Promise<void>((resolve) => {
      releaseOldSend = resolve;
    });
    const patches: Array<{ id: string; view: unknown }> = [];
    const sentViews: unknown[] = [];
    let sends = 0;
    const { store, reconciler } = fixture({
      sendConversationCard: vi.fn(async (_anchor, view) => {
        sends += 1;
        const sequence = sends;
        sentViews.push(view);
        if (sequence === 1) await oldSendBlocked;
        return `external-${sequence}`;
      }),
      updateConversationCard: vi.fn(async (id, view) => {
        patches.push({ id, view });
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await vi.waitFor(() => expect(sends).toBe(1));

    const nextCardId = token.card();
    reconciler.registerAnchor(nextCardId, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, nextCardId, "content_rotation", token.action()),
    );
    releaseOldSend();
    await reconciler.flush();

    expect(
      patches.some(
        ({ id, view }) => id === "external-1" && (view as { kind?: string }).kind === "archived",
      ),
    ).toBe(true);
    expect(
      sentViews.some(
        (view) =>
          (view as { kind?: string }).kind === "active" && "cancelAction" in (view as object),
      ),
    ).toBe(true);
  });

  it("expires a Permission artifact even when send completes after revocation", async () => {
    let releaseSend!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const expire = vi.fn(async () => undefined);
    const { reconciler } = fixture({
      sendPermissionRequestCard: vi.fn(async () => {
        await blocked;
        return "permission-external";
      }),
      expirePermissionCard: expire,
    });
    const visible = reconciler.presentPermission("permission-1", "message", {
      route: { c: "chat" },
      promptToken: "prompt" as never,
      permissionToken: "permission" as never,
      requestId: "request",
      title: "Permission",
      toolKind: "tool",
      toolTitle: "Tool",
      options: [{ id: "allow", label: "Allow" }],
    });
    reconciler.expirePermission("permission-1", "权限请求已失效");
    await expect(visible).resolves.toBeNull();
    releaseSend();

    await vi.waitFor(() =>
      expect(expire).toHaveBeenCalledWith("permission-external", "权限请求已失效"),
    );
    expect(reconciler.pendingPermissionCount).toBe(0);
  });

  it("re-projects the latest state after an older effect completes", async () => {
    let releaseSend!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const views: unknown[] = [];
    const { store, reconciler } = fixture({
      sendConversationCard: vi.fn(async (_anchor, view) => {
        views.push(view);
        await blocked;
        return "external";
      }),
      updateConversationCard: vi.fn(async (_id, view) => {
        views.push(view);
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    releaseSend();
    await reconciler.flush();

    expect(views.at(-1)).toMatchObject({ kind: "active", cancelAction: expect.any(Object) });
    const record = reconciler.deliveryRecords.find((item) => item.cardId === a.cardId);
    expect(record?.status).toBe("settled");
    expect(record?.deliveredRevision).toBe(record?.desiredRevision);
  });

  it("dirties the current tail and displays a warning when old-tail retirement fails", async () => {
    const patched: unknown[] = [];
    let failArchived = true;
    const { store, reconciler } = fixture({
      updateConversationCard: vi.fn(async (_id, view) => {
        patched.push(view);
        if ((view as { kind?: string }).kind === "archived" && failArchived) {
          failArchived = false;
          return false;
        }
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    const nextCardId = token.card();
    reconciler.registerAnchor(nextCardId, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, nextCardId, "content_rotation", token.action()),
    );
    await reconciler.flush();

    expect(
      patched.some(
        (view) =>
          (view as { kind?: string }).kind === "active" &&
          JSON.stringify(view).includes("上一张 Card 更新失败"),
      ),
    ).toBe(true);
  });

  it("retains a settled terminal tail until a late old-tail failure warning is delivered", async () => {
    let releaseOldArchive!: () => void;
    const oldArchiveBlocked = new Promise<void>((resolve) => {
      releaseOldArchive = resolve;
    });
    let oldArchiveStarted = false;
    let oldArchiveAttempts = 0;
    const terminalWrites: unknown[] = [];
    const { store, reconciler } = fixture({
      updateConversationCard: vi.fn(async (id, view) => {
        if (id === "external-1" && (view as { kind?: string }).kind === "archived") {
          oldArchiveAttempts += 1;
          if (oldArchiveAttempts === 1) {
            oldArchiveStarted = true;
            await oldArchiveBlocked;
          }
          return false;
        }
        if ((view as { kind?: string }).kind === "terminal") terminalWrites.push(view);
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    const terminalCard = token.card();
    reconciler.registerAnchor(terminalCard, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, terminalCard, "content_rotation", token.action()),
    );
    await vi.waitFor(() => expect(oldArchiveStarted).toBe(true));
    store.transaction((topic) => topic.seal(a.responseId, "complete"));
    await vi.waitFor(() =>
      expect(
        reconciler.deliveryRecords.find((record) => record.cardId === terminalCard)?.status,
      ).toBe("settled"),
    );

    releaseOldArchive();
    await reconciler.flush();
    expect(
      terminalWrites.some((view) => JSON.stringify(view).includes("上一张 Card 更新失败")),
    ).toBe(true);
    expect(Object.values(store.deliveryState.diagnostics)).toHaveLength(0);
  });

  it("does not let a stale tail consume a warning before the current tail displays it", async () => {
    let releaseStaleWarning!: () => void;
    const staleWarningBlocked = new Promise<void>((resolve) => {
      releaseStaleWarning = resolve;
    });
    let staleWarningStarted = false;
    let currentWarningFailures = 0;
    const successfulCurrentViews: unknown[] = [];
    let sends = 0;
    const { store, reconciler } = fixture({
      sendConversationCard: vi.fn(async (_anchor, view) => {
        sends += 1;
        if (sends <= 2) return `external-${sends}`;
        if (JSON.stringify(view).includes("上一张 Card 更新失败")) {
          currentWarningFailures += 1;
          if (currentWarningFailures <= 2) return null;
          successfulCurrentViews.push(view);
          return "external-current";
        }
        return `external-${sends}`;
      }),
      updateConversationCard: vi.fn(async (id, view) => {
        const warned = JSON.stringify(view).includes("上一张 Card 更新失败");
        if (id === "external-1" && (view as { kind?: string }).kind === "archived") {
          return false;
        }
        if (id === "external-2" && warned && (view as { kind?: string }).kind === "active") {
          staleWarningStarted = true;
          await staleWarningBlocked;
          return true;
        }
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    const second = token.card();
    reconciler.registerAnchor(second, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, second, "content_rotation", token.action()),
    );
    await vi.waitFor(() => expect(staleWarningStarted).toBe(true));

    const third = token.card();
    reconciler.registerAnchor(third, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, third, "content_rotation", token.action()),
    );
    await vi.waitFor(() =>
      expect(reconciler.deliveryRecords.find((record) => record.cardId === third)?.status).toBe(
        "failed",
      ),
    );
    releaseStaleWarning();
    await reconciler.flush();

    expect(successfulCurrentViews).toHaveLength(1);
    expect(Object.values(store.deliveryState.diagnostics)).toContainEqual(
      expect.objectContaining({ status: "displayed", displayedOnCardId: third }),
    );
  });

  it("moves an undelivered failure warning to a newer tail", async () => {
    let releaseFailure!: () => void;
    const failureBlocked = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const patched: unknown[] = [];
    let archivedAttempts = 0;
    const { store, reconciler } = fixture({
      updateConversationCard: vi.fn(async (_id, view) => {
        patched.push(view);
        if ((view as { kind?: string }).kind === "archived") {
          archivedAttempts += 1;
          if (archivedAttempts === 1) await failureBlocked;
          return false;
        }
        return true;
      }),
    });
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    const second = token.card();
    reconciler.registerAnchor(second, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, second, "content_rotation", token.action()),
    );
    const third = token.card();
    reconciler.registerAnchor(third, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, third, "content_rotation", token.action()),
    );
    releaseFailure();
    await reconciler.flush();

    const warned = patched.filter(
      (view) =>
        (view as { kind?: string }).kind === "active" &&
        JSON.stringify(view).includes("上一张 Card 更新失败"),
    );
    expect(warned.length).toBeGreaterThan(0);
    expect(reconciler.deliveryRecords).toHaveLength(1);
    expect(reconciler.deliveryRecords[0]?.cardId).toBe(third);
  });

  it("keeps the settled working set bounded across repeated rotations", async () => {
    const { store, reconciler } = fixture();
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    for (let index = 0; index < 10; index += 1) {
      const nextCardId = token.card();
      reconciler.registerAnchor(nextCardId, "message");
      store.transaction((topic) =>
        topic.rotateTail(a.responseId, nextCardId, "content_rotation", token.action()),
      );
      await reconciler.flush();
    }

    const response = store.snapshot.turns.find(
      (turn) => turn.response.id === a.responseId,
    )?.response;
    expect(response?.cards).toHaveLength(1);
    expect(response?.cards[0]?.isTail).toBe(true);
    expect(reconciler.deliveryRecords).toHaveLength(1);
  });

  it("marks a settled intermediate Card as reclaimable", async () => {
    const { store, reconciler, evicted } = fixture();
    const token = ids();
    const a = accept(store, token);
    reconciler.registerAnchor(a.cardId, "message");
    store.transaction((topic) => topic.prepare(a.responseId));
    store.transaction((topic) => topic.activate(a.responseId, token.action()));
    await reconciler.flush();

    const nextCardId = token.card();
    reconciler.registerAnchor(nextCardId, "message");
    store.transaction((topic) =>
      topic.rotateTail(a.responseId, nextCardId, "content_rotation", token.action()),
    );
    await reconciler.flush();

    expect(evicted).toContainEqual({ cardId: a.cardId, kind: "intermediate" });
  });
});
