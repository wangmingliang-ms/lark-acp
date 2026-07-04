import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkAcpClient } from "./lark-acp-client.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter, UnifiedCardState } from "../presenter/presenter.js";

type RenderOp =
  | { readonly kind: "sendUnified"; readonly state: UnifiedCardState }
  | { readonly kind: "updateUnified"; readonly cardId: string; readonly state: UnifiedCardState }
  | {
      readonly kind: "permission";
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

function recordingPresenter(ops: RenderOp[]): LarkPresenter {
  let cardSeq = 0;
  return {
    replyText: async () => {},
    sendInterruptCard: async (_messageId, params, requestId) => {
      ops.push({ kind: "permission", requestId, params });
      return `permission_${requestId}`;
    },
    updatePermissionCard: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async () => {},
    sendUnifiedCard: async (_replyToMessageId, state) => {
      ops.push({ kind: "sendUnified", state: cloneState(state) });
      cardSeq += 1;
      return `card_${cardSeq}`;
    },
    updateUnifiedCard: async (cardId, state) => {
      ops.push({ kind: "updateUnified", cardId, state: cloneState(state) });
    },
  };
}

function makeClient(ops: RenderOp[]): LarkAcpClient {
  const client = new LarkAcpClient({
    presenter: recordingPresenter(ops),
    logger,
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    permissionMode: "alwaysAsk",
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
      // Some agents omit title/kind on the completion event; the sealed
      // permission request must preserve them so C2 does not render "unknown".
      status: "completed",
    },
  };
}

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

describe("LarkAcpClient chronological permission rendering", () => {
  it("renders a pending tool as its own card before sending the permission card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_edit",
        title: "Modifying config",
        kind: "edit",
        status: "pending",
        rawInput: { path: "/tmp/config.json" },
      },
    });

    const responsePromise = client.requestPermission(permissionRequest());
    await waitForFlush();

    expect(ops[0]?.kind).toBe("sendUnified");
    const toolCard = ops[0];
    if (toolCard?.kind !== "sendUnified") throw new Error("expected standalone tool card");
    expect(toolCard.state.status).toBe("calling_tool");
    expect(toolCard.state.cancellable).toBe(false);
    expect(toolCard.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "Modifying config",
        toolKind: "edit",
        status: "pending",
      },
    ]);

    expect(ops[1]?.kind).toBe("permission");
    const permission = ops[1];
    if (permission?.kind !== "permission") throw new Error("expected permission card");
    client.handleCardAction(permission.requestId, "allow");
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("renders the approved tool result in its standalone card with title/kind restored", async () => {
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

    await client.sessionUpdate(completedToolUpdate());
    await waitForFlush();

    const cards = ops.filter(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(cards.length).toBe(1);
    const [c2] = cards;
    expect(c2.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "Modifying config",
        toolKind: "edit",
        status: "completed",
      },
    ]);
  });

  it("patches tool output into the same standalone tool card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_edit",
        title: "Edit file",
        kind: "edit",
        status: "pending",
      },
    });
    await client.sessionUpdate(completedToolUpdate());

    const sends = ops.filter(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    const patches = ops.filter(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> => op.kind === "updateUnified",
    );
    expect(sends).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.cardId).toBe("card_1");
    expect(patches[0]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "Edit file",
        toolKind: "edit",
        status: "completed",
      },
    ]);
  });

  it("renders each tool call in a separate card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_read",
        title: "Read file",
        kind: "read",
        status: "pending",
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
      },
    });

    const sends = ops.filter(
      (op): op is Extract<RenderOp, { kind: "sendUnified" }> => op.kind === "sendUnified",
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_read",
        title: "Read file",
        toolKind: "read",
        status: "pending",
      },
    ]);
    expect(sends[1]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "Edit file",
        toolKind: "edit",
        status: "pending",
      },
    ]);
  });

  it("does not send an empty placeholder C2 when finalize follows a sealed permission boundary", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_edit",
        title: "Modifying config",
        kind: "edit",
        status: "pending",
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

    await client.finalize("complete");

    expect(ops.filter((op) => op.kind === "sendUnified")).toHaveLength(1);
  });

  it("finishes the current message card before rendering a tool card", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I will edit that." },
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
      },
    });

    expect(ops[0]).toMatchObject({
      kind: "sendUnified",
      state: {
        status: "complete",
        cancellable: false,
        entries: [{ kind: "text", text: "I will edit that." }],
      },
    });
    expect(ops[1]).toMatchObject({
      kind: "sendUnified",
      state: {
        status: "calling_tool",
        cancellable: false,
        entries: [
          {
            kind: "tool",
            toolCallId: "tool_edit",
            title: "Edit file",
            toolKind: "edit",
            status: "pending",
          },
        ],
      },
    });
  });

  it("renders text after a tool in a new message card", async () => {
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
        toolCallId: "tool_read",
        title: "Read file",
        kind: "read",
        status: "pending",
      },
    });
    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool_read",
        status: "completed",
      },
    });
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
    expect(sends).toHaveLength(3);
    expect(sends[0]?.state.entries).toEqual([{ kind: "text", text: "Before tool." }]);
    expect(sends[0]?.state.status).toBe("complete");
    expect(sends[1]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_read",
        title: "Read file",
        toolKind: "read",
        status: "pending",
      },
    ]);
    expect(sends[2]?.state.entries).toEqual([{ kind: "text", text: "After tool." }]);

    const finalTextPatch = ops.find(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> =>
        op.kind === "updateUnified" && op.cardId === "card_3" && op.state.status === "complete",
    );
    expect(finalTextPatch?.state.entries).toEqual([{ kind: "text", text: "After tool." }]);
    expect(finalTextPatch?.state.cancellable).toBe(false);
  });
});
