import { describe, expect, it, vi } from "vitest";
import type { LarkLogger } from "../logger/logger.js";
import { utf8ByteLength } from "../presenter/card-text-budget.js";
import { conversationCardBudget } from "./conversation-card-budget.js";
import type { LarkPresenter, PermissionCardView } from "../presenter/presenter.js";
import type {
  ActionToken,
  PermissionToken,
  RequestId,
  ResponseCardId,
  ResponseId,
  ResponseToken,
  TurnId,
} from "./topic-conversation.js";
import {
  TopicConversationSession,
  type TopicConversationTokenFactory,
} from "./topic-conversation-session.js";

const logger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function sequentialTokens(): TopicConversationTokenFactory {
  const counts = new Map<string, number>();
  const next = (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return `${name}-${count}`;
  };
  return {
    turn: () => next("turn") as TurnId,
    request: () => next("request") as RequestId,
    response: () => next("response") as ResponseId,
    responseToken: () => next("response-token") as ResponseToken,
    card: () => next("card") as ResponseCardId,
    action: () => next("action") as ActionToken,
    permission: () => next("permission") as PermissionToken,
    permissionRequest: () => next("permission-request"),
  };
}

function fixture(
  overrides: Partial<LarkPresenter> = {},
  sessionOverrides: Partial<ConstructorParameters<typeof TopicConversationSession>[0]> = {},
) {
  const sent: unknown[] = [];
  const patched: unknown[] = [];
  const permissions: PermissionCardView[] = [];
  const presenter = {
    sendConversationCard: vi.fn(async (_messageId, view) => {
      sent.push(view);
      return `external-card-${sent.length}`;
    }),
    updateConversationCard: vi.fn(async (_cardId, view) => {
      patched.push(view);
      return true;
    }),
    sendPermissionRequestCard: vi.fn(async (_messageId, view) => {
      permissions.push(view);
      return `permission-card-${permissions.length}`;
    }),
    expirePermissionCard: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LarkPresenter;
  const cancel = vi.fn(async () => undefined);
  const session = new TopicConversationSession({
    presenter,
    logger,
    route: { c: "chat", th: "thread" },
    tokens: sequentialTokens(),
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    onCancelResponse: cancel,
    onPermissionDisplayFailure: cancel,
    ...sessionOverrides,
  });
  return { session, presenter, sent, patched, permissions, cancel };
}

const profile = { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" };

describe("TopicConversationSession", () => {
  it("renders B merged and C interrupting while preserving one batch", async () => {
    const { session, patched, sent } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const b = session.accept({ sourceMessageId: "message-b", content: "B", profile });
    const c = session.accept({ sourceMessageId: "message-c", content: "C", profile });
    await vi.waitFor(() => expect(session.snapshot.pendingBatch?.messages).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        session.snapshot.turns.find((turn) => turn.response.id === b.responseId)?.response.state,
      ).toEqual({ kind: "terminal", outcome: "merged" }),
    );

    expect(session.snapshot.pendingBatch?.carrierResponseId).toBe(c.responseId);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    await vi.waitFor(() =>
      expect(
        patched.some(
          (view) =>
            (view as { kind?: string; header?: string }).kind === "terminal" &&
            (view as { header?: string }).header === "merged",
        ),
      ).toBe(true),
    );
  });

  it("revokes Card Cancel immediately but waits for finishOwner to release execution", async () => {
    const { session, cancel } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    session.accept({ sourceMessageId: "message-b", content: "B", profile });
    const authority = session.snapshot.cancelAuthority;
    if (authority.kind !== "cancel") throw new Error("missing cancel authority");

    expect(
      session.consumeCancel({
        responseToken: a.responseToken,
        cardId: authority.cardId,
        actionToken: authority.token,
      }),
    ).toBe("accepted");
    expect(session.snapshot.executionOwnerResponseId).toBe(a.responseId);
    expect(session.snapshot.cancelAuthority).toEqual({ kind: "none" });
    expect(cancel).toHaveBeenCalledWith(a.responseId);

    const handoff = await session.finishOwner("cancelled");
    expect(handoff.pendingBatch).toHaveLength(1);
    expect(session.snapshot.executionOwnerResponseId).toBeNull();
    expect(session.snapshot.pendingBatch).toBeNull();
  });

  it("commits the sealed carrier synchronously before terminal Card I/O", async () => {
    let releasePatch!: () => void;
    const patchBlocked = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    const { session } = fixture({
      updateConversationCard: vi.fn(async (_cardId, view) => {
        if ((view as { kind?: string }).kind === "terminal") await patchBlocked;
        return true;
      }),
    });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const c = session.accept({ sourceMessageId: "message-c", content: "C", profile });
    const committed: ResponseId[] = [];
    const finishing = session.finishOwner("interrupted", (handoff) =>
      committed.push(handoff.carrierResponseId),
    );
    expect(committed).toEqual([c.responseId]);
    expect(session.snapshot.pendingBatch).toBeNull();
    const d = session.accept({ sourceMessageId: "message-d", content: "D", profile });
    expect(d.responseId).not.toBe(c.responseId);
    releasePatch();
    await finishing;
  });

  it("expires Permission immediately when a new message arrives", async () => {
    const { session, presenter } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const permissionPromise = session.requestPermission(a.responseId, {
      sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await vi.waitFor(() => expect(session.snapshot.permission?.status).toBe("current"));

    session.accept({ sourceMessageId: "message-b", content: "B", profile });

    await expect(permissionPromise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(session.snapshot.permission?.status).toBe("expired");
    expect(presenter.expirePermissionCard).toHaveBeenCalled();
  });

  it("Card Cancel while awaiting Permission revokes both authorities immediately", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const permission = session.requestPermission(a.responseId, {
      sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await vi.waitFor(() => expect(session.snapshot.permission?.status).toBe("current"));
    const authority = session.snapshot.cancelAuthority;
    if (authority.kind !== "cancel") throw new Error("missing cancel authority");
    expect(
      session.consumeCancel({
        responseToken: a.responseToken,
        cardId: authority.cardId,
        actionToken: authority.token,
      }),
    ).toBe("accepted");
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(session.snapshot.permission?.status).toBe("expired");
    expect(session.snapshot.cancelAuthority).toEqual({ kind: "none" });
    expect(session.snapshot.executionOwnerResponseId).toBe(a.responseId);
  });

  it("permission timeout resolves even while Permission Card send remains in flight", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string | null>(() => undefined);
      const { session } = fixture(
        { sendPermissionRequestCard: vi.fn(() => never) },
        { permissionTimeoutMs: 10 },
      );
      const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
      await session.prepare(a.responseId, profile);
      await session.activate(a.responseId);
      const permission = session.requestPermission(a.responseId, {
        sessionId: "session",
        toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      expect(session.snapshot.permission?.status).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late null Permission send cannot overwrite an already expired authority", async () => {
    let release!: (value: string | null) => void;
    const blocked = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const { session, cancel } = fixture({ sendPermissionRequestCard: vi.fn(() => blocked) });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const permission = session.requestPermission(a.responseId, {
      sessionId: "session",
      toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    session.cancelPendingPermissions();
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    release(null);
    await vi.waitFor(() => expect(session.snapshot.permission?.status).toBe("expired"));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("permission timeout revokes domain authority and resumes the Response", async () => {
    vi.useFakeTimers();
    try {
      const { session } = fixture({}, { permissionTimeoutMs: 10 });
      const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
      await session.prepare(a.responseId, profile);
      await session.activate(a.responseId);
      const permission = session.requestPermission(a.responseId, {
        sessionId: "session",
        toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      expect(session.snapshot.permission?.status).toBe("expired");
      expect(
        session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response.state,
      ).toMatchObject({ kind: "in_progress", phase: "active" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries terminal acknowledgement removal after a false transport result", async () => {
    const remove = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { session } = fixture({}, { acknowledgement: { add: vi.fn(), remove } });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    session.attachAcknowledgement(a.responseId, "reaction-a");
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.finishOwner("complete");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));

    session.attachAcknowledgement(a.responseId, "reaction-a");

    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  });

  it("auto-resolves permission policy without displaying a Permission Card", async () => {
    const allow = fixture({}, { permissionMode: () => "alwaysAllow" });
    const a = allow.session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await allow.session.prepare(a.responseId, profile);
    await allow.session.activate(a.responseId);
    await expect(
      allow.session.requestPermission(a.responseId, {
        sessionId: "session",
        toolCall: { toolCallId: "tool", title: "Run", kind: "execute", status: "pending" },
        options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
      }),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(allow.permissions).toEqual([]);
  });

  it("keeps acknowledgement through visible Cards and removes it when the Response terminates", async () => {
    const acknowledgement = { add: vi.fn(), remove: vi.fn(async () => true) };
    const { session } = fixture({}, { acknowledgement });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    session.attachAcknowledgement(a.responseId, "reaction-a");
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.flushPresentation();
    await session.rotate(a.responseId, "size");
    await session.flushPresentation();

    expect(acknowledgement.remove).not.toHaveBeenCalled();

    await session.finishOwner("complete");
    await vi.waitFor(() =>
      expect(acknowledgement.remove).toHaveBeenCalledExactlyOnceWith("message-a", "reaction-a"),
    );
  });

  it.each(["complete", "failed", "interrupted", "cancelled"] as const)(
    "removes acknowledgement when a Response becomes terminal(%s)",
    async (outcome) => {
      const acknowledgement = { add: vi.fn(), remove: vi.fn(async () => true) };
      const { session } = fixture({}, { acknowledgement });
      const response = session.accept({
        sourceMessageId: `message-${outcome}`,
        content: outcome,
        profile,
      });
      session.attachAcknowledgement(response.responseId, `reaction-${outcome}`);
      await session.prepare(response.responseId, profile);
      await session.activate(response.responseId);
      await session.finishOwner(outcome);

      await vi.waitFor(() =>
        expect(acknowledgement.remove).toHaveBeenCalledExactlyOnceWith(
          `message-${outcome}`,
          `reaction-${outcome}`,
        ),
      );
    },
  );

  it("removes a merged Response acknowledgement but keeps the current carrier acknowledgement", async () => {
    const acknowledgement = { add: vi.fn(), remove: vi.fn(async () => true) };
    const { session } = fixture({}, { acknowledgement });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const b = session.accept({ sourceMessageId: "message-b", content: "B", profile });
    session.attachAcknowledgement(b.responseId, "reaction-b");
    const c = session.accept({ sourceMessageId: "message-c", content: "C", profile });
    session.attachAcknowledgement(c.responseId, "reaction-c");

    await vi.waitFor(() =>
      expect(acknowledgement.remove).toHaveBeenCalledExactlyOnceWith("message-b", "reaction-b"),
    );
    expect(acknowledgement.remove).not.toHaveBeenCalledWith("message-c", "reaction-c");
  });

  it("removes a Reaction attached after its Response already terminated", async () => {
    const acknowledgement = { add: vi.fn(), remove: vi.fn(async () => true) };
    const { session } = fixture({}, { acknowledgement });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.finishOwner("complete");

    session.attachAcknowledgement(a.responseId, "reaction-a");

    await vi.waitFor(() =>
      expect(acknowledgement.remove).toHaveBeenCalledExactlyOnceWith("message-a", "reaction-a"),
    );
  });

  it("keeps every oversized text Card within the 20 KB hard limit", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    const text = "x".repeat(60_000);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
    const response = session.snapshot.turns.find(
      (turn) => turn.response.id === a.responseId,
    )?.response;
    expect(response?.cards).toHaveLength(3);
    expect(response?.cards.at(-1)).toMatchObject({ isTail: true });
    const entries = response?.cards.flatMap((card) => card.entries) ?? [];
    expect(entries).toHaveLength(3);
    expect(
      entries.every(
        (entry) =>
          entry.kind === "text" &&
          utf8ByteLength(entry.text) <= conversationCardBudget.maxContentBytes,
      ),
    ).toBe(true);
    expect(entries.map((entry) => (entry.kind === "text" ? entry.text : "")).join("")).toBe(text);
    expect(session.snapshot.cancelAuthority).toMatchObject({
      kind: "cancel",
      responseId: a.responseId,
      cardId: response?.cards.at(-1)?.id,
    });
  });

  it("rotates before a new complete text element without splitting streamed prose", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    for (let index = 0; index < 18; index += 1) {
      await session.applyAgentUpdate(a.responseId, {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${index}`,
        title: `Tool ${index}`,
        kind: "read",
        status: "pending",
      });
      await session.applyAgentUpdate(a.responseId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `tool-${index}`,
        status: "completed",
      });
    }

    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "共享" },
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "库代码已完成首轮实现。" },
    });

    const cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(2);
    expect(cards?.[0]?.entries).toHaveLength(18);
    expect(cards?.[1]?.entries).toEqual([{ kind: "text", text: "共享库代码已完成首轮实现。" }]);
  });

  it("does not rotate at 8 KiB until the 20 KB hard limit requires a split", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x".repeat(8_000) },
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "y".repeat(1_000) },
    });

    let cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.entries).toEqual([
      { kind: "text", text: `${"x".repeat(8_000)}${"y".repeat(1_000)}` },
    ]);

    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-after-text",
      title: "Run tests",
      kind: "execute",
      status: "pending",
    });

    cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.entries).toEqual([
      { kind: "text", text: `${"x".repeat(8_000)}${"y".repeat(1_000)}` },
      {
        kind: "tool",
        toolCallId: "tool-after-text",
        title: "Run tests",
        status: "in_progress",
      },
    ]);
  });

  it("splits a long text after the last sentence before the Card reaches 20 KB", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "prefix",
      title: "x".repeat(7_988),
      kind: "read",
      status: "pending",
    });
    const firstSentence = `${"a".repeat(10_000)}。`;
    const secondSentence = `${"b".repeat(12_000)}。`;
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: firstSentence + secondSentence },
    });

    const cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(2);
    expect(cards?.[0]?.entries.at(-1)).toEqual({ kind: "text", text: firstSentence });
    expect(cards?.[1]?.entries).toEqual([{ kind: "text", text: secondSentence }]);
    expect(
      cards?.every(
        (card) =>
          card.entries.reduce(
            (total, entry) =>
              total +
              (entry.kind === "tool"
                ? utf8ByteLength(`**tool**: ${entry.title}`)
                : utf8ByteLength(entry.text)),
            0,
          ) <= conversationCardBudget.maxContentBytes,
      ),
    ).toBe(true);
  });

  it("updates the current Tool activity title when an update omits status", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Tool",
      kind: "read",
      status: "pending",
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Reading current file",
    });

    expect(
      session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response.state,
    ).toMatchObject({
      kind: "in_progress",
      activity: {
        kind: "calling_tool",
        toolCallId: "tool-1",
        title: "Reading current file",
      },
    });
  });

  it("does not let an old Tool completion clear a newer current Tool", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "First tool",
      kind: "execute",
      status: "pending",
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-2",
      title: "Current tool",
      kind: "read",
      status: "pending",
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });

    expect(
      session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response.state,
    ).toMatchObject({
      kind: "in_progress",
      activity: { kind: "calling_tool", toolCallId: "tool-2", title: "Current tool" },
    });
  });

  it("updates one tool element in place and preserves its title", async () => {
    const { session } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Viewing AccountActions.java",
      kind: "read",
      status: "pending",
    });
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });

    expect(
      session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response.cards[0]
        ?.entries,
    ).toEqual([
      {
        kind: "tool",
        toolCallId: "tool-1",
        title: "Viewing AccountActions.java",
        status: "completed",
      },
    ]);
  });

  it("retains an archived running tool until its terminal update is delivered", async () => {
    const { session, patched } = fixture();
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call",
      toolCallId: "slow-tool",
      title: "Long-running check",
      kind: "execute",
      status: "pending",
    });
    await session.rotate(a.responseId, "tool_boundary");
    await session.flushPresentation();

    let cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(2);
    expect(cards?.[0]?.entries).toContainEqual(
      expect.objectContaining({ toolCallId: "slow-tool", status: "continued" }),
    );

    await session.applyAgentUpdate(a.responseId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "slow-tool",
      status: "completed",
    });
    await session.flushPresentation();

    expect(
      patched.some(
        (view) =>
          (view as { kind?: string }).kind === "archived" &&
          JSON.stringify(view).includes('"toolCallId":"slow-tool"') &&
          JSON.stringify(view).includes('"status":"completed"'),
      ),
    ).toBe(true);
    cards = session.snapshot.turns.find((turn) => turn.response.id === a.responseId)?.response
      .cards;
    expect(cards).toHaveLength(1);
  });

  it("reconciles a patch-failure warning onto the current valid tail", async () => {
    const patched: unknown[] = [];
    let failArchived = true;
    const { session } = fixture({
      updateConversationCard: vi.fn(async (_cardId, view) => {
        patched.push(view);
        if ((view as { kind?: string }).kind === "archived" && failArchived) {
          failArchived = false;
          return false;
        }
        return true;
      }),
    });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);
    await session.flushPresentation();
    await session.rotate(a.responseId, "size");
    await session.flushPresentation();

    expect(
      patched.some(
        (view) =>
          (view as { kind?: string }).kind === "active" &&
          JSON.stringify(view).includes("上一张 Card 更新失败"),
      ),
    ).toBe(true);
    const tail = session.snapshot.turns
      .find((turn) => turn.response.id === a.responseId)
      ?.response.cards.at(-1);
    expect(tail?.entries).toEqual([]);
  });

  it("retains only the three most recent delivery-settled terminal Responses", async () => {
    const { session } = fixture();
    for (let index = 0; index < 5; index += 1) {
      const response = session.accept({
        sourceMessageId: `message-${index}`,
        content: `request-${index}`,
        profile,
      });
      await session.prepare(response.responseId, profile);
      await session.activate(response.responseId);
      await session.finishOwner("complete");
      await session.flushPresentation();
    }

    expect(session.snapshot.turns).toHaveLength(3);
    expect(Object.keys(session.deliveryState.cards)).toHaveLength(0);
    expect(session.snapshot.turns.every((turn) => turn.response.state.kind === "terminal")).toBe(
      true,
    );
  });

  it("bounds terminal retention even when every final delivery exhausts retries", async () => {
    const { session } = fixture({ sendConversationCard: vi.fn(async () => null) });
    for (let index = 0; index < 5; index += 1) {
      const response = session.accept({
        sourceMessageId: `message-failed-${index}`,
        content: `request-failed-${index}`,
        profile,
      });
      await session.prepare(response.responseId, profile);
      await session.activate(response.responseId);
      await session.finishOwner("complete");
      await session.flushPresentation();
    }
    expect(session.snapshot.turns).toHaveLength(3);
    expect(Object.keys(session.deliveryState.cards)).toHaveLength(0);
  });

  it("bounds terminal retention when every transport Promise rejects", async () => {
    const { session } = fixture({
      sendConversationCard: vi.fn(async () => {
        throw new Error("transport rejected");
      }),
    });
    for (let index = 0; index < 5; index += 1) {
      const response = session.accept({
        sourceMessageId: `message-rejected-${index}`,
        content: `request-rejected-${index}`,
        profile,
      });
      await session.prepare(response.responseId, profile);
      await session.activate(response.responseId);
      await session.finishOwner("complete");
      await session.flushPresentation();
    }
    expect(session.snapshot.turns).toHaveLength(3);
    expect(Object.keys(session.deliveryState.cards)).toHaveLength(0);
  });

  it("fails Response when mandatory Permission Card is not visible", async () => {
    const { session, cancel } = fixture({
      sendPermissionRequestCard: vi.fn(async () => null),
    });
    const a = session.accept({ sourceMessageId: "message-a", content: "A", profile });
    await session.prepare(a.responseId, profile);
    await session.activate(a.responseId);

    await expect(
      session.requestPermission(a.responseId, {
        sessionId: "session",
        toolCall: { toolCallId: "tool", title: "Edit", kind: "edit", status: "pending" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    const response = session.snapshot.turns.find(
      (turn) => turn.response.id === a.responseId,
    )?.response;
    expect(response?.state).toMatchObject({ kind: "in_progress" });
    expect(session.snapshot.cancelAuthority).toEqual({ kind: "none" });
    expect(cancel).toHaveBeenCalledWith(a.responseId);
    await session.finishOwner("failed");
    const failed = session.snapshot.turns.find(
      (turn) => turn.response.id === a.responseId,
    )?.response;
    expect(failed?.state).toEqual({ kind: "terminal", outcome: "failed" });
    expect(failed?.cards.at(-1)?.entries).toContainEqual({
      kind: "notice",
      text: "权限请求无法显示，正在停止本次执行。",
    });
  });
});
