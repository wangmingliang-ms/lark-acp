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
      // Some agents omit title/kind on the completion event; the approval
      // request metadata must preserve them for the post-approval card.
      status: "completed",
    },
  };
}

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

describe("LarkAcpClient card-v2 conversation rendering", () => {
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
        title: "Edit file",
        toolKind: "edit",
        status: "completed",
      },
      { kind: "text", text: "After tool." },
    ]);
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
          title: "Modifying config",
          toolKind: "edit",
          status: "pending",
        },
      ],
    });
    expect(sends[1]?.state.entries).toEqual([
      {
        kind: "tool",
        toolCallId: "tool_edit",
        title: "Modifying config",
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
});
