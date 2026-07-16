import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { ChatRuntime } from "./chat-runtime.js";
import { HummingClient } from "../acp/humming-client.js";
import type { ChatRuntimeOptions } from "./chat-runtime.js";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import type { AgentStatus, LarkPresenter } from "../presenter/presenter.js";
import type { SessionRecord, SessionStore } from "../session-store/session-store.js";
import type { AgentProcess, SpawnAgentOptions } from "../acp/agent-process.js";

import { RingBufferLifecycleDiagnosticSink } from "../acp/lifecycle-diagnostics.js";
import type {
  ActionToken,
  PermissionToken,
  PromptToken,
  SegmentToken,
} from "../presenter/conversation-card-view.js";

// The agent subprocess is the correct mock boundary: we replace `spawnAgent`
// so no real process is spawned, then hand ChatRuntime a fake AgentProcess
// whose connection we fully control. Everything else in the module (notably
// `AgentDisconnectedError`, which the disconnect path throws) is kept real via
// `importOriginal`, so only the process-spawning side effect is stubbed.
const spawnAgentMock = vi.fn<(opts: unknown) => Promise<AgentProcess>>();
const killAgentMock = vi.fn<(process: AgentProcess["process"]) => void>();
const spawnAndResumeAgentMock =
  vi.fn<
    (opts: SpawnAgentOptions, id: string) => Promise<{ agent: AgentProcess; resumed: boolean }>
  >();
const spawnAndStrictlyResumeAgentMock =
  vi.fn<(opts: SpawnAgentOptions, id: string) => Promise<AgentProcess>>();

vi.mock("../acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/agent-process.js")>();
  return {
    ...actual,
    spawnAgent: (opts: unknown) => spawnAgentMock(opts),
    spawnAndResumeAgent: (opts: SpawnAgentOptions, id: string) => spawnAndResumeAgentMock(opts, id),
    spawnAndStrictlyResumeAgent: (opts: SpawnAgentOptions, id: string) =>
      spawnAndStrictlyResumeAgentMock(opts, id),
    killAgent: (process: AgentProcess["process"]) => killAgentMock(process),
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

describe("ChatRuntime prompt preparation", () => {
  beforeEach(() => {
    spawnAgentMock.mockReset();
    spawnAndResumeAgentMock.mockReset();
    spawnAndStrictlyResumeAgentMock.mockReset();
    killAgentMock.mockReset();
  });

  it("releases hydration waiters when shutdown occurs before the first admission hydrates", async () => {
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    runtime.acceptResponse({ messageId: "om_a", content: "A", profile: null });
    const b = runtime.acceptResponse({ messageId: "om_b", content: "B", profile: null });
    const waiting = runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
      response: b,
    });

    await runtime.shutdown();
    await expect(waiting).rejects.toThrow("runtime was shut down");
  });

  it("shares one bootstrap when two messages enqueue concurrently", async () => {
    const fake = makeFakeAgent();
    let releaseSpawn!: () => void;
    const spawnBlocked = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    spawnAgentMock.mockImplementation(async () => {
      await spawnBlocked;
      return fake.agent;
    });
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });

    const first = runtime.enqueue({
      prompt: [{ type: "text", text: "first" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    const second = runtime.enqueue({
      prompt: [{ type: "text", text: "second" }],
      messageId: "om_second",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(spawnAgentMock).toHaveBeenCalledOnce());
    releaseSpawn();
    await Promise.all([first, second]);
    expect(spawnAgentMock).toHaveBeenCalledOnce();
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(fake.prompts()).toContain("first"));
  });

  it("strictly resumes the persisted Session without sending a prompt", async () => {
    const fake = makeFakeAgent();
    spawnAndStrictlyResumeAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
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

    await runtime.startStrictResume("sess_fake", "om_restart");

    expect(spawnAndStrictlyResumeAgentMock).toHaveBeenCalledOnce();
    expect(spawnAndStrictlyResumeAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "node", cwd: "/tmp" }),
      "sess_fake",
    );
    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(spawnAndResumeAgentMock).not.toHaveBeenCalled();
    expect(fake.prompts()).toEqual([]);
  });

  it("holds a new message until strict Session resume completes", async () => {
    const fake = makeFakeAgent();
    let releaseResume!: () => void;
    const resumeBlocked = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    spawnAndStrictlyResumeAgentMock.mockImplementation(async () => {
      await resumeBlocked;
      return fake.agent;
    });
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
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

    const restart = runtime.startStrictResume("sess_fake", "om_restart");
    await vi.waitFor(() => expect(spawnAndStrictlyResumeAgentMock).toHaveBeenCalledOnce());
    const enqueue = runtime.enqueue({
      prompt: [{ type: "text", text: "after restart" }],
      messageId: "om_after",
      chatId: "oc_test",
    });
    expect(fake.prompts()).toEqual([]);

    releaseResume();
    await Promise.all([restart, enqueue]);
    await vi.waitFor(() => expect(fake.prompts()).toEqual(["after restart"]));
    fake.resolvePrompt("end_turn");
  });

  it("rejects strict restart when the persisted Session identity changed", async () => {
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: {
        ...stubSessionStore(),
        getLatest: async () => ({
          chatId: "oc_test",
          threadId: null,
          sessionId: "sess_other",
          agentCommand: "node",
          agentArgs: [],
          cwd: "/tmp",
          createdAt: 1,
          updatedAt: 2,
        }),
      },
    });

    await expect(runtime.startStrictResume("sess_expected", "om_restart")).rejects.toThrow(
      "Persisted session sess_expected is not available",
    );
    expect(spawnAndStrictlyResumeAgentMock).not.toHaveBeenCalled();
  });

  for (const operation of ["cancel", "shutdown", "supersede"] as const) {
    it(`invalidates a bootstrap that finishes after ${operation}`, async () => {
      const fake = makeFakeAgent();
      let releaseSpawn!: () => void;
      const spawnBlocked = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
      spawnAgentMock.mockImplementation(async () => {
        await spawnBlocked;
        return fake.agent;
      });
      const runtime = new ChatRuntime({
        ...opts(),
        presenter: recordingPresenter([]),
        sessionStore: stubSessionStore(),
      });
      const response = runtime.acceptResponse({
        messageId: `om_${operation}`,
        content: operation,
        profile: null,
      });
      const enqueue = runtime.enqueue({
        prompt: [{ type: "text", text: operation }],
        messageId: `om_${operation}`,
        chatId: "oc_test",
        response,
      });
      await vi.waitFor(() => expect(spawnAgentMock).toHaveBeenCalledOnce());

      await runtime[operation]();
      releaseSpawn();
      await enqueue;

      await vi.waitFor(() =>
        expect(killAgentMock).toHaveBeenCalledExactlyOnceWith(fake.agent.process),
      );
      expect(fake.prompts()).toEqual([]);
      expect(runtime.processing).toBe(false);
      expect(response.isRunnable()).toBe(false);
    });
  }

  it("stops the admission drain after bootstrap failure instead of spawning for B", async () => {
    spawnAgentMock.mockRejectedValue(new Error("bootstrap failed"));
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const a = runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
    });
    const b = runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
    });

    await expect(a).rejects.toThrow("bootstrap failed");
    await expect(b).rejects.toThrow("runtime bootstrap failed");
    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(runtime.processing).toBe(false);
  });

  it("kills an Agent when bootstrap fails after spawn succeeds", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const bootstrapInternals = runtime as unknown as {
      persistSession(): Promise<void>;
    };
    bootstrapInternals.persistSession = async () => {
      throw new Error("persist failed");
    };

    await expect(
      runtime.enqueue({
        prompt: [{ type: "text", text: "A" }],
        messageId: "om_post_spawn_failure",
        chatId: "oc_test",
      }),
    ).rejects.toThrow("persist failed");

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith(fake.agent.process);
    expect(fake.prompts()).toEqual([]);
    expect(runtime.processing).toBe(false);
  });

  it("kills exactly once when cancel intersects a post-spawn bootstrap failure", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    let rejectPersist!: (error: Error) => void;
    const persistBlocked = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject;
    });
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const bootstrapInternals = runtime as unknown as {
      persistSession(): Promise<void>;
    };
    bootstrapInternals.persistSession = async () => persistBlocked;
    const enqueue = runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_cancel_post_spawn_failure",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(spawnAgentMock).toHaveBeenCalledOnce());

    await runtime.cancel();
    rejectPersist(new Error("persist failed after cancel"));
    await enqueue;

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith(fake.agent.process);
    expect(fake.prompts()).toEqual([]);
    expect(runtime.processing).toBe(false);
  });

  it("allocates distinct Responses in one shared Topic aggregate", () => {
    const runtime = new ChatRuntime({
      ...opts(),
      lifecycleDiagnostics: new RingBufferLifecycleDiagnosticSink(),
    });

    const first = runtime.acceptResponse({
      messageId: "om_first",
      content: "first",
      profile: null,
    });
    const second = runtime.acceptResponse({
      messageId: "om_second",
      content: "second",
      profile: null,
    });

    expect(first.responseId).not.toBe(second.responseId);
    expect(first.responseToken).not.toBe(second.responseToken);
  });

  it("routes stale token actions through the shared Topic authority", async () => {
    const runtime = new ChatRuntime({
      ...opts(),
    });
    const response = runtime.acceptResponse({
      messageId: "om_test",
      content: "test",
      profile: null,
    });

    expect(
      runtime.consumeCancelAction({
        promptToken: "previous" as PromptToken,
        segmentToken: "card" as SegmentToken,
        actionToken: "action" as ActionToken,
      }),
    ).toBe("stale");
    expect(
      runtime.consumePermissionAction({
        promptToken: response.responseToken,
        permissionToken: "permission" as PermissionToken,
        requestId: "request",
        optionId: "allow",
      }),
    ).toBe("stale");
  });

  it("treats token actions as stale when no semantic prompt owns them", () => {
    const runtime = new ChatRuntime(opts());
    expect(
      runtime.consumeCancelAction({
        promptToken: "prompt" as PromptToken,
        segmentToken: "segment" as SegmentToken,
        actionToken: "action" as ActionToken,
      }),
    ).toBe("stale");
    expect(
      runtime.consumePermissionAction({
        promptToken: "prompt" as PromptToken,
        permissionToken: "permission" as PermissionToken,
        requestId: "request",
        optionId: "option",
      }),
    ).toBe("stale");
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
interface RecordedConversationState {
  readonly status: AgentStatus | "interrupted" | "merged" | "superseded" | "abandoned";
  readonly cancellable: boolean;
  readonly entries: readonly unknown[];
}

function recordedState(
  view: Parameters<LarkPresenter["sendConversationCard"]>[1],
): RecordedConversationState {
  const status =
    view.kind === "queued"
      ? "received"
      : view.kind === "starting"
        ? "preparing"
        : view.kind === "active" || view.kind === "terminal"
          ? view.header
          : view.kind;
  return {
    status,
    cancellable: view.action?.kind === "cancel",
    entries: "entries" in view ? view.entries : [],
  };
}

function recordingPresenter(
  states: RecordedConversationState[],
  notices: Array<{ title: string; body: string; template: string }> = [],
  noticeUpdates: Array<{ title: string; body: string; template: string }> = [],
): LarkPresenter {
  return {
    replyText: async () => {},
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
    sendConversationCard: async (_id, view) => {
      states.push(recordedState(view));
      return "card_msg_1";
    },
    updateConversationCard: async (_id, view) => {
      states.push(recordedState(view));
      return true;
    },
    sendPermissionRequestCard: async () => "permission_card",
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
    setPendingConfiguration: async () => {
      throw new Error("setPendingConfiguration not implemented in stub");
    },
    clearPendingConfigurationIfMatches: async () => {
      throw new Error("clearPendingConfigurationIfMatches not implemented in stub");
    },
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
    once: (
      event: string,
      handler: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => {
      if (event === "exit") exitHandler = handler;
      return proc;
    },
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
    killAgentMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a non-cancellable final card after the connection closes", async () => {
    const states: RecordedConversationState[] = [];
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

  it("shows preparing throughout cold bootstrap before activating the Response", async () => {
    const states: RecordedConversationState[] = [];
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
    });

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("received"), {
      timeout: 1_000,
      interval: 20,
    });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("preparing"), {
      timeout: 1_000,
      interval: 20,
    });

    resolveSpawn(fake.agent);
    await enqueue;

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("processing"), {
      timeout: 1_000,
      interval: 20,
    });
    expect(states.map((state) => state.status)).toContain("received");
    expect(states.map((state) => state.status)).toContain("preparing");
    expect(states.at(-1)).toMatchObject({ status: "processing", cancellable: false });

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("complete"), {
      timeout: 1_000,
      interval: 20,
    });
  });

  it("binds a distinct prepared lifecycle for each queued prompt", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const sendConversationCard = vi.fn(async () => "semantic-card");
    const updateConversationCard = vi.fn(async () => true);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: {
        ...recordingPresenter([]),
        sendConversationCard,
        updateConversationCard,
      },
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "first" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    await runtime.enqueue({
      prompt: [{ type: "text", text: "second" }],
      messageId: "om_second",
      chatId: "oc_test",
    });
    fake.resolvePrompt("cancelled");
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(sendConversationCard).toHaveBeenCalled());

    const routes = sendConversationCard.mock.calls.map(([, view]) => view.route.c);
    expect(routes).toEqual(expect.arrayContaining(["oc_test"]));
  });

  it("preserves admission order when B hydrates before the first A", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const a = runtime.acceptResponse({ messageId: "om_a", content: "A", profile: null });
    const b = runtime.acceptResponse({ messageId: "om_b", content: "B", profile: null });

    const enqueueB = runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
      response: b,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.prompts()).toEqual([]);
    const enqueueA = runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
      response: a,
    });

    await Promise.all([enqueueA, enqueueB]);
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    expect(fake.prompts()[0]).toContain("A");
    fake.resolvePrompt("cancelled");
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    expect(fake.prompts()[1]).toContain("B");
  });

  it("continues with C when merged B hydration is abandoned", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const a = runtime.acceptResponse({ messageId: "om_a", content: "A", profile: null });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
      response: a,
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    const b = runtime.acceptResponse({ messageId: "om_b", content: "B", profile: null });
    const c = runtime.acceptResponse({ messageId: "om_c", content: "C", profile: null });

    runtime.abandonHydration(b.responseId);
    await b.fail("hydrate failed");
    await runtime.enqueue({
      prompt: [{ type: "text", text: "C" }],
      messageId: "om_c",
      chatId: "oc_test",
      response: c,
    });
    fake.resolvePrompt("cancelled");
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    expect(fake.prompts()[1]).not.toContain("B");
    expect(fake.prompts()[1]).toContain("C");
  });

  it("rebuilds B and C in admission order when C hydrates first", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const a = runtime.acceptResponse({ messageId: "om_a", content: "A", profile: null });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
      response: a,
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    const b = runtime.acceptResponse({ messageId: "om_b", content: "B", profile: null });
    const c = runtime.acceptResponse({ messageId: "om_c", content: "C", profile: null });
    const enqueueC = runtime.enqueue({
      prompt: [{ type: "text", text: "C" }],
      messageId: "om_c",
      chatId: "oc_test",
      response: c,
    });
    const enqueueB = runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
      response: b,
    });
    await Promise.all([enqueueB, enqueueC]);
    fake.resolvePrompt("cancelled");
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    const combined = fake.prompts()[1] ?? "";
    expect(combined).toContain("B");
    expect(combined).toContain("C");
    expect(combined.indexOf("B")).toBeLessThan(combined.indexOf("C"));
  });

  it("waits for an accepted carrier that finishes hydration after the owner stops", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const a = runtime.acceptResponse({ messageId: "om_a", content: "A", profile: null });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
      response: a,
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    const b = runtime.acceptResponse({ messageId: "om_b", content: "B", profile: null });
    const c = runtime.acceptResponse({ messageId: "om_c", content: "C", profile: null });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
      response: b,
    });
    fake.resolvePrompt("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.prompts()).toHaveLength(1);
    await runtime.enqueue({
      prompt: [{ type: "text", text: "C" }],
      messageId: "om_c",
      chatId: "oc_test",
      response: c,
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    expect(fake.prompts()[1]).toContain("B");
    expect(fake.prompts()[1]).toContain("C");
  });

  it("merges B and C into one Agent prompt while A is still interrupting", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const sentViews: unknown[] = [];
    const patchedViews: unknown[] = [];
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: {
        ...recordingPresenter([]),
        sendConversationCard: vi.fn(async (_messageId, view) => {
          sentViews.push(view);
          return `card-${sentViews.length}`;
        }),
        updateConversationCard: vi.fn(async (_cardId, view) => {
          patchedViews.push(view);
          return true;
        }),
      },
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "A" }],
      messageId: "om_a",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    await runtime.enqueue({
      prompt: [{ type: "text", text: "B" }],
      messageId: "om_b",
      chatId: "oc_test",
    });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "C correction" }],
      messageId: "om_c",
      chatId: "oc_test",
    });

    expect(fake.cancelCalls()).toBe(1);
    fake.resolvePrompt("cancelled");
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    expect(fake.prompts()[1]).toContain("B");
    expect(fake.prompts()[1]).toContain("C correction");
    expect(fake.prompts()).toHaveLength(2);
    await vi.waitFor(() =>
      expect(
        patchedViews.some(
          (view) =>
            (view as { kind?: string; header?: string }).kind === "terminal" &&
            (view as { header?: string }).header === "merged",
        ),
      ).toBe(true),
    );
  });

  it("interrupts an in-flight prompt when a follow-up user message is queued", async () => {
    const states: RecordedConversationState[] = [];
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
    // The initial "processing" card render runs on the reconciler's own async
    // worker, independent of the prompt() call above — wait for it to land
    // before triggering the interrupt so the two are never racing.
    await vi.waitFor(
      () => expect(states.some((state) => state.status === "processing")).toBe(true),
      {
        timeout: 1_000,
        interval: 20,
      },
    );

    await runtime.enqueue({
      prompt: [{ type: "text", text: "urgent follow-up" }],
      messageId: "om_followup",
      chatId: "oc_test",
    });

    expect(fake.cancelCalls()).toBe(1);
    await vi.waitFor(
      () => expect(states.some((state) => state.status === "interrupting")).toBe(true),
      {
        timeout: 1_000,
        interval: 20,
      },
    );
    // The response transitions through "processing" before the interrupt, and
    // may transition back to "processing" again afterwards while the actual
    // agent-side cancel is still in flight — assert relative order, not an
    // exact tail slice.
    const interruptingIndex = states.findIndex((state) => state.status === "interrupting");
    expect(interruptingIndex).toBeGreaterThan(-1);
    expect(states.slice(0, interruptingIndex).map((state) => state.status)).toContain("processing");

    fake.resolvePrompt("cancelled");

    await vi.waitFor(
      () => {
        expect(fake.prompts()).toHaveLength(2);
        expect(fake.prompts()[1]).toContain("urgent follow-up");
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(states.some((state) => state.status === "interrupted")).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "processing", cancellable: false });
  });

  it("interrupts the owner when a requested follow-up interrupt returns end_turn", async () => {
    const states: RecordedConversationState[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "nearly finished task" }],
      messageId: "om_first",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));
    await runtime.enqueue({
      prompt: [{ type: "text", text: "follow-up arriving at turn end" }],
      messageId: "om_followup",
      chatId: "oc_test",
    });

    expect(fake.cancelCalls()).toBe(1);
    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(2));
    expect(states.some((state) => state.status === "interrupted")).toBe(true);
    expect(states.some((state) => state.status === "complete")).toBe(false);
  });

  it("respawns and preserves the queued follow-up if interrupt closes the agent", async () => {
    const states: RecordedConversationState[] = [];
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
    expect(states.at(-1)).toMatchObject({ status: "processing", cancellable: false });
  });

  it("marks the queued message card terminal when the queued message is cancelled", async () => {
    const states: RecordedConversationState[] = [];
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
    });

    await runtime.cancel();

    await vi.waitFor(
      () =>
        expect(states).toContainEqual(
          expect.objectContaining({
            status: "cancelled",
            entries: [{ kind: "text", text: "本轮 Response 已取消。" }],
          }),
        ),
      { timeout: 1_000, interval: 20 },
    );
    fake.resolvePrompt("cancelled");
  });

  it("does not respawn a queued follow-up when explicit cancel races an agent disconnect", async () => {
    const states: RecordedConversationState[] = [];
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
    const states: RecordedConversationState[] = [];
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

  it("drains an active prompt as interrupted without reporting an expected disconnect", async () => {
    const states: RecordedConversationState[] = [];
    const notices: Array<{ title: string; body: string; template: string }> = [];
    const order: string[] = [];
    const fake = makeFakeAgent();
    const cancel = fake.agent.connection.cancel.bind(fake.agent.connection);
    fake.agent.connection.cancel = async (params) => {
      order.push("cancel");
      await cancel(params);
      fake.closeConnection();
    };
    killAgentMock.mockImplementation(() => {
      order.push("kill");
      fake.exitProcess(null, "SIGTERM");
    });
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, notices),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "restart the bridge" }],
      messageId: "om_restart",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));

    const result = await runtime.drain("restart");

    expect(result).toMatchObject({
      intent: "restart",
      outcome: "drained",
      cancel: "sent",
      persisted: true,
    });
    expect(states.at(-1)).toMatchObject({ status: "interrupted", cancellable: false });
    expect(notices).toEqual([]);
    expect(order).toEqual(["cancel", "kill"]);
  });

  it("waits for an in-flight bootstrap and cancels its Agent before reporting drained", async () => {
    const fake = makeFakeAgent();
    let releaseSpawn!: () => void;
    const spawnBlocked = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    spawnAgentMock.mockImplementation(async () => {
      await spawnBlocked;
      return fake.agent;
    });
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const enqueue = runtime.enqueue({
      prompt: [{ type: "text", text: "booting" }],
      messageId: "om_booting_drain",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(spawnAgentMock).toHaveBeenCalledOnce());

    killAgentMock.mockImplementation(() => {
      fake.exitProcess(null, "SIGTERM");
    });
    const drain = runtime.drain("restart");
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSpawn();
    await enqueue;
    await expect(drain).resolves.toMatchObject({ intent: "restart", cancel: "sent" });
    expect(fake.cancelCalls()).toBe(1);
    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith(fake.agent.process);
  });

  it("settles hydration that completes after drain without spawning an Agent", async () => {
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });
    const response = runtime.acceptResponse({
      messageId: "om_late_hydration",
      content: "late hydration",
      profile: null,
    });

    await runtime.drain("stop");
    await expect(
      runtime.enqueue({
        prompt: [{ type: "text", text: "late hydration" }],
        messageId: "om_late_hydration",
        chatId: "oc_test",
        response,
      }),
    ).resolves.toBeUndefined();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it("reports bounded escalation without a crash notice when cancel and prompt hang", async () => {
    vi.useFakeTimers();
    try {
      const states: RecordedConversationState[] = [];
      const notices: Array<{ title: string; body: string; template: string }> = [];
      const fake = makeFakeAgent();
      fake.holdNextCancel();
      spawnAgentMock.mockResolvedValue(fake.agent);
      const runtime = new ChatRuntime({
        ...opts(),
        presenter: recordingPresenter(states, notices),
        sessionStore: stubSessionStore(),
      });

      await runtime.enqueue({
        prompt: [{ type: "text", text: "hang forever" }],
        messageId: "om_hung_drain",
        chatId: "oc_test",
      });
      await vi.waitFor(() => expect(fake.prompts()).toHaveLength(1));

      const drain = runtime.drain("stop");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(drain).resolves.toMatchObject({
        intent: "stop",
        outcome: "escalated",
        cancel: "timed-out",
        persisted: true,
        agentClose: "timed-out",
      });
      expect(killAgentMock).toHaveBeenCalledExactlyOnceWith(fake.agent.process);
      expect(states.at(-1)).toMatchObject({ status: "interrupted", cancellable: false });
      expect(notices).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces an in-flight card to a terminal state when the bridge shuts down", async () => {
    const states: RecordedConversationState[] = [];
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

    await vi.waitFor(
      () => expect(states.at(-1)).toMatchObject({ status: "interrupted", cancellable: false }),
      { timeout: 1_000, interval: 20 },
    );
  });

  it("silently discards an idle agent that exits unexpectedly and respawns on demand", async () => {
    const states: RecordedConversationState[] = [];
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
    const states: RecordedConversationState[] = [];
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
    const states: RecordedConversationState[] = [];
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
    expect(logs).toContainEqual({
      obj: expect.objectContaining({
        outcome: "completed",
        firstAgentEventMs: null,
        firstRenderableEventMs: null,
      }),
      msg: "prompt timing",
    });
  });

  it("logs the first agent and renderable events once per prompt", async () => {
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
    spawnAgentMock.mockResolvedValue(fake.agent);
    const runtime = new ChatRuntime({
      ...opts(logger),
      presenter: recordingPresenter([]),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "observe this turn" }],
      messageId: "om_timing",
      chatId: "oc_test",
    });
    const spawnOptions = spawnAgentMock.mock.calls[0]?.[0] as SpawnAgentOptions;
    await spawnOptions.client.sessionUpdate({
      sessionId: "sess_fake",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "investigating" },
      },
    });
    await spawnOptions.client.sessionUpdate({
      sessionId: "sess_fake",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    });
    fake.resolvePrompt("end_turn");

    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
    expect(logs.filter((entry) => entry.msg === "first agent protocol event")).toHaveLength(1);
    expect(logs.filter((entry) => entry.msg === "first renderable agent event")).toHaveLength(1);
    expect(logs).toContainEqual({
      obj: expect.objectContaining({
        eventType: "agent_thought_chunk",
      }),
      msg: "first agent protocol event",
    });
    expect(logs).toContainEqual({
      obj: expect.objectContaining({
        eventType: "thought",
      }),
      msg: "first renderable agent event",
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
    const states: RecordedConversationState[] = [];
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
    expect(states.at(-1)).toMatchObject({ status: "interrupted", cancellable: false });
  });

  it("does not create a phantom cancelled card when superseded after prompt state reset", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const states: RecordedConversationState[] = [];
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

    const states: RecordedConversationState[] = [];
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

  it("applyControlsAtTurnBoundary applies and persists a control patch bypassing the busy guard", async () => {
    // The Bridge is the sole owner of Pending Configuration (spec §9.3) and
    // calls this method exactly at the Turn boundary, when `processing` may
    // still read `true`. Unlike the public applyControls(), it must not
    // reject on that guard, and it must not send any notice itself — the
    // Bridge builds and sends the outcome notice.
    const fake = makeFakeAgent();
    const setModel = vi.fn(async () => ({}));
    fake.agent.connection = {
      ...fake.agent.connection,
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
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "start session" }],
      messageId: "om_boundary_apply",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(runtime.processing).toBe(true), { timeout: 1_000, interval: 20 });

    await runtime.applyControlsAtTurnBoundary({ modelId: "model-new" });

    expect(setModel).toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "model-new" });
    expect(latest).toMatchObject({ controls: { modelId: "model-new" } });

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
  });

  it("applyControlsAtTurnBoundary rejects an invalid patch without persisting it", async () => {
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);
    let latest: SessionRecord | null = null;
    const store: SessionStore = {
      ...stubSessionStore(),
      getLatest: async () => latest,
      save: async (record) => {
        latest = record;
      },
    };
    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter([]),
      sessionStore: store,
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "start session" }],
      messageId: "om_boundary_reject",
      chatId: "oc_test",
    });
    await vi.waitFor(() => expect(runtime.processing).toBe(true), { timeout: 1_000, interval: 20 });

    await expect(
      runtime.applyControlsAtTurnBoundary({ modelId: "missing-model" }),
    ).rejects.toThrow();
    expect(latest?.controls).toBeUndefined();

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => expect(runtime.processing).toBe(false), {
      timeout: 1_000,
      interval: 20,
    });
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

    const states: RecordedConversationState[] = [];
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
    expect(notices.at(-1)).toMatchObject({ title: "⚠️ 已忽略无效的会话配置" });
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
    expect(notices.at(-1)).toMatchObject({ title: "✅ 会话配置已更新", template: "green" });
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
    const states: RecordedConversationState[] = [];
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
    expect(notice).toMatchObject({ title: "✅ 会话配置已更新", template: "green" });
    expect(notice?.body).toContain("当前会话配置已更新");
    expect(notice?.body).toContain("Agent：node");
    expect(notice?.body).toContain("Mode：Ask → Agent");
    expect(notice?.body).toContain("Model：Old → New");
    expect(notice?.body).toContain("Permission：Auto approve → Ask approvals");
    expect(notice?.body).toContain("Config Auto Edit：off → on");
    expect(notice?.body).toContain("Config Approval Mode：Ask → Auto");
    expect(notice?.body).toContain("Permission：Auto Edit: on · Approval Mode: Auto");
    expect(notice?.body).toContain("Config：Auto Edit: on · Approval Mode: Auto");
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
    expect(notices.at(-1)).toMatchObject({ title: "⚠️ 会话配置失败", template: "red" });
    expect(notices.at(-1)?.body).toContain("失败项: Model missing-model");
    expect(notices.at(-1)?.body).toContain("会话配置未更新");
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
