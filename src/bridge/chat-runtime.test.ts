import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { ChatRuntime } from "./chat-runtime.js";
import { HummingClient } from "../acp/humming-client.js";
import type { ChatRuntimeOptions } from "./chat-runtime.js";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import type { LarkPresenter, UnifiedCardState } from "../presenter/presenter.js";
import type { SessionRecord, SessionStore } from "../session-store/session-store.js";
import type { AgentProcess, SpawnAgentOptions } from "../acp/agent-process.js";

// The agent subprocess is the correct mock boundary: we replace `spawnAgent`
// so no real process is spawned, then hand ChatRuntime a fake AgentProcess
// whose connection we fully control. Everything else in the module (notably
// `AgentDisconnectedError`, which the disconnect path throws) is kept real via
// `importOriginal`, so only the process-spawning side effect is stubbed.
const spawnAgentMock = vi.fn<(opts: unknown) => Promise<AgentProcess>>();
const spawnAndResumeAgentMock =
  vi.fn<
    (opts: SpawnAgentOptions, id: string) => Promise<{ agent: AgentProcess; resumed: boolean }>
  >();

vi.mock("../acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/agent-process.js")>();
  return {
    ...actual,
    spawnAgent: (opts: unknown) => spawnAgentMock(opts),
    spawnAndResumeAgent: (opts: SpawnAgentOptions, id: string) => spawnAndResumeAgentMock(opts, id),
    killAgent: () => {},
  };
});

/**
 * Minimal options to construct a ChatRuntime without spawning anything.
 * These tests only exercise the pre-bootstrap getters (`processing` /
 * `lastActivity`) that the bridge's idle-eviction reads, so the presenter /
 * session store are never touched.
 */
function opts(logger: LarkLogger = createPinoLogger()): ChatRuntimeOptions {
  // The presenter/sessionStore are unused by the getters under test; a cast
  // keeps the test focused (CLAUDE.md §4 — documented, narrow test cast).
  return {
    chatId: "oc_test",
    threadId: null,
    agentCommand: "node",
    agentArgs: [],
    agentCwd: "/tmp",
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    idleStatusCardMs: 0,
    permissionMode: "alwaysAllow",
    presenter: {} as ChatRuntimeOptions["presenter"],
    sessionStore: {} as ChatRuntimeOptions["sessionStore"],
    logger,
  };
}

describe("ChatRuntime idle-eviction getters (regression: evicted mid-spawn)", () => {
  it("reports lastActivity as construction time, not the epoch, before bootstrap", () => {
    const before = Date.now();
    const runtime = new ChatRuntime(opts());
    const after = Date.now();

    // The bug: `state?.lastActivity ?? 0` returned 0 for a fresh runtime, so
    // `now - 0` always exceeded the idle timeout and evicted it mid-spawn.
    expect(runtime.lastActivity).toBeGreaterThanOrEqual(before);
    expect(runtime.lastActivity).toBeLessThanOrEqual(after);
    expect(runtime.lastActivity).not.toBe(0);
  });

  it("a fresh runtime is NOT idle under a normal timeout", () => {
    const runtime = new ChatRuntime(opts());
    const idleTimeoutMs = 24 * 60 * 60_000; // bridge default (24h)
    const isIdle = Date.now() - runtime.lastActivity > idleTimeoutMs;
    expect(isIdle).toBe(false);
  });

  it("processing is false before any message (no spawn in flight yet)", () => {
    const runtime = new ChatRuntime(opts());
    expect(runtime.processing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: unified card's "中断当前任务" button never disappears when the
// agent dies mid-turn. The ACP SDK does NOT reject a pending `prompt()` when
// the stdio stream closes (it only aborts its close signal — verified in
// @agentclientprotocol/sdk Connection#receive). So a bare `await prompt()`
// hangs forever, `finalize()` never runs, and the card stays cancellable.
// ---------------------------------------------------------------------------

/** Records every card state the runtime renders, so we can assert the final
 *  one drops the cancel button. All methods are inert except the ones the
 *  cancel-on-disconnect path touches. */
function recordingPresenter(
  states: UnifiedCardState[],
  notices: Array<{ title: string; body: string; template: string }> = [],
  noticeUpdates: Array<{ title: string; body: string; template: string }> = [],
): LarkPresenter {
  return {
    replyText: async () => {},
    sendInterruptCard: async () => null,
    updateInterruptCard: async () => false,
    updatePermissionCard: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async (_id, notice) => {
      notices.push({ title: notice.title, body: notice.body, template: notice.template });
      return "notice_msg";
    },
    updateNoticeCard: async (_id, notice) => {
      noticeUpdates.push({ title: notice.title, body: notice.body, template: notice.template });
      return true;
    },
    replyCommandResultCard: async (_id, result) => {
      notices.push({ title: result.title, body: result.body, template: result.template });
    },
    sendNoticeCard: async (_chatId, notice) => {
      notices.push({ title: notice.title, body: notice.body, template: notice.template });
      return "notice_msg";
    },
    sendUnifiedCard: async (_id, state) => {
      states.push(structuredClone(state));
      return "card_msg_1";
    },
    updateUnifiedCard: async (_id, state) => {
      states.push(structuredClone(state));
      return true;
    },
  };
}

/** SessionStore stub — persistence is irrelevant to the disconnect path. */
function stubSessionStore(): SessionStore {
  return {
    init: async () => {},
    close: async () => {},
    listByChat: async () => [],
    listByThread: async () => [],
    getLatest: async () => null,
    save: async () => {},
    async bindThreadSession(record: SessionRecord): Promise<SessionRecord> {
      return record;
    },
    setControls: async () => {
      throw new Error("setControls not implemented in stub");
    },
    setPendingControls: async () => {
      throw new Error("setPendingControls not implemented in stub");
    },
    consumePendingControls: async () => ({
      record: {
        chatId: "oc_test",
        threadId: null,
        sessionId: "sess_fake",
        agentCommand: "node",
        agentArgs: [],
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: 1,
      },
      pendingControls: undefined,
    }),
    setPendingTask: async () => {
      throw new Error("setPendingTask not implemented in stub");
    },
    setPendingTargetProfile: async () => {
      throw new Error("setPendingTargetProfile not implemented in stub");
    },
    consumePendingTask: async () => ({
      record: {
        chatId: "oc_test",
        threadId: null,
        sessionId: "sess_fake",
        agentCommand: "node",
        agentArgs: [],
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: 1,
      },
      pendingTask: undefined,
    }),
    clearThread: async () => {},
    delete: async () => {},
  };
}

interface FakeAgentHandle {
  agent: AgentProcess;
  /** Resolve the in-flight prompt with a stop reason (normal turn end). */
  resolvePrompt: (stopReason: acp.StopReason) => void;
  /** Simulate the OS child-process exit event. */
  exitProcess: (code: number | null, signal?: NodeJS.Signals | null) => void;
  /** Simulate the agent process's stdout/stream closing (process died). */
  closeConnection: () => void;
  /** Number of ACP cancel notifications sent to this fake agent. */
  cancelCalls: () => number;
  /** Hold the next ACP cancel notification until the returned callback is invoked. */
  holdNextCancel: () => () => void;
  /** Prompt texts delivered to ACP in order. */
  prompts: () => readonly string[];
}

/**
 * Build a fake {@link AgentProcess}. By default its `prompt()` never settles —
 * exactly how the real SDK behaves when the agent dies mid-turn (the pending
 * request is left hanging). `resolvePrompt()` lets a test end the turn
 * normally; `closeConnection()` resolves the `connection.closed` promise (and
 * fires `signal`), mimicking the stdio stream ending.
 */
function makeFakeAgent(): FakeAgentHandle {
  const abort = new AbortController();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const promptResolvers: Array<(r: acp.PromptResponse) => void> = [];
  const queuedPromptResponses: acp.PromptResponse[] = [];
  const promptTexts: string[] = [];
  let cancelCallCount = 0;
  let nextCancelGate: Promise<void> | null = null;

  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  const proc = {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    on: (event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === "exit") exitHandler = handler;
      return proc;
    },
  };

  const connection = {
    // Stays pending until `resolvePrompt` is called — the crux of the bug is
    // that the SDK never rejects this when the stream closes.
    prompt: (params: acp.PromptRequest) => {
      promptTexts.push(promptToText(params.prompt));
      return new Promise<acp.PromptResponse>((resolve) => {
        const queued = queuedPromptResponses.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        promptResolvers.push(resolve);
      });
    },
    cancel: async () => {
      cancelCallCount += 1;
      if (nextCancelGate) {
        const gate = nextCancelGate;
        nextCancelGate = null;
        await gate;
      }
    },
    unstable_setSessionModel: async () => ({}),
    setSessionMode: async () => ({}),
    setSessionConfigOption: async () => ({ configOptions: [] }),
    get closed() {
      return closed;
    },
    get signal() {
      return abort.signal;
    },
  } as unknown as AgentProcess["connection"];

  const agent: AgentProcess = {
    process: proc as unknown as AgentProcess["process"],
    connection,
    sessionId: "sess_fake",
    capabilities: {},
    sessionCapabilities: {
      models: {
        currentModelId: "model-old",
        availableModels: [
          { modelId: "model-old", name: "Old" },
          { modelId: "model-new", name: "New" },
        ],
      },
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "agent", name: "Agent" },
        ],
      },
      configOptions: [
        { id: "auto_edit", name: "Auto Edit", type: "boolean", currentValue: false },
        {
          id: "approval_mode",
          name: "Approval Mode",
          type: "select",
          currentValue: "ask",
          options: [
            { name: "Ask", value: "ask" },
            { name: "Auto", value: "auto" },
          ],
        },
      ],
    } as AgentProcess["sessionCapabilities"],
    getRecentStderr: () => ["fatal: boom"],
  };

  return {
    agent,
    resolvePrompt: (stopReason) => {
      const response: acp.PromptResponse = { stopReason };
      const resolve = promptResolvers.shift();
      if (resolve) resolve(response);
      else queuedPromptResponses.push(response);
    },
    exitProcess: (code, signal = null) => {
      proc.exitCode = code;
      proc.signalCode = signal;
      proc.killed = code === null && signal !== null;
      exitHandler?.(code, signal);
    },
    closeConnection: () => {
      abort.abort();
      resolveClosed();
    },
    cancelCalls: () => cancelCallCount,
    holdNextCancel: () => {
      let release: () => void = () => {};
      nextCancelGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    prompts: () => [...promptTexts],
  };
}

function promptToText(prompt: readonly acp.ContentBlock[]): string {
  return prompt.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

async function waitForCardFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

describe("ChatRuntime finalizes when the agent connection closes mid-prompt", () => {
  beforeEach(() => {
    spawnAgentMock.mockReset();
    spawnAndResumeAgentMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a non-cancellable final card after the connection closes", async () => {
    const states: UnifiedCardState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "long task" }],
      messageId: "om_1",
      chatId: "oc_test",
    });

    // The agent process dies mid-turn: its stdio stream closes but the
    // pending prompt() is left hanging by the SDK.
    fake.closeConnection();

    // Give the runtime a chance to react to the closed connection.
    await vi.waitFor(
      () => {
        const last = states.at(-1);
        expect(last, "expected at least one rendered card").toBeDefined();
        expect(last?.status, "final card should read as failed").toBe("failed");
        expect(last?.cancellable, "final card must drop the cancel button").toBe(false);
        expect(notices.at(-1)).toMatchObject({ title: "⚠️ Agent 异常退出", template: "red" });
      },
      { timeout: 1_000, interval: 20 },
    );
  });

  it("updates an adopted progress card from preparing to forwarded before agent output", async () => {
    const states: UnifiedCardState[] = [];
    const fake = makeFakeAgent();
    let resolveSpawn: (agent: AgentProcess) => void = () => {};
    spawnAgentMock.mockReturnValue(
      new Promise<AgentProcess>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    const enqueue = runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_progress",
      chatId: "oc_test",
      progressCardId: "progress_card_1",
    });

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("preparing"), {
      timeout: 1_000,
      interval: 20,
    });

    resolveSpawn(fake.agent);
    await enqueue;

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("thinking"), {
      timeout: 1_000,
      interval: 20,
    });
    expect(states.map((state) => state.status)).toContain("preparing");
    expect(states.at(-1)).toMatchObject({ status: "thinking", cancellable: true });

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("complete"), {
      timeout: 1_000,
      interval: 20,
    });
  });

  it("interrupts an in-flight prompt when a follow-up user message is queued", async () => {
    const states: UnifiedCardState[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "first long task" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1), {
      timeout: 1_000,
      interval: 20,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "urgent follow-up" }],
      messageId: "om_followup",
      chatId: "oc_test",
      progressCardId: "card_followup",
    });

    expect(fake.cancelCalls()).toBe(1);
    expect(states.slice(-2).map((state) => state.status)).toEqual(["queued", "interrupting"]);

    fake.resolvePrompt("cancelled");

    await vi.waitFor(
      () => {
        expect(fake.prompts()).toHaveLength(2);
        expect(fake.prompts()[1]).toContain("urgent follow-up");
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(states.at(-1)).toMatchObject({ status: "thinking", cancellable: true });
  });

  it("respawns and preserves the queued follow-up if interrupt closes the agent", async () => {
    const states: UnifiedCardState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const first = makeFakeAgent();
    const second = makeFakeAgent();
    spawnAgentMock.mockResolvedValueOnce(first.agent).mockResolvedValueOnce(second.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "first long task" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(first.prompts()).toHaveLength(1), {
      timeout: 1_000,
      interval: 20,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "urgent follow-up after crash" }],
      messageId: "om_followup",
      chatId: "oc_test",
      progressCardId: "card_followup",
    });
    first.closeConnection();

    await vi.waitFor(
      () => {
        expect(second.prompts()).toHaveLength(1);
        expect(second.prompts()[0]).toContain("urgent follow-up after crash");
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(notices.some((notice) => notice.title === "⚠️ Agent 异常退出")).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: "thinking", cancellable: true });
  });

  it("marks the queued message card terminal when the queued message is cancelled", async () => {
    const states: UnifiedCardState[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "first long task" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    await runtime.enqueue({
      prompt: [{ type: "text", text: "queued follow-up" }],
      messageId: "om_followup",
      chatId: "oc_test",
      progressCardId: "card_followup",
    });

    await runtime.cancel();

    expect(states.at(-1)).toMatchObject({
      status: "cancelled",
      entries: [{ kind: "text", text: "排队的新消息已取消。" }],
    });
    fake.resolvePrompt("cancelled");
  });

  it("does not respawn a queued follow-up when explicit cancel races an agent disconnect", async () => {
    const states: UnifiedCardState[] = [];
    const first = makeFakeAgent();
    const second = makeFakeAgent();
    spawnAgentMock.mockResolvedValueOnce(first.agent).mockResolvedValueOnce(second.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "first long task" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(first.prompts()).toHaveLength(1));
    await runtime.enqueue({
      prompt: [{ type: "text", text: "queued follow-up" }],
      messageId: "om_followup",
      chatId: "oc_test",
      progressCardId: "card_followup",
    });

    const releaseCancel = first.holdNextCancel();
    const cancellation = runtime.cancel();
    await vi.waitFor(() => expect(first.cancelCalls()).toBe(2));
    first.closeConnection();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("cancelled"));
    releaseCancel();
    await cancellation;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(second.prompts()).toEqual([]);
  });

  it("marks the card cancelled when a requested cancellation closes the agent connection", async () => {
    const states: UnifiedCardState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "long task" }],
      messageId: "om_1",
      chatId: "oc_test",
    });
    await runtime.cancel();
    fake.closeConnection();

    await vi.waitFor(
      () => {
        expect(states.at(-1)?.status).toBe("cancelled");
        expect(states.at(-1)?.cancellable).toBe(false);
        expect(notices.at(-1)).toMatchObject({ title: "⛔ Agent 已中断", template: "grey" });
      },
      { timeout: 1_000, interval: 20 },
    );
  });

  it("forces an in-flight card to a terminal state when the bridge shuts down", async () => {
    const states: UnifiedCardState[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "restart the bridge" }],
      messageId: "om_restart",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));

    await runtime.shutdown("cancelled");

    expect(states.at(-1)).toMatchObject({ status: "cancelled", cancellable: false });
  });

  it("silently discards an idle agent that exits unexpectedly and respawns on demand", async () => {
    const states: UnifiedCardState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const first = makeFakeAgent();
    const second = makeFakeAgent();
    spawnAgentMock.mockResolvedValueOnce(first.agent).mockResolvedValueOnce(second.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_idle",
      chatId: "oc_test",
    });
    first.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    first.exitProcess(42, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notices).toEqual([]);

    await runtime.enqueue({
      prompt: [{ type: "text", text: "after idle exit" }],
      messageId: "om_after_idle",
      chatId: "oc_test",
    });

    expect(spawnAgentMock).toHaveBeenCalledTimes(2);
    second.resolvePrompt("end_turn");
  });

  it("still finalizes normally when the prompt resolves before any close", async () => {
    const states: UnifiedCardState[] = [];
    const replies: string[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const presenter = recordingPresenter(states);
    // Capture any error replies — a normal turn must not surface a crash notice.
    presenter.replyText = async (_id, text) => {
      replies.push(text);
    };

    const runtime = new ChatRuntime({
      ...opts(),
      presenter,
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_2",
      chatId: "oc_test",
    });

    // Normal turn end, then the process exits and its stream closes. The
    // losing race branch must not throw an unhandled rejection or a crash
    // notice after a clean completion.
    fake.resolvePrompt("end_turn");
    await vi.waitFor(
      () => {
        const last = states.at(-1);
        expect(last?.status, "final card should read as complete").toBe("complete");
        expect(last?.cancellable).toBe(false);
      },
      { timeout: 1_000, interval: 20 },
    );

    fake.closeConnection();
    // Let any stray rejection from the losing race branch surface.
    await new Promise((r) => setTimeout(r, 50));
    expect(replies, "a clean turn must not produce an error/crash reply").toEqual([]);
  });

  it("logs prompt usage when a turn completes with no renderable output", async () => {
    const states: UnifiedCardState[] = [];
    const logs: Array<{ obj: object; msg?: string }> = [];
    const logger: LarkLogger = {
      debug: () => {},
      info: (obj: string | object, msg?: string) => {
        if (typeof obj === "object") logs.push({ obj, msg });
      },
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const fake = makeFakeAgent();
    let resolvePrompt: (r: acp.PromptResponse) => void = () => {};
    const promptResult = new Promise<acp.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    fake.agent.connection.prompt = () => promptResult;
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(logger),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "silent turn" }],
      messageId: "om_empty",
      chatId: "oc_test",
    });
    resolvePrompt({
      stopReason: "end_turn",
      usage: { inputTokens: 71_395, outputTokens: 16_000, totalTokens: 87_395 },
    });

    await vi.waitFor(
      () => {
        expect(states.at(-1)?.status).toBe("complete");
        expect(runtime.processing).toBe(false);
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(logs).toContainEqual({
      obj: {
        stopReason: "end_turn",
        usage: { inputTokens: 71_395, outputTokens: 16_000, totalTokens: 87_395 },
      },
      msg: "prompt done",
    });
  });

  it("does not persist humming context metadata as the ACP session title", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const saved: unknown[] = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      save: async (record) => {
        saved.push(record);
      },
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "please fix the bug" }],
      messageId: "om_title",
      chatId: "oc_test",
    });

    const spawnOpts = spawnAgentMock.mock.calls[0]?.[0] as { client: HummingClient };
    await spawnOpts.client.sessionUpdate({
      sessionId: "sess_fake",
      update: {
        sessionUpdate: "session_info_update",
        title: '[上下文: 群聊 "Lark ACP" (oc_x) 中用户 ou_x 的消息]',
        updatedAt: "2026-07-06T06:00:00.000Z",
      },
    });
    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    expect(saved.at(-1)).toMatchObject({ sessionUpdatedAt: "2026-07-06T06:00:00.000Z" });
    expect(saved.at(-1)).not.toMatchObject({ title: expect.stringContaining("[上下文:") });
  });

  it("does not persist a stale session when a superseded prompt later resolves", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const saved: unknown[] = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      save: async (record) => {
        saved.push(record);
      },
    };
    const states: UnifiedCardState[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: store,
      agentLabel: "claude",
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "long task" }],
      messageId: "om_supersede",
      chatId: "oc_test",
    });
    await runtime.supersede();
    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    expect(saved).toHaveLength(1);
    expect(saved.at(-1)).toMatchObject({ sessionId: "sess_fake", agentLabel: "claude" });
    expect(states.at(-1)).toMatchObject({ status: "complete", cancellable: false });
  });

  it("does not create a phantom cancelled card when superseded after prompt state reset", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const states: UnifiedCardState[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
      agentLabel: "claude",
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "quick command" }],
      messageId: "om_supersede_after_done",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
    const renderedBeforeSupersede = states.length;

    await runtime.supersede();

    expect(states).toHaveLength(renderedBeforeSupersede);
    expect(states.some((state) => state.status === "cancelled")).toBe(false);
  });

  it("does not create a phantom cancelled card when shutdown happens after prompt state reset", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const states: UnifiedCardState[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
      agentLabel: "claude",
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "quick command" }],
      messageId: "om_shutdown_after_done",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
    const renderedBeforeShutdown = states.length;

    await runtime.shutdown("cancelled");

    expect(states).toHaveLength(renderedBeforeShutdown);
    expect(states.some((state) => state.status === "cancelled")).toBe(false);
  });

  it("rejects live control changes while a prompt is in flight", async () => {
    const fake = makeFakeAgent();
    const setMode = vi.fn(async () => ({}));
    fake.agent.connection = {
      ...fake.agent.connection,
      setSessionMode: setMode,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "long task" }],
      messageId: "om_busy_controls",
      chatId: "oc_test",
    });

    await expect(runtime.applyControls({ modeId: "agent" })).rejects.toThrow(
      "cannot be changed while this topic has an in-flight prompt",
    );
    expect(setMode).not.toHaveBeenCalled();
  });

  it("applies controls queued during an in-flight turn as soon as that turn finishes", async () => {
    const fake = makeFakeAgent();
    fake.agent.sessionCapabilities = {
      ...fake.agent.sessionCapabilities,
      configOptions: [
        { id: "agent", name: "Agent", type: "select", currentValue: "copilot", options: [] },
        { id: "mode", name: "Mode", type: "select", currentValue: "agent", options: [] },
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "model-old",
          options: [],
        },
        {
          id: "reasoning",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "high",
          options: [],
        },
        { id: "allow_all", name: "Allow All", type: "boolean", currentValue: false },
      ],
    } as AgentProcess["sessionCapabilities"];
    const setModel = vi.fn(async () => ({}));
    const prompt = vi.fn(fake.agent.connection.prompt.bind(fake.agent.connection));
    fake.agent.connection = {
      ...fake.agent.connection,
      prompt,
      unstable_setSessionModel: setModel,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    let latest: SessionRecord | null = null;
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const noticeUpdates: Array<{ title: string; body: string; template: string }> = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      getLatest: async () => latest,
      save: async (record) => {
        latest = record;
      },
      consumePendingControls: async () => {
        if (!latest?.pendingControls) return { record: latest!, pendingControls: undefined };
        const pendingControls = latest.pendingControls;
        const noticeMessageId = latest.pendingControlsNoticeMessageId;
        latest = {
          ...latest,
          pendingControls: undefined,
          pendingControlsNoticeMessageId: undefined,
        };
        return { record: latest, pendingControls, noticeMessageId };
      },
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([], notices, noticeUpdates),
      sessionStore: store,
      agentLabel: "copilot",
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "change my mode" }],
      messageId: "om_pending_current_turn",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
      interval: 20,
    });
    expect(latest, "bootstrap should persist the session before the prompt runs").toBeTruthy();
    latest = {
      ...latest!,
      pendingControls: { modelId: "model-new" },
      pendingControlsNoticeMessageId: "notice_msg",
    };

    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "model-new" });
    expect(latest).toMatchObject({ controls: { modelId: "model-new" } });
    expect(latest?.pendingControls).toBeUndefined();
    expect(latest?.pendingControlsNoticeMessageId).toBeUndefined();
    expect(notices).toEqual([]);
    expect(noticeUpdates.at(-1)).toMatchObject({
      title: "✅ 排队的 Session profile 已生效",
      template: "green",
    });
    expect(noticeUpdates.at(-1)?.body).toContain("Agent：copilot");
    expect(noticeUpdates.at(-1)?.body).toContain("Model：Old → New");
    expect(noticeUpdates.at(-1)?.body).toContain("Controls：—");
    expect(noticeUpdates.at(-1)?.body).not.toContain("Reasoning Effort: high");
    expect(noticeUpdates.at(-1)?.body).not.toContain("Controls：Agent:");
    expect(noticeUpdates.at(-1)?.body).not.toContain("Mode: agent");
    expect(noticeUpdates.at(-1)?.body).not.toContain("Model: model-old");
    expect(noticeUpdates.at(-1)?.body).not.toContain("Controls：Allow All:");
  });

  it("runs a pending task immediately after current-turn controls become live", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    const prompt = vi.fn(fake.agent.connection.prompt.bind(fake.agent.connection));
    fake.agent.connection = {
      ...fake.agent.connection,
      prompt,
      unstable_setSessionModel: setModel,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    let latest: SessionRecord | null = null;
    const store: SessionStore = {
      ...stubSessionStore(),
      getLatest: async () => latest,
      save: async (record) => {
        latest = record;
      },
      consumePendingControls: async () => {
        if (!latest?.pendingControls) return { record: latest!, pendingControls: undefined };
        const pendingControls = latest.pendingControls;
        const noticeMessageId = latest.pendingControlsNoticeMessageId;
        latest = {
          ...latest,
          pendingControls: undefined,
          pendingControlsNoticeMessageId: undefined,
        };
        return { record: latest, pendingControls, noticeMessageId };
      },
      consumePendingTask: async () => {
        if (!latest?.pendingTask) return { record: latest!, pendingTask: undefined };
        const pendingTask = latest.pendingTask;
        latest = { ...latest, pendingTask: undefined };
        return { record: latest, pendingTask };
      },
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "switch model then do work" }],
      messageId: "om_pending_task",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
      interval: 20,
    });
    latest = {
      ...latest!,
      pendingControls: { modelId: "model-new" },
      pendingTask: { prompt: "implement the pending task", createdAt: Date.now() },
    };

    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
      interval: 20,
    });
    expect(setModel).toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "model-new" });
    expect(prompt.mock.calls[1]?.[0].prompt).toEqual(
      expect.arrayContaining([{ type: "text", text: "implement the pending task" }]),
    );
    expect(latest?.pendingTask).toBeUndefined();

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
  });

  it("applies persisted pending controls after restart before sending the first resumed prompt", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    const prompt = vi.fn(fake.agent.connection.prompt.bind(fake.agent.connection));
    fake.agent.connection = {
      ...fake.agent.connection,
      prompt,
      unstable_setSessionModel: setModel,
    } as AgentProcess["connection"];
    spawnAndResumeAgentMock.mockResolvedValue({ agent: fake.agent, resumed: true });

    let latest: SessionRecord | null = {
      chatId: "oc_test",
      threadId: null,
      sessionId: "sess_fake",
      agentCommand: "node",
      agentArgs: [],
      cwd: "/tmp",
      controls: { modelId: "model-old" },
      pendingControls: { modelId: "model-new" },
      createdAt: 1,
      updatedAt: 2,
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: {
        ...stubSessionStore(),
        getLatest: async () => latest,
        save: async (record) => {
          latest = record;
        },
        consumePendingControls: async () => {
          if (!latest?.pendingControls) return { record: latest!, pendingControls: undefined };
          const pendingControls = latest.pendingControls;
          latest = { ...latest, pendingControls: undefined };
          return { record: latest, pendingControls };
        },
      },
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "after restart" }],
      messageId: "om_pending_restart",
      chatId: "oc_test",
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
      interval: 20,
    });
    const appliedCall = setModel.mock.calls.findIndex((call) => call[0].modelId === "model-new");
    expect(appliedCall).toBeGreaterThanOrEqual(0);
    expect(setModel.mock.invocationCallOrder[appliedCall]).toBeLessThan(
      prompt.mock.invocationCallOrder[0]!,
    );
    expect(latest).toMatchObject({ controls: { modelId: "model-new" } });
    expect(latest?.pendingControls).toBeUndefined();
  });

  it("suppresses historical tool updates replayed while resuming a session", async () => {
    const fake = makeFakeAgent();
    spawnAndResumeAgentMock.mockImplementationOnce(async (spawnOptions) => {
      await spawnOptions.client.sessionUpdate({
        sessionId: "sess_fake",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "historical_tool",
          title: "Historical tool",
          kind: "read",
          status: "completed",
        },
      });
      return { agent: fake.agent, resumed: true };
    });

    const states: UnifiedCardState[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: {
        ...stubSessionStore(),
        getLatest: async () => ({
          chatId: "oc_test",
          threadId: null,
          sessionId: "sess_fake",
          agentCommand: "node",
          agentArgs: [],
          cwd: "/tmp",
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "after restart" }],
      messageId: "om_resume",
      chatId: "oc_test",
    });

    await vi.waitFor(() => expect(fake.prompts()).toEqual(["after restart"]), {
      timeout: 1_000,
      interval: 20,
    });
    expect(
      states.some((state) =>
        state.entries.some(
          (entry) => entry.kind === "tool" && entry.toolCallId === "historical_tool",
        ),
      ),
    ).toBe(false);

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
  });

  it("cleans invalid persisted controls before applying stored session settings", async () => {
    const fake = makeFakeAgent();
    const setMode = vi.fn(async () => ({}));
    fake.agent.connection = {
      ...fake.agent.connection,
      setSessionMode: setMode,
    } as AgentProcess["connection"];
    spawnAndResumeAgentMock.mockResolvedValue({ agent: fake.agent, resumed: true });

    const saved: SessionRecord[] = [];
    const record: SessionRecord = {
      chatId: "oc_test",
      threadId: null,
      sessionId: "sess_fake",
      agentCommand: "node",
      agentArgs: [],
      cwd: "/tmp",
      controls: { modeId: "bypassPermissions", config: {} },
      createdAt: 1,
      updatedAt: 2,
    };
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([], notices),
      sessionStore: {
        ...stubSessionStore(),
        getLatest: async () => record,
        save: async (updated) => {
          saved.push(updated);
        },
      },
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_stored_controls",
      chatId: "oc_test",
    });

    expect(setMode).not.toHaveBeenCalledWith({
      sessionId: "sess_fake",
      modeId: "bypassPermissions",
    });
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "sess_fake", controls: undefined }),
      ]),
    );
    expect(notices.at(-1)).toMatchObject({ title: "⚠️ 已忽略无效的 session 设置" });
    expect(notices.at(-1)?.body).toContain("Mode bypassPermissions");
  });

  it("clears an explicit live model override for /model auto without sending literal auto", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    fake.agent.connection = {
      ...fake.agent.connection,
      unstable_setSessionModel: setModel,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    let latest: SessionRecord | null = null;
    const saved: SessionRecord[] = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      getLatest: async () => latest,
      save: async (record) => {
        latest = record;
        saved.push(record);
      },
    };
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([], notices),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_model_auto",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    await runtime.applyControls({ clearModelId: true }, "om_model_auto_cmd");

    expect(setModel).not.toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "auto" });
    expect(runtime.capabilities().models?.currentModelId).toBeUndefined();
    expect(saved.at(-1)?.controls).not.toHaveProperty("modelId");
    expect(notices.at(-1)).toMatchObject({ title: "✅ Session profile 已更新", template: "green" });
    expect(notices.at(-1)?.body).toContain("Model：Old → —");
  });

  it("applies and reports session controls with ACP-shaped requests", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    const setMode = vi.fn(async () => ({}));
    const setConfig = vi.fn(async () => ({
      configOptions: [
        { id: "auto_edit", name: "Auto Edit", type: "boolean", currentValue: true },
        {
          id: "approval_mode",
          name: "Approval Mode",
          type: "select",
          currentValue: "auto",
          options: [
            { name: "Ask", value: "ask" },
            { name: "Auto", value: "auto" },
          ],
        },
      ],
    }));
    fake.agent.connection = {
      ...fake.agent.connection,
      unstable_setSessionModel: setModel,
      setSessionMode: setMode,
      setSessionConfigOption: setConfig,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    const saved: unknown[] = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      save: async (record) => {
        saved.push(record);
      },
    };
    const states: UnifiedCardState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_controls",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    await runtime.applyControls({
      modelId: "model-new",
      modeId: "agent",
      config: {
        auto_edit: { type: "boolean", value: true },
        approval_mode: { value: "auto" },
      },
      bridgePermissionMode: "alwaysAsk",
    });

    expect(setModel).toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "model-new" });
    expect(setMode).toHaveBeenCalledWith({ sessionId: "sess_fake", modeId: "agent" });
    expect(setConfig).toHaveBeenCalledWith({
      sessionId: "sess_fake",
      configId: "auto_edit",
      type: "boolean",
      value: true,
    });
    expect(setConfig).toHaveBeenCalledWith({
      sessionId: "sess_fake",
      configId: "approval_mode",
      value: "auto",
    });
    expect(runtime.capabilities()).toMatchObject({
      models: { currentModelId: "model-new" },
      modes: { currentModeId: "agent" },
      bridgePermissionMode: "alwaysAsk",
    });

    expect(saved.at(-1)).toMatchObject({
      controls: {
        modelId: "model-new",
        modeId: "agent",
        config: {
          auto_edit: { type: "boolean", value: true },
          approval_mode: { value: "auto" },
        },
        bridgePermissionMode: "alwaysAsk",
      },
    });
    const notice = notices.at(-1);
    expect(notice).toMatchObject({ title: "✅ Session profile 已更新", template: "green" });
    expect(notice?.body).toContain("当前 topic 的 session profile 已切换");
    expect(notice?.body).toContain("Agent：node");
    expect(notice?.body).toContain("Mode：Ask → Agent");
    expect(notice?.body).toContain("Model：Old → New");
    expect(notice?.body).toContain("Permission：Auto approve → Ask approvals");
    expect(notice?.body).toContain("Control Auto Edit：off → on");
    expect(notice?.body).toContain("Control Approval Mode：Ask → Auto");
    expect(notice?.body).toContain("Permission：Auto Edit: on · Approval Mode: Auto");
    expect(notice?.body).toContain("Controls：Auto Edit: on · Approval Mode: Auto");
  });

  it("rejects invalid controls without mutating runtime or persisted session", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    fake.agent.connection = {
      ...fake.agent.connection,
      unstable_setSessionModel: setModel,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    const saved: unknown[] = [];
    const store: SessionStore = {
      ...stubSessionStore(),
      save: async (record) => {
        saved.push(record);
      },
    };
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([], notices),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_controls_failed",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    await expect(runtime.applyControls({ modelId: "missing-model" })).rejects.toThrow(
      "Model missing-model",
    );

    expect(setModel).not.toHaveBeenCalled();
    expect(runtime.capabilities()).toMatchObject({ models: { currentModelId: "model-old" } });
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).not.toMatchObject({ controls: { modelId: "missing-model" } });
    expect(notices.at(-1)).toMatchObject({ title: "⚠️ Session 设置失败", template: "red" });
    expect(notices.at(-1)?.body).toContain("失败项: Model missing-model");
    expect(notices.at(-1)?.body).toContain("runtime 和 sessions.json 未更新");
  });

  it("rolls back ACP changes when a later control fails", async () => {
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    const setMode = vi.fn(async () => {
      throw new Error("mode rejected");
    });
    fake.agent.connection = {
      ...fake.agent.connection,
      unstable_setSessionModel: setModel,
      setSessionMode: setMode,
    } as AgentProcess["connection"];
    spawnAgentMock.mockResolvedValue(fake.agent);

    const saved: unknown[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: {
        ...stubSessionStore(),
        save: async (record) => {
          saved.push(record);
        },
      },
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_controls_rollback",
      chatId: "oc_test",
    });
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });

    await expect(runtime.applyControls({ modelId: "model-new", modeId: "agent" })).rejects.toThrow(
      "Mode agent: mode rejected",
    );

    expect(setModel).toHaveBeenNthCalledWith(1, { sessionId: "sess_fake", modelId: "model-new" });
    expect(setModel).toHaveBeenNthCalledWith(2, { sessionId: "sess_fake", modelId: "model-old" });
    expect(runtime.capabilities()).toMatchObject({
      models: { currentModelId: "model-old" },
      modes: { currentModeId: "ask" },
    });
    expect(saved).toHaveLength(2);
  });
});
