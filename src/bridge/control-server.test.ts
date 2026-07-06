import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinoLogger } from "../logger/logger.js";
import { BridgeControlServer, sendControlRequest } from "./control-server.js";

let dir: string;
let server: BridgeControlServer | null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-control-"));
  server = null;
});

afterEach(async () => {
  await server?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("BridgeControlServer", () => {
  it("serves capabilities and setControls over a local socket", async () => {
    const socketPath = path.join(dir, "control.sock");
    server = new BridgeControlServer({
      socketPath,
      logger: createPinoLogger(),
      handlers: {
        capabilities: async (chatId, threadId) => ({
          session: { chatId, threadId, sessionId: "sess_1" },
          agent: { command: "node", args: [], cwd: "/repo" },
          modes: {
            currentModeId: "ask",
            availableModes: [{ id: "ask", name: "Ask" }],
          },
          bridgePermissionModes: ["alwaysAsk", "alwaysAllow", "alwaysDeny"],
          bridgePermissionMode: "alwaysAsk",
        }),
        setControls: async (chatId, threadId, controls) => ({
          applied: true,
          chatId,
          threadId,
          controls,
        }),
        bindSession: async (record, noticeMessageId) => ({
          bound: true,
          record,
          noticeMessageId,
        }),
        setAgent: async (record, noticeMessageId) => ({
          switched: true,
          record,
          noticeMessageId,
        }),
      },
    });
    await server.start();

    const caps = await sendControlRequest(socketPath, {
      method: "capabilities",
      params: { chatId: "oc_A", threadId: "th_1" },
    });
    expect(caps).toMatchObject({
      ok: true,
      result: {
        session: { chatId: "oc_A", threadId: "th_1", sessionId: "sess_1" },
        modes: { currentModeId: "ask" },
      },
    });

    const set = await sendControlRequest(socketPath, {
      method: "setControls",
      params: {
        chatId: "oc_A",
        threadId: null,
        controls: { modeId: "agent", config: { auto_edit: { type: "boolean", value: true } } },
      },
    });
    expect(set).toMatchObject({
      ok: true,
      result: {
        applied: true,
        chatId: "oc_A",
        threadId: null,
        controls: { modeId: "agent" },
      },
    });

    const bind = await sendControlRequest(socketPath, {
      method: "bindSession",
      params: {
        record: {
          chatId: "oc_A",
          threadId: "th_1",
          sessionId: "sess_desktop",
          title: "Desktop task",
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/claude-code-acp"],
          agentLabel: "claude",
          cwd: "/repo",
          createdAt: 1,
          updatedAt: 2,
        },
        noticeMessageId: "om_notice",
      },
    });
    expect(bind).toMatchObject({
      ok: true,
      result: {
        bound: true,
        noticeMessageId: "om_notice",
        record: { sessionId: "sess_desktop", title: "Desktop task" },
      },
    });

    const setAgent = await sendControlRequest(socketPath, {
      method: "setAgent",
      params: {
        record: {
          chatId: "oc_A",
          threadId: "th_1",
          sessionId: "profile:1",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/copilot-acp"],
          agentLabel: "copilot",
          cwd: "/repo",
          createdAt: 1,
          updatedAt: 2,
        },
        noticeMessageId: "om_notice",
      },
    });
    expect(setAgent).toMatchObject({
      ok: true,
      result: {
        switched: true,
        noticeMessageId: "om_notice",
        record: { sessionId: "profile:1", profileOnly: true, agentLabel: "copilot" },
      },
    });
  });
});
