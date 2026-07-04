import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkAcpClient, type SessionStatus } from "./lark-acp-client.js";
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
    addReaction: async () => null,
    removeReaction: async () => {},
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

function makeClient(ops: RenderOp[], statuses: SessionStatus[] = []): LarkAcpClient {
  const client = new LarkAcpClient({
    presenter: recordingPresenter(ops),
    logger,
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    callbacks: { onTyping: async () => {}, onStatus: async (status) => statuses.push(status) },
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
  it("seals the current unified card before sending the permission card", async () => {
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
    expect(ops[1]?.kind).toBe("permission");
    const sealed = ops[0];
    if (sealed?.kind !== "sendUnified") throw new Error("expected sealed unified card");
    expect(sealed.state.status).toBe("sealed");
    expect(sealed.state.cancellable).toBe(false);
    expect(sealed.state.entries).toEqual([]);

    const permission = ops[1];
    if (permission?.kind !== "permission") throw new Error("expected permission card");
    client.handleCardAction(permission.requestId, "allow");
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("renders the approved tool result in a new C2 card with title/kind restored", async () => {
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

  it("updates a sealed message card to the terminal status when the prompt finishes", async () => {
    const ops: RenderOp[] = [];
    const client = makeClient(ops);

    await client.sessionUpdate({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I will edit that." },
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
    await waitForFlush();
    await client.finalize("complete");

    const sealedFinalPatch = ops.find(
      (op): op is Extract<RenderOp, { kind: "updateUnified" }> =>
        op.kind === "updateUnified" && op.cardId === "card_1" && op.state.status === "complete",
    );
    expect(sealedFinalPatch?.state.entries).toEqual([{ kind: "text", text: "I will edit that." }]);
    expect(sealedFinalPatch?.state.cancellable).toBe(false);
  });

  it("emits session status changes for waiting, resumed processing, and completion", async () => {
    const ops: RenderOp[] = [];
    const statuses: SessionStatus[] = [];
    const client = makeClient(ops, statuses);

    const responsePromise = client.requestPermission(permissionRequest());
    await waitForFlush();
    const permission = ops.find(
      (op): op is Extract<RenderOp, { kind: "permission" }> => op.kind === "permission",
    );
    if (!permission) throw new Error("expected permission request");
    client.handleCardAction(permission.requestId, "allow");
    await responsePromise;
    await client.finalize("complete");

    expect(statuses).toEqual(["waiting", "processing", "complete"]);
  });
});
