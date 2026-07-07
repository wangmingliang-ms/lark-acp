import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  CARD_MARKDOWN_ELEMENT_CHAR_LIMIT,
  CARD_MARKDOWN_SOFT_CHAR_LIMIT,
  HummingClient,
} from "./humming-client.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter, UnifiedCardState } from "../presenter/presenter.js";

type RenderOp =
  | { readonly kind: "sendUnified"; readonly state: UnifiedCardState }
  | { readonly kind: "updateUnified"; readonly cardId: string; readonly state: UnifiedCardState }
  | {
      readonly kind: "notice";
      readonly title: string;
      readonly body: string;
      readonly template: string;
    }
  | {
      readonly kind: "permission";
      readonly requestId: string;
      readonly params: acp.RequestPermissionRequest;
    }
  | {
      readonly kind: "updatePermission";
      readonly cardId: string;
      readonly requestId: string;
      readonly params: acp.RequestPermissionRequest;
    };

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function cloneState(state: UnifiedCardState): UnifiedCardState {
  return structuredClone(state) as UnifiedCardState;
}

function recordingPresenter(
  ops: RenderOp[],
  options: { failUpdates?: boolean; failPermissionUpdates?: boolean } = {},
): LarkPresenter {
  let cardSeq = 0;
  return {
    replyText: async () => {},
    sendInterruptCard: async (_messageId, params, requestId) => {
      ops.push({ kind: "permission", requestId, params });
      return `permission_${requestId}`;
    },
    updateInterruptCard: async (cardId, params, requestId) => {
      ops.push({ kind: "updatePermission", cardId, requestId, params });
      return !options.failPermissionUpdates;
    },
    updatePermissionCard: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async (_messageId, notice) => {
      ops.push({
        kind: "notice",
        title: notice.title,
        body: notice.body,
        template: notice.template,
      });
    },
    sendNoticeCard: async () => null,
    sendUnifiedCard: async (_replyToMessageId, state) => {
      ops.push({ kind: "sendUnified", state: cloneState(state) });
      cardSeq += 1;
      return `card_${cardSeq}`;
    },
    updateUnifiedCard: async (cardId, state) => {
      ops.push({ kind: "updateUnified", cardId, state: cloneState(state) });
      return !options.failUpdates;
    },
  };
}

function makeClient(
  ops: RenderOp[],
  options: {
    failUpdates?: boolean;
    failPermissionUpdates?: boolean;
    idleStatusCardMs?: number;
    onSessionInfoUpdate?: (
      update: Extract<acp.SessionUpdate, { sessionUpdate: "session_info_update" }>,
    ) => void;
  } = {},
): HummingClient {
  const client = new HummingClient({
    presenter: recordingPresenter(ops, options),
    logger,
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    permissionMode: "alwaysAsk",
    idleStatusCardMs: options.idleStatusCardMs ?? 0,
    ...(options.onSessionInfoUpdate !== undefined
      ? { onSessionInfoUpdate: options.onSessionInfoUpdate }
      : {}),
  });
  client.setContext("om_user", "oc_chat", "omt_thread");
  return client;
}

function permissionRequest(): acp.RequestPermissionRequest {
  return {
    sessionId: "sess_1",
    toolCall: {
      toolCallId: "tool_edit",
      title: "Modifying config",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/tmp/config.json" }],
      rawInput: { path: "/tmp/config.json", content: "{}" },
    },
    options: [{ kind: "allow_once", name: "允许", optionId: "allow" }],
  };
}

function completedToolUpdate(): acp.SessionNotification {
  return {
    sessionId: "sess_1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_edit",
      // Some agents omit title/kind on the completion event; the approval
      // request metadata must preserve them for the post-approval card.
      status: "completed",
    },
  };
}

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

function textChunk(text: string): acp.SessionNotification {
  return {
    sessionId: "sess_1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

describe("HummingClient card-v2 conversation rendering", () => {
  it("creates a reusable status card after visible content goes idle", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, { idleStatusCardMs: 1_000 });

      await client.sessionUpdate(textChunk("First segment."));
      await vi.advanceTimersByTimeAsync(160);
      await client.sessionUpdate(textChunk(" still streaming."));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(1_000);

      const sendsBeforeSecondSegment = ops.filter((op) => op.kind === "sendUnified");
      expect(sendsBeforeSecondSegment).toHaveLength(2);
      expect(sendsBeforeSecondSegment[1]?.state).toMatchObject({
        status: "thinking",
        entries: [],
        cancellable: true,
      });

      await client.sessionUpdate(textChunk("Second segment after idle."));
      await vi.advanceTimersByTimeAsync(160);

      const finalUpdate = ops.findLast(
        (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
      );
      expect(finalUpdate?.cardId).toBe("card_2");
      expect(finalUpdate?.state).toMatchObject({
        status: "responding",
        entries: [{ kind: "text", text: "Second segment after idle." }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an idle status card as the approval card when permission is requested", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, { idleStatusCardMs: 1_000 });

      await client.sessionUpdate(textChunk("I need to inspect files."));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(1_000);

      const statusCard = ops.findLast(
        (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
      );
      expect(statusCard?.state.entries).toEqual([]);

      const responsePromise = client.requestPermission(permissionRequest());
      await vi.advanceTimersByTimeAsync(160);

      const approvalUpdate = ops.find(
        (op): op is Extract<RenderOp, { kind: "updatePermission" }> =>
          op.kind === "updatePermission",
      );
      expect(approvalUpdate?.cardId).toBe("card_2");
      expect(ops.some((op) => op.kind === "permission")).toBe(false);
      if (!approvalUpdate) throw new Error("expected approval update");
      client.handleCardAction(approvalUpdate.requestId, "allow");
      await responsePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a fresh approval card when pending status card approval patch fails", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, {
        idleStatusCardMs: 1_000,
        failPermissionUpdates: true,
      });

      await client.sessionUpdate(textChunk("I need permission after a pause."));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(1_000);

      const responsePromise = client.requestPermission(permissionRequest());
      await vi.advanceTimersByTimeAsync(160);

      const approvalPatch = ops.find(
        (op): op is Extract<RenderOp, { kind: "updatePermission" }> =>
          op.kind === "updatePermission",
      );
      const freshApproval = ops.find(
        (op): op is Extract<RenderOp, { kind: "permission" }> => op.kind === "permission",
      );
      expect(approvalPatch?.cardId).toBe("card_2");
      expect(freshApproval).toBeDefined();
      if (!freshApproval) throw new Error("expected fresh approval fallback");
      client.handleCardAction(freshApproval.requestId, "allow");
      await responsePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates a pending idle status card into a failed terminal card", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, { idleStatusCardMs: 1_000 });

      await client.sessionUpdate(textChunk("Before failure."));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(1_000);
      await client.finalize("failed");

      const finalUpdate = ops.findLast(
        (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
      );
      expect(finalUpdate?.cardId).toBe("card_2");
      expect(finalUpdate?.state).toMatchObject({
        status: "failed",
        entries: [],
        cancellable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates a pending idle status card into a cancelled terminal card", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, { idleStatusCardMs: 1_000 });

      await client.sessionUpdate(textChunk("Before cancel."));
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(1_000);
      await client.finalize("cancelled");

      const finalUpdate = ops.findLast(
        (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
      );
      expect(finalUpdate?.cardId).toBe("card_2");
      expect(finalUpdate?.state).toMatchObject({
        status: "cancelled",
        entries: [],
        cancellable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rotate the initial empty progress card before first agent content", async () => {
    vi.useFakeTimers();
    try {
      const ops: RenderOp[] = [];
      const client = makeClient(ops, { idleStatusCardMs: 1_000 });

      client.adoptProgressCard("progress_card_1");
      await client.showPreparing();
      await client.showForwarded();
      await vi.advanceTimersByTimeAsync(1_000);
      await client.sessionUpdate(textChunk("First content after slow bootstrap."));
      await vi.advanceTimersByTimeAsync(160);

      expect(ops.some((op) => op.kind === "sendUnified")).toBe(false);
      const updates = ops.filter(
        (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
      );
      expect(updates.map((op) => op.cardId)).toEqual([
        "progress_card_1",
        "progress_card_1",
        "progress_card_1",
      ]);
      expect(updates.at(-1)?.state.entries).toEqual([
        { kind: "text", text: "First content after slow bootstrap." },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts the bridge-created progress card and patches it through agent output", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    client.adoptProgressCard("progress_card_1");
    await client.showPreparing();
    await client.showForwarded();
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from agent." },
      },
    });
    await waitForFlush();
    await client.finalize("complete");

    expect(ops.some((op) => op.kind === "sendUnified")).toBe(false);
    const updates = ops.filter(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
    );
    expect(updates.map((op) => op.cardId)).toEqual([
      "progress_card_1",
      "progress_card_1",
      "progress_card_1",
      "progress_card_1",
    ]);
    expect(updates.map((op) => op.state.status)).toEqual([
      "preparing",
      "thinking",
      "responding",
      "complete",
    ]);
    expect(updates.at(-1)?.state.entries).toEqual([{ kind: "text", text: "Hello from agent." }]);
  });

  it("uses a compact 4096-character soft card fold threshold", () => {
    expect(CARD_MARKDOWN_SOFT_CHAR_LIMIT).toBe(4_096);
    expect(CARD_MARKDOWN_SOFT_CHAR_LIMIT).toBeLessThan(CARD_MARKDOWN_ELEMENT_CHAR_LIMIT);
  });

  it("keeps assistant messages and tool calls in the same conversation card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Before tool." },
      },
    });
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_edit",
        title: "Edit file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/tmp/config.json" }],
      },
    });
    await client.sessionUpdate(completedToolUpdate());
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "After tool." },
      },
    });
    await waitForFlush();
    await client.finalize("complete");

    const sends = ops.filter(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(sends).toHaveLength(1);

    const finalPatch = ops.findLast(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
    );
    expect(finalPatch?.cardId).toBe("card_1");
    expect(finalPatch?.state.status).toBe("complete");
    expect(finalPatch?.state.cancellable).toBe(false);
    expect(finalPatch?.state.entries).toEqual([
      { kind: "text", text: "Before tool." },
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "config.json",
        toolKind: "edit",
        status: "completed",
      },
      { kind: "text", text: "After tool." },
    ]);
  });

  it("logs when a prompt finalizes without renderable output", async () => {
    const ops: RenderOp[] = [];
    const warnMessages: string[] = [];
    const client = new HummingClient({
      presenter: recordingPresenter(ops),
      logger: {
        ...logger,
        warn: (_obj: unknown, message?: string) => {
          if (message !== undefined) warnMessages.push(message);
        },
        child() {
          return this;
        },
      },
      showThoughts: true,
      showTools: true,
      showCancelButton: true,
      permissionTimeoutMs: 0,
      idleStatusCardMs: 0,
      permissionMode: "alwaysAsk",
    });
    client.setContext("om_user", "oc_chat", "omt_thread");

    await client.finalize("complete");

    expect(warnMessages).toContain("agent prompt finalized with no renderable output");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "sendUnified", state: { status: "complete" } });
  });

  it("ignores late renderable updates after a prompt has already been finalized", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      },
    });
    await waitForFlush();
    await client.finalize("complete");
    const opCountAfterFinalize = ops.length;

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Late chunk from old prompt." },
      },
    });
    await waitForFlush();

    expect(ops).toHaveLength(opCountAfterFinalize);
    expect(ops.at(-1)).toMatchObject({
      kind: "updateUnified",
      state: { status: "complete", cancellable: false },
    });
  });

  it("seals the current conversation card before an approval card and starts a new card after approval", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I need to edit the config." },
      },
    });

    const responsePromise = client.requestPermission(permissionRequest());
    await waitForFlush();

    const permission = ops.find(
      (op): op is Extract<RenderOp, { kind: "permission" }> => op.kind === "permission",
    );
    if (!permission) throw new Error("expected permission request");
    client.handleCardAction(permission.requestId, "allow");
    await responsePromise;

    await client.sessionUpdate(completedToolUpdate());
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Config updated." },
      },
    });
    await waitForFlush();
    await client.finalize("complete");

    const sends = ops.filter(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]?.state).toMatchObject({
      status: "sealed",
      cancellable: false,
      entries: [
        { kind: "text", text: "I need to edit the config." },
        {
          kind: "tool",
          toolCallId: "tool_edit",
          title: "config.json",
          toolKind: "edit",
          status: "pending",
        },
      ],
    });
    expect(sends[1]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "config.json",
        toolKind: "edit",
        status: "completed",
      },
      { kind: "text", text: "Config updated." },
    ]);

    expect(ops.map((op) => op.kind)).toContain("permission");
    const permissionIndex = ops.findIndex((op) => op.kind === "permission");
    const firstConversationIndex = ops.findIndex((op) => op.kind === "sendUnified");
    const secondConversationIndex = ops.findLastIndex((op) => op.kind === "sendUnified");
    expect(firstConversationIndex).toBeLessThan(permissionIndex);
    expect(permissionIndex).toBeLessThan(secondConversationIndex);
  });

  it("does not send an empty placeholder card when finalize follows an approval boundary", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    const responsePromise = client.requestPermission(permissionRequest());
    await waitForFlush();
    const permission = ops.find(
      (op): op is Extract<RenderOp, { kind: "permission" }> => op.kind === "permission",
    );
    if (!permission) throw new Error("expected permission request");
    client.handleCardAction(permission.requestId, "allow");
    await responsePromise;

    await client.finalize("complete");

    expect(ops.filter((op) => op.kind === "sendUnified")).toHaveLength(1);
  });

  it("renders execute tool commands as code blocks", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_exec",
        title: "npm run build && npm test && npm run fmt:check",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm", args: ["run", "build && npm test"] },
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(send?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_exec",
        title: "npm run build && npm test && npm run fmt:check",
        toolKind: "execute",
        status: "pending",
        detail: "```bash\nnpm run 'build && npm test'\n```",
      },
    ]);
  });

  it("redacts secrets in execute command code blocks", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_exec",
        title: "Run deploy",
        kind: "execute",
        status: "pending",
        rawInput:
          "API_TOKEN=abc123 curl -H 'Authorization: Bearer secret-token' https://example.com",
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    const tool = send?.state.entries[0];
    expect(tool).toMatchObject({
      kind: "tool",
      title: "Run deploy",
      detail:
        "```bash\nAPI_TOKEN=[REDACTED] curl -H 'Authorization: Bearer [REDACTED]' https://example.com\n```",
    });
  });

  it("redacts space-separated secret flag values without swallowing later flags", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_exec",
        title: "Run deploy",
        kind: "execute",
        status: "pending",
        rawInput: "deploy --token abc123 --api-key xyz789 --password s3cret --verbose",
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    const tool = send?.state.entries[0];
    expect(tool).toMatchObject({
      kind: "tool",
      title: "Run deploy",
      detail:
        "```bash\ndeploy --token [REDACTED] --api-key [REDACTED] --password [REDACTED] --verbose\n```",
    });
  });

  it("does not redact the following flag when a secret flag carries no value", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_exec",
        title: "Run deploy",
        kind: "execute",
        status: "pending",
        rawInput: "deploy --token --dry-run",
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    const tool = send?.state.entries[0];
    expect(tool).toMatchObject({
      kind: "tool",
      detail: "```bash\ndeploy --token --dry-run\n```",
    });
  });

  it("folds long prose at the next tool call boundary", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);
    const longText = "A".repeat(CARD_MARKDOWN_SOFT_CHAR_LIMIT + 10);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: longText },
      },
    });
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_read",
        title: "Read README",
        kind: "read",
        status: "pending",
        locations: [{ path: "/tmp/README.md" }],
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(send?.state.entries).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("已在安全边界折叠"),
      }),
      {
        kind: "tool",
        toolCallId: "tool_read",
        title: "README.md",
        toolKind: "read",
        status: "pending",
      },
    ]);
    expect(
      send?.state.entries.map((entry) => (entry.kind === "text" ? entry.text : "")).join(""),
    ).not.toContain(longText);
  });

  it("folds long final output even when no later tool call arrives", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);
    const longText = "B".repeat(CARD_MARKDOWN_SOFT_CHAR_LIMIT + 10);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: longText },
      },
    });
    await waitForFlush();
    await client.finalize("complete");

    const finalPatch = ops.findLast(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
    );
    expect(finalPatch?.state.status).toBe("complete");
    expect(finalPatch?.state.entries).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("任务结束前折叠"),
      }),
    ]);
  });

  it("uses a render-only emergency fold before sending an over-limit running card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);
    const hugeText = "C".repeat(CARD_MARKDOWN_ELEMENT_CHAR_LIMIT + 10);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: hugeText },
      },
    });
    await waitForFlush();

    const send = ops.find(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(send?.state.entries).toEqual([
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("发送卡片前折叠"),
      }),
    ]);
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_later",
        title: "Later",
        kind: "read",
        status: "pending",
      },
    });
    await waitForFlush();
    const patch = ops.findLast(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
    );
    expect(patch?.state.entries.at(0)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("下一次 tool call 开始前折叠"),
    });
  });

  it("sends a fallback notice when patching the unified card fails", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops, { failUpdates: true });

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    await waitForFlush();
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      },
    });
    await waitForFlush();

    const notice = ops.find(
      (op): op is Extract<RenderOp, { kind: "notice" }> => op.kind === "notice",
    );
    expect(notice).toMatchObject({
      title: "⚠️ Humming 卡片暂时无法更新",
      template: "grey",
    });
  });
});
