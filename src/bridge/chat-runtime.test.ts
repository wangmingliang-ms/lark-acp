import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { ChatRuntime } from "./chat-runtime.js";
import type { ChatRuntimeOptions } from "./chat-runtime.js";
import { createPinoLogger } from "../logger/logger.js";
import type { LarkPresenter, UnifiedCardState } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { AgentProcess } from "../acp/agent-process.js";

// The agent subprocess is the correct mock boundary: we replace `spawnAgent`
// so no real process is spawned, then hand ChatRuntime a fake AgentProcess
// whose connection we fully control. Everything else in the module (notably
// `AgentDisconnectedError`, which the disconnect path throws) is kept real via
// `importOriginal`, so only the process-spawning side effect is stubbed.
const spawnAgentMock = vi.fn<(opts: unknown) => Promise<AgentProcess>>();
const spawnAndResumeAgentMock =
  vi.fn<(opts: unknown, id: string) => Promise<{ agent: AgentProcess; resumed: boolean }>>();

vi.mock("../acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/agent-process.js")>();
  return {
    ...actual,
    spawnAgent: (opts: unknown) => spawnAgentMock(opts),
    spawnAndResumeAgent: (opts: unknown, id: string) => spawnAndResumeAgentMock(opts, id),
    killAgent: () => {},
  };
});

/**
 * Minimal options to construct a ChatRuntime without spawning anything.
 * These tests only exercise the pre-bootstrap getters (`processing` /
 * `lastActivity`) that the bridge's idle-eviction reads, so the presenter /
 * session store are never touched.
 */
function opts(): ChatRuntimeOptions {
  const logger = createPinoLogger();
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
type ReactionOp =
  | { kind: "add"; messageId: string; emoji: string | undefined; reactionId: string }
  | { kind: "remove"; messageId: string; reactionId: string };

function recordingPresenter(
  states: UnifiedCardState[],
  reactions: ReactionOp[] = [],
): LarkPresenter {
  let reactionSeq = 0;
  return {
    replyText: async () => {},
    addReaction: async (messageId, emoji) => {
      reactionSeq += 1;
      const reactionId = `reaction_${reactionSeq}`;
      reactions.push({ kind: "add", messageId, emoji, reactionId });
      return reactionId;
    },
    removeReaction: async (messageId, reactionId) => {
      reactions.push({ kind: "remove", messageId, reactionId });
    },
    sendInterruptCard: async () => null,
    updatePermissionCard: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async () => {},
    sendUnifiedCard: async (_id, state) => {
      states.push(structuredClone(state));
      return "card_msg_1";
    },
    updateUnifiedCard: async (_id, state) => {
      states.push(structuredClone(state));
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
    delete: async () => {},
  };
}

interface FakeAgentHandle {
  agent: AgentProcess;
  /** Resolve the in-flight prompt with a stop reason (normal turn end). */
  resolvePrompt: (stopReason: acp.StopReason) => void;
  /** Simulate the agent process's stdout/stream closing (process died). */
  closeConnection: () => void;
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

  let resolvePrompt: (r: acp.PromptResponse) => void = () => {};
  const promptResult = new Promise<acp.PromptResponse>((resolve) => {
    resolvePrompt = resolve;
  });

  const connection = {
    // Stays pending until `resolvePrompt` is called — the crux of the bug is
    // that the SDK never rejects this when the stream closes.
    prompt: () => promptResult,
    cancel: async () => {},
    get closed() {
      return closed;
    },
    get signal() {
      return abort.signal;
    },
  } as unknown as AgentProcess["connection"];

  const agent: AgentProcess = {
    process: { killed: false, exitCode: null, on: () => {} } as unknown as AgentProcess["process"],
    connection,
    sessionId: "sess_fake",
    capabilities: {},
    getRecentStderr: () => [],
  };

  return {
    agent,
    resolvePrompt: (stopReason) => resolvePrompt({ stopReason }),
    closeConnection: () => {
      abort.abort();
      resolveClosed();
    },
  };
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
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states),
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
        expect(last?.cancellable, "final card must drop the cancel button").toBe(false);
      },
      { timeout: 1_000, interval: 20 },
    );
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

  it("updates the original message reaction from processing to the terminal status", async () => {
    const states: UnifiedCardState[] = [];
    const reactions: ReactionOp[] = [];
    const fake = makeFakeAgent();
    spawnAgentMock.mockResolvedValue(fake.agent);

    const runtime = new ChatRuntime({
      ...opts(),
      presenter: recordingPresenter(states, reactions),
      sessionStore: stubSessionStore(),
    });

    await runtime.enqueue({
      prompt: [{ type: "text", text: "hello" }],
      messageId: "om_status",
      chatId: "oc_test",
    });

    await vi.waitFor(() => {
      expect(reactions).toContainEqual({
        kind: "add",
        messageId: "om_status",
        emoji: "OnIt",
        reactionId: "reaction_1",
      });
    });

    fake.resolvePrompt("end_turn");
    await vi.waitFor(() => {
      expect(reactions).toContainEqual({
        kind: "add",
        messageId: "om_status",
        emoji: "DONE",
        reactionId: "reaction_2",
      });
      expect(reactions).toContainEqual({
        kind: "remove",
        messageId: "om_status",
        reactionId: "reaction_1",
      });
    });
  });
});
