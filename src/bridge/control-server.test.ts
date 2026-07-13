import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinoLogger } from "../logger/logger.js";
import { BridgeControlServer, sendControlRequest } from "./control-server.js";
import type { LarkBridgeOptions } from "./bridge.js";
import { LarkBridge } from "./bridge.js";

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
        shutdown: async () => ({ accepted: true }),
        restart: async () => ({ accepted: true, restarting: true }),
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
        setPendingTargetProfile: async (chatId, threadId, profile, noticeMessageId) => ({
          queued: true,
          chatId,
          threadId,
          profile,
          noticeMessageId,
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

    await expect(
      sendControlRequest(socketPath, { method: "shutdown", params: {} }),
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } });

    await expect(
      sendControlRequest(socketPath, { method: "restart", params: {} }),
    ).resolves.toMatchObject({ ok: true, result: { accepted: true, restarting: true } });

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

    const target = await sendControlRequest(socketPath, {
      method: "setPendingTargetProfile",
      params: {
        chatId: "oc_A",
        threadId: "th_1",
        profile: {
          sessionId: "profile:1",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/copilot-acp"],
          agentLabel: "copilot",
          cwd: "/repo",
          controls: { modelId: "gpt-5.5" },
          task: { prompt: "continue with copilot", createdAt: 123 },
          createdAt: 123,
          updatedAt: 123,
        },
        noticeMessageId: "om_notice",
      },
    });
    expect(target).toMatchObject({
      ok: true,
      result: {
        queued: true,
        chatId: "oc_A",
        threadId: "th_1",
        noticeMessageId: "om_notice",
        profile: { agentLabel: "copilot", controls: { modelId: "gpt-5.5" } },
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

  it("validates and routes beginLifecycle transactions", async () => {
    const socketPath = path.join(dir, "control.sock");
    const statePath = path.join(dir, "lifecycle.json");
    const transaction = {
      id: "lifecycle-123",
      intent: "restart" as const,
      home: dir,
      oldPid: 4242,
      launch: {
        spawnArgv: ["proxy", "--agent", "copilot"],
        workingDirectory: "/repo",
        savedAt: "2026-07-13T10:00:00.000Z",
      },
      deadlines: { readyToExitAt: 1_000, oldPidExitAt: 2_000, restartReadyAt: 3_000 },
      statePath,
    };
    let received: unknown;
    const handlers = {
      shutdown: async () => ({ accepted: true }),
      restart: async () => ({ accepted: true }),
      beginLifecycle: async (value: typeof transaction) => {
        received = value;
        return { accepted: true, transactionId: transaction.id, readyToExit: true };
      },
      capabilities: async () => {
        throw new Error("not used");
      },
      setControls: async () => ({ applied: true }),
      setPendingTask: async () => ({ queued: true }),
      setPendingTargetProfile: async () => ({ queued: true }),
      bindSession: async () => ({ bound: true }),
      setAgent: async () => ({ switched: true }),
      agentProbeFailed: async () => ({ notified: true }),
    };
    server = new BridgeControlServer({ socketPath, logger: createPinoLogger(), handlers });
    await server.start();

    const response = await sendControlRequest(socketPath, {
      method: "beginLifecycle",
      params: { transaction },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { accepted: true, transactionId: "lifecycle-123", readyToExit: true },
    });
    expect(received).toEqual(transaction);

    await expect(
      sendControlRequest(socketPath, {
        method: "beginLifecycle",
        params: { transaction: { ...transaction, intent: "reload" } },
      } as never),
    ).resolves.toMatchObject({ ok: false, error: "invalid control request" });
  });

  it("routes a restart request through the production bridge callback", async () => {
    const socketPath = path.join(dir, "control.sock");
    let restartRequested = false;
    const bridge = new LarkBridge({
      lark: { appId: "cli_test", appSecret: "secret" },
      agent: { resolver: async () => ({ command: "node", args: [] }) },
      sessionStore: {},
      bindingStore: {},
      presenter: {},
      controlSocketPath: socketPath,
      onRestartRequested: () => {
        restartRequested = true;
      },
    } as unknown as LarkBridgeOptions);

    await (bridge as unknown as { startControlServer(): Promise<void> }).startControlServer();
    const response = await sendControlRequest(socketPath, { method: "restart", params: {} });

    expect(response).toMatchObject({ ok: true, result: { accepted: true } });
    expect(restartRequested).toBe(true);
    await (
      bridge as unknown as { controlServer: { stop(): Promise<void> } | null }
    ).controlServer?.stop();
  });

  it("responds to newline-framed requests before the client half-closes", async () => {
    const socketPath = path.join(dir, "control.sock");
    server = new BridgeControlServer({
      socketPath,
      logger: createPinoLogger(),
      handlers: {
        shutdown: async () => ({ accepted: true }),
        restart: async () => ({ accepted: true, restarting: true }),
        capabilities: async (chatId, threadId) => ({
          session: { chatId, threadId, sessionId: "sess_pipe" },
          agent: { command: "node", args: [], cwd: "/repo" },
          bridgePermissionModes: ["alwaysAsk", "alwaysAllow", "alwaysDeny"],
          bridgePermissionMode: "alwaysAsk",
        }),
        setControls: async () => ({ applied: true }),
        setPendingTask: async () => ({ queued: true }),
        setPendingTargetProfile: async () => ({ queued: true }),
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

  it("rejects malformed session control payloads before invoking handlers", async () => {
    const socketPath = path.join(dir, "control.sock");
    let setControlsCalled = false;
    let pendingTargetProfileCalled = false;
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
        setControls: async () => {
          setControlsCalled = true;
          return { applied: true };
        },
        setPendingTask: async () => ({ queued: true }),
        setPendingTargetProfile: async () => {
          pendingTargetProfileCalled = true;
          return { queued: true };
        },
        bindSession: async (record) => ({ bound: true, record }),
        setAgent: async (record) => ({ switched: true, record }),
        agentProbeFailed: async () => ({ notified: true }),
        shutdown: async () => ({ accepted: true }),
        restart: async () => ({ accepted: true, restarting: true }),
      },
    });
    await server.start();

    await expect(
      sendControlRequest(socketPath, {
        method: "setControls",
        params: {
          chatId: "oc_A",
          controls: { clearModelId: false },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid control request" });

    await expect(
      sendControlRequest(socketPath, {
        method: "setPendingTargetProfile",
        params: {
          chatId: "oc_A",
          profile: {
            sessionId: "profile:bad",
            agentCommand: "npx",
            agentArgs: ["agent"],
            cwd: "/repo",
            controls: { bridgePermissionMode: "bypass" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid control request" });

    expect(setControlsCalled).toBe(false);
    expect(pendingTargetProfileCalled).toBe(false);
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
        setPendingTargetProfile: async () => ({ queued: true }),
        bindSession: async (record) => ({ bound: true, record }),
        setAgent: async (record) => ({ switched: true, record }),
        agentProbeFailed: async () => ({ notified: true }),
        shutdown: async () => ({ accepted: true }),
        restart: async () => ({ accepted: true, restarting: true }),
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
