import fs from "node:fs";
import net from "node:net";
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
        setPendingTask: async (chatId, threadId, task) => ({
          queued: true,
          chatId,
          threadId,
          task,
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
        agentProbeFailed: async (chatId, threadId, agent, error, noticeMessageId) => ({
          notified: true,
          chatId,
          threadId,
          agent,
          error,
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

    const task = await sendControlRequest(socketPath, {
      method: "setPendingTask",
      params: {
        chatId: "oc_A",
        threadId: "th_1",
        task: { prompt: "continue this task", createdAt: 123 },
      },
    });
    expect(task).toMatchObject({
      ok: true,
      result: {
        queued: true,
        chatId: "oc_A",
        threadId: "th_1",
        task: { prompt: "continue this task", createdAt: 123 },
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

    const probeFailed = await sendControlRequest(socketPath, {
      method: "agentProbeFailed",
      params: {
        chatId: "oc_A",
        threadId: "th_1",
        agent: {
          label: "copilot",
          command: "npx",
          args: ["-y", "@zed-industries/copilot-acp"],
          cwd: "/repo",
        },
        error: "Authentication required",
        noticeMessageId: "om_notice",
      },
    });
    expect(probeFailed).toMatchObject({
      ok: true,
      result: {
        notified: true,
        chatId: "oc_A",
        threadId: "th_1",
        agent: { label: "copilot", cwd: "/repo" },
        error: "Authentication required",
        noticeMessageId: "om_notice",
      },
    });
  });

  it("responds to newline-framed requests before the client half-closes", async () => {
    const socketPath = path.join(dir, "control.sock");
    server = new BridgeControlServer({
      socketPath,
      logger: createPinoLogger(),
      handlers: {
        capabilities: async (chatId, threadId) => ({
          session: { chatId, threadId, sessionId: "sess_pipe" },
          agent: { command: "node", args: [], cwd: "/repo" },
          bridgePermissionModes: ["alwaysAsk", "alwaysAllow", "alwaysDeny"],
          bridgePermissionMode: "alwaysAsk",
        }),
        setControls: async () => ({ applied: true }),
        setPendingTask: async () => ({ queued: true }),
        bindSession: async (record) => ({ bound: true, record }),
        setAgent: async (record) => ({ switched: true, record }),
        agentProbeFailed: async () => ({ notified: true }),
      },
    });
    await server.start();

    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf-8");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for newline-framed control response"));
      }, 500);
      let raw = "";
      socket.on("data", (chunk) => {
        raw += chunk;
        if (!raw.includes("\n")) return;
        clearTimeout(timeout);
        socket.destroy();
        resolve(raw);
      });
      socket.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    socket.write(
      `${JSON.stringify({
        method: "capabilities",
        params: { chatId: "oc_A", threadId: "th_1" },
      })}\n`,
    );

    const raw = await responsePromise;
    expect(JSON.parse(raw)).toMatchObject({
      ok: true,
      result: { session: { chatId: "oc_A", threadId: "th_1", sessionId: "sess_pipe" } },
    });
  });

  it("does not crash when a control client disconnects before the response", async () => {
    const socketPath = path.join(dir, "control.sock");
    let releaseHandler: (() => void) | null = null;
    const release = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    server = new BridgeControlServer({
      socketPath,
      logger: createPinoLogger(),
      handlers: {
        capabilities: async (chatId, threadId) => {
          await release;
          return {
            session: { chatId, threadId, sessionId: "sess_slow" },
            agent: { command: "node", args: [], cwd: "/repo" },
            bridgePermissionModes: ["alwaysAsk", "alwaysAllow", "alwaysDeny"],
            bridgePermissionMode: "alwaysAsk",
          };
        },
        setControls: async () => ({ applied: true }),
        setPendingTask: async () => ({ queued: true }),
        bindSession: async (record) => ({ bound: true, record }),
        setAgent: async (record) => ({ switched: true, record }),
        agentProbeFailed: async () => ({ notified: true }),
      },
    });
    await server.start();

    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      JSON.stringify({
        method: "capabilities",
        params: { chatId: "oc_A", threadId: "th_1" },
      }),
    );
    socket.destroy();
    releaseHandler?.();

    const response = await sendControlRequest(socketPath, {
      method: "capabilities",
      params: { chatId: "oc_A", threadId: "th_1" },
    });
    expect(response).toMatchObject({ ok: true, result: { session: { sessionId: "sess_slow" } } });
  });
});
