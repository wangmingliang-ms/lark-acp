import { describe, expect, it, beforeEach, vi } from "vitest";
import { LarkBridge, type LarkCommand, type ResolvedAgentInvocation } from "./bridge.js";
import type { AgentProcess, ProbeAgentSessionCapabilitiesResult } from "../acp/agent-process.js";
import type { BindingStore, ChatBinding } from "../binding-store/binding-store.js";
import type { LarkLogger } from "../logger/logger.js";
import type {
  AgentSwitchWarningCardSpec,
  AgentSwitchWarningResolution,
  LarkPresenter,
  NoticeCardSpec,
  CommandResultCardSpec,
  UnifiedCardState,
} from "../presenter/presenter.js";
import type {
  PendingSessionTask,
  PendingTargetProfile,
  SessionControlPatch,
  SessionControlTarget,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";

const probeAgentSessionCapabilitiesMock = vi.hoisted(() =>
  vi.fn<() => Promise<ProbeAgentSessionCapabilitiesResult>>(),
);
const spawnAgentMock = vi.hoisted(() => vi.fn<() => Promise<AgentProcess>>());

vi.mock("../acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/agent-process.js")>();
  return {
    ...actual,
    probeAgentSessionCapabilities: probeAgentSessionCapabilitiesMock,
    spawnAgent: spawnAgentMock,
    killAgent: () => {},
  };
});

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

class MemorySessionStore implements SessionStore {
  private records: SessionRecord[];

  constructor(records: readonly SessionRecord[] = []) {
    this.records = [...records];
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async listByChat(chatId: string): Promise<readonly SessionRecord[]> {
    return this.records.filter((record) => record.chatId === chatId).sort(sortRecentFirst);
  }

  async listByThread(chatId: string, threadId: string | null): Promise<readonly SessionRecord[]> {
    return this.records
      .filter((record) => record.chatId === chatId && record.threadId === threadId)
      .sort(sortRecentFirst);
  }

  async getLatest(chatId: string, threadId: string | null): Promise<SessionRecord | null> {
    return (await this.listByThread(chatId, threadId))[0] ?? null;
  }

  async save(record: SessionRecord): Promise<void> {
    if (!record.profileOnly) {
      this.records = this.records.filter(
        (existing) => !(existing.threadId === record.threadId && existing.profileOnly),
      );
    }
    this.records = this.records.filter(
      (existing) => !(existing.chatId === record.chatId && existing.sessionId === record.sessionId),
    );
    this.records.push(record);
  }

  async bindThreadSession(record: SessionRecord): Promise<SessionRecord> {
    await this.clearThread(record.chatId, record.threadId);
    await this.save(record);
    return record;
  }

  async setControls(
    target: SessionControlTarget,
    controls: SessionControlPatch,
  ): Promise<SessionRecord> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    const updated: SessionRecord = { ...record, controls, updatedAt: record.updatedAt + 1 };
    await this.save(updated);
    return updated;
  }

  async setPendingControls(
    target: SessionControlTarget,
    controls: SessionControlPatch,
  ): Promise<SessionRecord> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    const updated: SessionRecord = {
      ...record,
      pendingControls: controls,
      updatedAt: record.updatedAt + 1,
    };
    await this.save(updated);
    return updated;
  }

  async consumePendingControls(
    target: SessionControlTarget,
  ): Promise<{ readonly record: SessionRecord; readonly pendingControls?: SessionControlPatch }> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    return record.pendingControls
      ? { record, pendingControls: record.pendingControls }
      : { record };
  }

  async setPendingTask(
    target: SessionControlTarget,
    task: PendingSessionTask,
  ): Promise<SessionRecord> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    const updated: SessionRecord = {
      ...record,
      pendingTask: task,
      updatedAt: record.updatedAt + 1,
    };
    await this.save(updated);
    return updated;
  }

  async setPendingTargetProfile(
    target: SessionControlTarget,
    profile: PendingTargetProfile,
  ): Promise<SessionRecord> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    const updated: SessionRecord = {
      ...record,
      pendingTargetProfile: profile,
      updatedAt: record.updatedAt + 1,
    };
    await this.save(updated);
    return updated;
  }

  async consumePendingTask(
    target: SessionControlTarget,
  ): Promise<{ readonly record: SessionRecord; readonly pendingTask?: PendingSessionTask }> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    return record.pendingTask ? { record, pendingTask: record.pendingTask } : { record };
  }

  async clearThread(chatId: string, threadId: string | null): Promise<void> {
    this.records = this.records.filter(
      (record) => !(record.chatId === chatId && record.threadId === threadId),
    );
  }

  async delete(chatId: string, sessionId: string): Promise<void> {
    this.records = this.records.filter(
      (record) => !(record.chatId === chatId && record.sessionId === sessionId),
    );
  }

  private async requireLatest(chatId: string, threadId: string | null): Promise<SessionRecord> {
    const latest = await this.getLatest(chatId, threadId);
    if (!latest) throw new Error("no session record");
    return latest;
  }
}

class MemoryBindingStore implements BindingStore {
  constructor(private readonly binding: ChatBinding | null) {}

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async get(_chatId: string): Promise<ChatBinding | null> {
    return this.binding;
  }
  async set(_binding: ChatBinding): Promise<void> {}
  async delete(_chatId: string): Promise<void> {}
  async list(): Promise<readonly ChatBinding[]> {
    return this.binding ? [this.binding] : [];
  }
}

interface PresenterEvents {
  readonly warnings: AgentSwitchWarningCardSpec[];
  readonly warningResolutions: AgentSwitchWarningResolution[];
  readonly notices: NoticeCardSpec[];
  readonly commandResults: CommandResultCardSpec[];
  readonly unifiedCards: UnifiedCardState[];
}

function recordingPresenter(events: PresenterEvents): LarkPresenter {
  return {
    replyText: async () => {},
    sendInterruptCard: async () => null,
    updateInterruptCard: async () => false,
    updatePermissionCard: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async (_messageId, notice) => {
      events.notices.push(notice);
    },
    replyCommandResultCard: async (_messageId, result) => {
      events.commandResults.push(result);
    },
    sendNoticeCard: async (_chatId, notice) => {
      events.notices.push(notice);
      return "notice_card";
    },
    replyAgentSwitchWarningCard: async (_messageId, warning) => {
      events.warnings.push(warning);
      return "agent_switch_warning_card";
    },
    updateAgentSwitchWarningCard: async (_messageId, resolution) => {
      events.warningResolutions.push(resolution);
    },
    sendUnifiedCard: async (_messageId, state: UnifiedCardState) => {
      events.unifiedCards.push(structuredClone(state));
      return "unified_card";
    },
    updateUnifiedCard: async (_messageId, state: UnifiedCardState) => {
      events.unifiedCards.push(structuredClone(state));
      return true;
    },
  };
}

function sortRecentFirst(a: SessionRecord, b: SessionRecord): number {
  return b.updatedAt - a.updatedAt;
}

function resolver(selection: string): ResolvedAgentInvocation {
  if (selection === "codex") {
    return { command: "npx", args: ["-y", "@zed-industries/codex-acp"], label: "codex" };
  }
  return { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"], label: "claude" };
}

function makeBridge(sessionStore: SessionStore, presenter: LarkPresenter): LarkBridge {
  return new LarkBridge({
    lark: { appId: "cli_a", appSecret: "secret" },
    agent: {
      resolver,
      defaultAgent: resolver("claude"),
      defaultCwd: "/tmp",
    },
    bindingStore: new MemoryBindingStore({
      chatId: "oc_A",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 1,
    }),
    sessionStore,
    presenter,
    logger,
  });
}

async function dispatchCommand(
  bridge: LarkBridge,
  command: LarkCommand,
  messageId = "om_switch",
): Promise<void> {
  const testable = bridge as unknown as {
    handleCommand(
      command: LarkCommand,
      chatId: string,
      threadId: string | null,
      messageId: string,
    ): Promise<void>;
  };
  await testable.handleCommand(command, "oc_A", "omt_1", messageId);
}

async function handleCardAction(
  bridge: LarkBridge,
  value: object,
  messageId = "om_warning_card",
): Promise<void> {
  const testable = bridge as unknown as {
    handleCardAction(event: {
      readonly action: { readonly value: object };
      readonly messageId: string;
    }): void;
  };
  testable.handleCardAction({ action: { value }, messageId });
  await vi.waitFor(() => expect(true).toBe(true));
}

function existingClaudeSession(): SessionRecord {
  return {
    chatId: "oc_A",
    threadId: "omt_1",
    sessionId: "sess_claude",
    agentCommand: "npx",
    agentArgs: ["-y", "@zed-industries/claude-code-acp"],
    agentLabel: "claude",
    cwd: "/tmp",
    createdAt: 1,
    updatedAt: 2,
  };
}

function codexProfileRecord(): SessionRecord {
  return {
    chatId: "oc_A",
    threadId: "omt_1",
    sessionId: "profile:3",
    profileOnly: true,
    agentCommand: "npx",
    agentArgs: ["-y", "@zed-industries/codex-acp"],
    agentLabel: "codex",
    cwd: "/tmp",
    createdAt: 3,
    updatedAt: 3,
  };
}

function fakeAgentProcess(
  sessionId: string,
  sessionCapabilities: AgentProcess["sessionCapabilities"] = {},
): AgentProcess {
  const proc = {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    on: () => proc,
  };
  return {
    process: proc as unknown as AgentProcess["process"],
    sessionId,
    capabilities: {},
    sessionCapabilities,
    connection: {
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => {},
      unstable_setSessionModel: async () => {},
      setSessionMode: async () => {},
      setSessionConfigOption: async () => ({
        configOptions: sessionCapabilities.configOptions ?? [],
      }),
      get closed() {
        return new Promise<void>(() => {});
      },
    } as AgentProcess["connection"],
    getRecentStderr: () => [],
  };
}

describe("LarkBridge destructive Agent switch confirmation", () => {
  beforeEach(() => {
    probeAgentSessionCapabilitiesMock.mockReset();
    probeAgentSessionCapabilitiesMock.mockResolvedValue({ sessionId: "probe", capabilities: {} });
    spawnAgentMock.mockReset();
    spawnAgentMock.mockResolvedValue(
      fakeAgentProcess("sess_codex", {
        models: {
          currentModelId: "auto",
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gpt-5.5", name: "GPT-5.5" },
          ],
        },
      }),
    );
  });

  it("warns and does not probe or switch when /agent targets an already-started topic", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));

    await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" });

    expect(events.warnings).toHaveLength(1);
    expect(events.warnings[0]).toMatchObject({
      chatId: "oc_A",
      threadId: "omt_1",
      fromAgent: "claude",
      toAgent: "codex",
      repo: "/tmp",
    });
    expect(events.warnings[0]?.body).toContain("这条切换消息不会作为任务发送给新 Agent");
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      sessionId: "sess_claude",
      agentLabel: "claude",
    });
    expect(events.notices).toEqual([]);
  });

  it("keeps the old session when the warning is cancelled", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));

    await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" });
    const switchId = events.warnings[0]?.switchId;
    expect(switchId).toBeDefined();

    await handleCardAction(bridge, { c: "oc_A", th: "omt_1", sw: switchId, swa: "cancel" });

    expect(events.warningResolutions).toEqual([
      { status: "cancelled", text: "已取消 Agent 切换；当前 session 保持不变。" },
    ]);
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({ sessionId: "sess_claude" });
  });

  it("probes and creates a fresh profile-only session only after confirmation", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));

    await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" });
    const switchId = events.warnings[0]?.switchId;
    expect(switchId).toBeDefined();

    await handleCardAction(bridge, { c: "oc_A", th: "omt_1", sw: switchId, swa: "confirm" });

    await vi.waitFor(async () => {
      expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledTimes(1);
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        profileOnly: true,
        agentLabel: "codex",
        sessionId: expect.stringMatching(/^profile:/),
      });
    });
    expect(events.warningResolutions).toEqual([
      { status: "confirmed", text: "已确认切换，正在启动目标 Agent 检查可用性。" },
    ]);
    expect(events.notices.at(-1)).toMatchObject({ title: "✅ Agent 已切换", template: "green" });
    expect(events.notices.at(-1)?.body).toContain("请发送下一条消息开始新的任务");
  });

  it("queues in-flight natural-language agent handoff and runs the pending task after the turn", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      controlSetPendingTask(
        chatId: string,
        threadId: string | null,
        task: PendingSessionTask,
      ): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
      activeChatCount: number;
    };

    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {}),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    await testable.controlSetPendingTask("oc_A", "omt_1", {
      prompt: "查一下 pipeline 为什么失败",
      createdAt: 10,
    });

    expect(fakeRuntime.supersede).not.toHaveBeenCalled();
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({ agentLabel: "claude" });
    expect(events.notices.at(-1)).toMatchObject({ title: "⏳ Agent 切换已排队" });

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        sessionId: "sess_codex",
        agentLabel: "codex",
      });
      expect(testable.activeChatCount).toBe(1);
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingTask).toBeUndefined();
    expect(fakeRuntime.supersede).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    expect(events.notices.at(-1)).toMatchObject({ title: "✅ Agent 已切换" });
    expect(events.notices.at(-1)?.body).toContain("正在交给新 Agent 继续执行");
  });

  it("queues an atomic pending target profile with Agent, controls, and task in one notice", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetPendingTargetProfile(
        chatId: string,
        threadId: string | null,
        profile: PendingTargetProfile,
        noticeMessageId?: string | null,
      ): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
      activeChatCount: number;
    };

    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {}),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );
    probeAgentSessionCapabilitiesMock.mockResolvedValueOnce({
      sessionId: "probe_codex",
      capabilities: {
        models: {
          currentModelId: "auto",
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gpt-5.5", name: "GPT-5.5" },
          ],
        },
      },
    });

    await testable.controlSetPendingTargetProfile(
      "oc_A",
      "omt_1",
      {
        sessionId: "profile:atomic",
        profileOnly: true,
        agentCommand: "npx",
        agentArgs: ["-y", "@zed-industries/codex-acp"],
        agentLabel: "codex",
        cwd: "/tmp",
        controls: { modelId: "gpt-5.5" },
        task: { prompt: "查一下 pipeline 为什么失败", createdAt: 10 },
        createdAt: 10,
        updatedAt: 10,
      },
      "om_handoff",
    );

    expect(events.notices).toHaveLength(1);
    expect(events.notices[0]).toMatchObject({ title: "⏳ Pending target profile 已排队" });
    expect(events.notices[0]?.body).toContain("• Agent：codex");
    expect(events.notices[0]?.body).toContain("• Model：gpt-5.5");
    expect(events.notices[0]?.body).toContain("• Task：已保存");
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      agentLabel: "claude",
      pendingTargetProfile: {
        agentLabel: "codex",
        controls: { modelId: "gpt-5.5" },
        task: { prompt: "查一下 pipeline 为什么失败" },
      },
    });

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        agentLabel: "codex",
        controls: { modelId: "gpt-5.5" },
      });
      expect(testable.activeChatCount).toBe(1);
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingTargetProfile).toBeUndefined();
    expect(fakeRuntime.supersede).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the atomic pending task even if the finishing old runtime persists its session", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetPendingTargetProfile(
        chatId: string,
        threadId: string | null,
        profile: PendingTargetProfile,
        noticeMessageId?: string | null,
      ): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
      activeChatCount: number;
    };

    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {}),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlSetPendingTargetProfile(
      "oc_A",
      "omt_1",
      {
        sessionId: "profile:atomic",
        profileOnly: true,
        agentCommand: "npx",
        agentArgs: ["-y", "@zed-industries/codex-acp"],
        agentLabel: "codex",
        cwd: "/tmp",
        task: { prompt: "继续执行用户任务", createdAt: 10 },
        createdAt: 10,
        updatedAt: 10,
      },
      "om_handoff",
    );

    // Reproduces the real race: when the old runtime finishes, ChatRuntime.persistSession()
    // rewrites the old session record. The in-memory pending target profile must still
    // carry its task through the post-turn Agent switch.
    await store.save({ ...existingClaudeSession(), updatedAt: 99 });

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    await vi.waitFor(() => expect(testable.activeChatCount).toBe(1));
    expect(events.notices.at(-1)).toMatchObject({ title: "✅ Pending target profile 已生效" });
    expect(events.notices.at(-1)?.body).toContain("正在交给目标 Agent 执行 pending task");
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it("validates queued model changes against the pending target Agent, not the live Agent", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      controlSetControls(
        chatId: string,
        threadId: string | null,
        controls: SessionControlPatch,
        noticeMessageId?: string | null,
      ): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
    };

    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {}),
      capabilities: () => ({
        session: { chatId: "oc_A", threadId: "omt_1", sessionId: "sess_claude" },
        agent: {
          label: "claude",
          command: "npx",
          args: ["-y", "@zed-industries/claude-code-acp"],
          cwd: "/tmp",
        },
        models: {
          currentModelId: "claude-sonnet-4.5",
          availableModels: [{ modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
        },
        bridgePermissionModes: ["alwaysAllow", "alwaysDeny", "alwaysAsk"],
        bridgePermissionMode: "alwaysAsk",
      }),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );
    probeAgentSessionCapabilitiesMock.mockResolvedValueOnce({
      sessionId: "probe_codex",
      capabilities: {
        models: {
          currentModelId: "auto",
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gpt-5.5", name: "GPT-5.5" },
          ],
        },
      },
    });

    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    await testable.controlSetControls("oc_A", "omt_1", { modelId: "gpt-5.5" }, "om_model");

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    expect(events.notices.some((notice) => notice.title === "⚠️ Session 设置失败")).toBe(false);
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      agentLabel: "codex",
      controls: { modelId: "gpt-5.5" },
    });
  });

  it("selects the target Agent immediately when the topic has no real session yet", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      unifiedCards: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));

    await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" });

    expect(events.warnings).toEqual([]);
    expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledTimes(1);
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      profileOnly: true,
      agentLabel: "codex",
    });
  });
});
