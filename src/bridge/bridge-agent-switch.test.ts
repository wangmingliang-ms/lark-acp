import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type * as acp from "@agentclientprotocol/sdk";
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
} from "../presenter/presenter.js";
import type {
  PendingSessionConfiguration,
  PendingSessionMessage,
  PendingTargetAgent,
  SessionCapabilitiesSnapshot,
  SessionControlPatch,
  SessionControls,
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
    // Route "resume an existing session" bootstraps through the same fake
    // Agent process factory used for fresh switches, so tests that acquire a
    // runtime for an already-persisted (non-profile-only) session don't hit
    // the real ACP spawn/resume machinery.
    spawnAndResumeAgent: async () => ({ agent: await spawnAgentMock(), resumed: true }),
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

  async setPendingConfiguration(
    target: SessionControlTarget,
    configuration: PendingSessionConfiguration,
  ): Promise<SessionRecord> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    const updated: SessionRecord = {
      ...record,
      pendingConfiguration: configuration,
      updatedAt: record.updatedAt + 1,
    };
    await this.save(updated);
    return updated;
  }

  async clearPendingConfigurationIfMatches(
    target: SessionControlTarget,
    expected: PendingSessionConfiguration,
  ): Promise<{ readonly record: SessionRecord; readonly cleared: boolean }> {
    const record = await this.requireLatest(target.chatId, target.threadId);
    if (!isDeepStrictEqual(record.pendingConfiguration, expected)) {
      return { record, cleared: false };
    }
    const updated: SessionRecord = {
      ...record,
      pendingConfiguration: undefined,
      updatedAt: record.updatedAt + 1,
    };
    await this.save(updated);
    return { record: updated, cleared: true };
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
  readonly noticeUpdates: NoticeCardSpec[];
  readonly commandResults: CommandResultCardSpec[];
}

function recordingPresenter(events: PresenterEvents): LarkPresenter {
  return {
    replyText: async () => {},
    expirePermissionCard: async () => {},
    replyNoticeCard: async (_messageId, notice) => {
      events.notices.push(notice);
      return "notice_card";
    },
    updateNoticeCard: async (_messageId, notice) => {
      events.noticeUpdates.push(notice);
      return true;
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
    sendConversationCard: async () => "conversation_card",
    updateConversationCard: async () => true,
    sendPermissionRequestCard: async () => "permission_card",
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

function makeBridge(
  sessionStore: SessionStore,
  presenter: LarkPresenter,
  opts: {
    readonly settingsPath?: string;
    readonly globalDefaultControlChatIds?: readonly string[];
    readonly defaultControls?: SessionControls;
  } = {},
): LarkBridge {
  return new LarkBridge({
    lark: { appId: "cli_a", appSecret: "secret" },
    agent: {
      resolver,
      defaultAgent: resolver("claude"),
      defaultCwd: "/tmp",
      ...(opts.defaultControls !== undefined ? { defaultControls: opts.defaultControls } : {}),
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
    ...(opts.settingsPath !== undefined ? { settingsPath: opts.settingsPath } : {}),
    ...(opts.globalDefaultControlChatIds !== undefined
      ? { globalDefaultControlChatIds: opts.globalDefaultControlChatIds }
      : {}),
  });
}

describe("LarkBridge shutdown", () => {
  it("shuts down runtimes before awaiting the lifecycle notice", async () => {
    const events: string[] = [];
    const bridge = makeBridge(
      new MemorySessionStore(),
      recordingPresenter({
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      }),
    );
    const runtime = {
      chatId: "oc_A",
      threadId: "omt_1",
      shutdown: vi.fn(async () => {
        events.push("runtime");
      }),
    };
    const testable = bridge as unknown as {
      started: boolean;
      chats: Map<string, typeof runtime>;
      sendLifecycleTerminalNotice: () => Promise<void>;
    };
    testable.started = true;
    testable.chats.set("oc_A\u0000omt_1", runtime);
    testable.sendLifecycleTerminalNotice = async () => {
      events.push("lifecycle");
    };

    await bridge.stop();

    expect(events).toEqual(["runtime", "lifecycle"]);
  });
});

async function dispatchCommand(
  bridge: LarkBridge,
  command: LarkCommand,
  messageId = "om_switch",
  opts: {
    readonly chatId?: string;
    readonly threadId?: string | null;
    readonly isDirectMessage?: boolean;
  } = {},
): Promise<void> {
  const testable = bridge as unknown as {
    handleCommand(
      command: LarkCommand,
      chatId: string,
      threadId: string | null,
      messageId: string,
      context?: { readonly isDirectMessage?: boolean },
    ): Promise<void>;
  };
  await testable.handleCommand(
    command,
    opts.chatId ?? "oc_A",
    Object.hasOwn(opts, "threadId") ? opts.threadId! : "omt_1",
    messageId,
    {
      isDirectMessage: opts.isDirectMessage ?? false,
    },
  );
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

/** Minimal valid capabilities snapshot for a fake in-memory `ChatRuntime` stand-in. */
function fakeCapabilitiesSnapshot(): SessionCapabilitiesSnapshot {
  return {
    session: { chatId: "oc_A", threadId: "omt_1", sessionId: "sess_claude" },
    agent: { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"], cwd: "/tmp" },
    bridgePermissionModes: ["alwaysAllow", "alwaysDeny", "alwaysAsk"],
    bridgePermissionMode: "alwaysAsk",
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
      noticeUpdates: [],
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
      noticeUpdates: [],
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
      noticeUpdates: [],
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
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: { readonly message?: PendingSessionMessage },
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

    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      { message: { prompt: "查一下 pipeline 为什么失败", createdAt: 10 } },
      "om_handoff",
    );

    expect(fakeRuntime.supersede).not.toHaveBeenCalled();
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({ agentLabel: "claude" });
    expect(events.notices.at(-1)).toMatchObject({ title: "⏳ 配置变更将在本轮后生效" });

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        sessionId: "sess_codex",
        agentLabel: "codex",
      });
      expect(testable.activeChatCount).toBe(1);
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
    expect(fakeRuntime.supersede).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    expect(events.notices).toHaveLength(1);
    expect(events.noticeUpdates.at(-1)).toMatchObject({ title: "✅ Agent 已切换" });
    expect(events.noticeUpdates.at(-1)?.body).toContain("正在交给新 Agent 继续执行");
  });

  it("queues an atomic pending configuration with Agent, controls, and message in one notice", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly controls?: SessionControlPatch;
          readonly message?: PendingSessionMessage;
        },
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
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:atomic",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        controls: { modelId: "gpt-5.5" },
        message: { prompt: "查一下 pipeline 为什么失败", createdAt: 10 },
      },
      "om_handoff",
    );

    expect(events.notices).toHaveLength(1);
    expect(events.notices[0]).toMatchObject({ title: "⏳ 配置变更将在本轮后生效" });
    expect(events.notices[0]?.body).toContain("codex");
    expect(events.notices[0]?.body).toContain("Model: gpt-5.5");
    expect(events.notices[0]?.body).toContain("后续消息：已保存");
    expect(events.notices[0]?.body).not.toMatch(/pending|profile|settings\.json/iu);
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      agentLabel: "claude",
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        controls: { modelId: "gpt-5.5" },
        message: { prompt: "查一下 pipeline 为什么失败" },
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
    expect(events.notices).toHaveLength(1);
    expect(events.noticeUpdates).toHaveLength(1);
    expect(events.noticeUpdates[0]).toMatchObject({
      title: "✅ Agent 已切换",
      template: "green",
    });
    expect(events.noticeUpdates[0]?.body).toContain("**切换结果**");
    expect(events.noticeUpdates[0]?.body).toContain("• Agent：claude → codex");
    expect(events.noticeUpdates[0]?.body).toContain("• Model：gpt-5.5");
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
    expect(fakeRuntime.supersede).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it("marks a queued Agent switch terminal when applying it fails", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
    };
    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {
        throw new Error("supersede failed");
      }),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    fakeRuntime.processing = false;

    await expect(testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff")).rejects.toThrow(
      "supersede failed",
    );
    expect(events.noticeUpdates.at(-1)).toMatchObject({
      title: "⚠️ 待应用配置变更未完成",
      template: "red",
    });
  });

  it("does not mark a queued Agent switch successful before its pending message is sent", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: { readonly message?: PendingSessionMessage },
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
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      { message: { prompt: "continue after switch", createdAt: 10 } },
      "om_handoff",
    );
    const queuedConfiguration = (await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration;
    expect(queuedConfiguration?.targetAgent).toMatchObject({ agentLabel: "codex" });
    expect(queuedConfiguration?.message).toMatchObject({ prompt: "continue after switch" });

    spawnAgentMock.mockRejectedValueOnce(new Error("target Agent failed to start"));
    fakeRuntime.processing = false;

    await expect(testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff")).rejects.toThrow(
      "target Agent failed to start",
    );
    expect(events.noticeUpdates.at(-1)).toMatchObject({
      title: "⚠️ 待应用配置变更未完成",
      template: "red",
    });

    // Target startup/enqueue failed: the previous Session must remain
    // current (not the failed codex candidate), and the whole Pending
    // Configuration — including its attached message — must survive for a
    // later retry (spec §9.6).
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after).toMatchObject({ sessionId: "sess_claude", agentLabel: "claude" });
    expect(after?.pendingConfiguration).toEqual(queuedConfiguration);
    expect(bridge.activeChatCount).toBe(0);
  });

  it("preserves the pending configuration and does not send its message when applying queued controls fails at the turn boundary", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly controls?: SessionControlPatch;
          readonly message?: PendingSessionMessage;
        },
        noticeMessageId?: string | null,
      ): Promise<unknown>;
      handleRuntimeTurnComplete(
        chatId: string,
        threadId: string | null,
        messageId: string,
      ): Promise<void>;
    };
    const enqueue = vi.fn(async () => {});
    const fakeRuntime = {
      processing: true,
      lastMessageId: "om_handoff",
      supersede: vi.fn(async () => {}),
      capabilities: vi.fn(() => fakeCapabilitiesSnapshot()),
      applyControlsAtTurnBoundary: vi.fn(async () => {
        throw new Error("control apply failed");
      }),
      enqueue,
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        controls: { bridgePermissionMode: "alwaysAllow" },
        message: { prompt: "continue after controls", createdAt: 10 },
      },
      "om_handoff",
    );
    const queuedConfiguration = (await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration;
    expect(queuedConfiguration?.controls).toMatchObject({ bridgePermissionMode: "alwaysAllow" });

    fakeRuntime.processing = false;
    await expect(testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff")).rejects.toThrow(
      "control apply failed",
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(events.noticeUpdates.at(-1)).toMatchObject({
      title: "⚠️ 待应用配置变更未完成",
      template: "red",
    });
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after?.pendingConfiguration).toEqual(queuedConfiguration);
  });

  it("treats a queued message delivery failure at the turn boundary as a hard failure and preserves the pending configuration", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly controls?: SessionControlPatch;
          readonly message?: PendingSessionMessage;
        },
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
      capabilities: vi.fn(() => fakeCapabilitiesSnapshot()),
      applyControlsAtTurnBoundary: vi.fn(async () => {}),
      enqueue: vi.fn(async () => {
        throw new Error("message enqueue failed");
      }),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        controls: { bridgePermissionMode: "alwaysAllow" },
        message: { prompt: "continue after controls", createdAt: 10 },
      },
      "om_handoff",
    );
    const queuedConfiguration = (await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration;

    fakeRuntime.processing = false;
    await expect(testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff")).rejects.toThrow(
      "message enqueue failed",
    );

    // Controls did apply successfully, but the message failed to send: the
    // whole application is a hard failure, not a logged-and-ignored warning
    // (spec §9.6) — the Pending Configuration must still be there for retry.
    expect(events.noticeUpdates.at(-1)).toMatchObject({
      title: "⚠️ 待应用配置变更未完成",
      template: "red",
    });
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after?.pendingConfiguration).toEqual(queuedConfiguration);
  });

  it("does not let an in-flight turn-boundary apply clear a newer pending configuration written while it was applying controls", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: { readonly controls?: SessionControlPatch },
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
      capabilities: vi.fn(() => fakeCapabilitiesSnapshot()),
      applyControlsAtTurnBoundary: vi.fn(async () => {
        // Simulate a later `configure` request racing in via the store and
        // replacing the Pending Configuration while this apply is already
        // in flight (in production this is excluded by the per-topic lock;
        // this directly exercises the conditional-clear safety net).
        await store.setPendingConfiguration(
          { chatId: "oc_A", threadId: "omt_1" },
          { controls: { bridgePermissionMode: "alwaysDeny" }, createdAt: 1, updatedAt: 999 },
        );
      }),
    };
    (bridge as unknown as { chats: Map<string, typeof fakeRuntime> }).chats.set(
      "oc_A\u0000omt_1",
      fakeRuntime,
    );

    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      { controls: { bridgePermissionMode: "alwaysAllow" } },
      "om_handoff",
    );

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    const after = await store.getLatest("oc_A", "omt_1");
    expect(after?.pendingConfiguration).toMatchObject({
      controls: { bridgePermissionMode: "alwaysDeny" },
    });
  });

  it("persists an idle pending configuration before applying and retains it when the switch fails", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly message?: PendingSessionMessage;
        },
        noticeMessageId?: string | null,
      ): Promise<{ readonly rejected?: true }>;
      activeChatCount: number;
    };

    // Idle topic (no live runtime): the target Agent's first-turn spawn fails,
    // so the whole switch fails through the same canonical applier the Turn
    // boundary uses. The candidate is persisted before applying, so the
    // previous Session stays selected with its Pending Configuration intact.
    spawnAgentMock.mockReset();
    spawnAgentMock.mockRejectedValue(new Error("spawn failed"));

    const result = await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:atomic",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        message: { prompt: "continue the task", createdAt: 10 },
      },
      "om_handoff",
    );

    expect(result).toMatchObject({ rejected: true });
    expect(spawnAgentMock).toHaveBeenCalled();
    expect(testable.activeChatCount).toBe(0);
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after).toMatchObject({
      sessionId: "sess_claude",
      agentLabel: "claude",
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        message: { prompt: "continue the task" },
      },
    });
  });

  it("restart recovery delivers the attached message exactly once after a target Agent switch", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      acquireRuntime(
        chatId: string,
        threadId: string | null,
        binding: unknown,
      ): Promise<{
        enqueue(message: { prompt: []; messageId: string; chatId: string }): Promise<void>;
      }>;
    };

    // A leftover Pending Configuration as if the Bridge restarted right
    // after the request was queued but before its Turn boundary ran.
    await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "omt_1" },
      {
        targetAgent: {
          sessionId: "profile:restart",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        message: { prompt: "resume after restart", createdAt: 10 },
        createdAt: 1,
        updatedAt: 1,
      },
    );

    await testable.acquireRuntime("oc_A", "omt_1", {
      cwd: "/tmp",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      label: "claude",
      explicit: true,
      reception: false,
    });

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({ agentLabel: "codex" });
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
    // Exactly one Agent process was spawned — a recursive `acquireRuntime`
    // loop while delivering the recovered message would spawn (and orphan)
    // more than one.
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    expect(events.notices.at(-1)).toMatchObject({ title: "✅ Agent 已切换" });
    expect(events.notices.at(-1)?.body).toContain("已携带同一条请求中的 message");
  });

  it("restart recovery delivers the attached message exactly once after a controls-only pending configuration", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      acquireRuntime(
        chatId: string,
        threadId: string | null,
        binding: unknown,
      ): Promise<{
        enqueue(message: { prompt: []; messageId: string; chatId: string }): Promise<void>;
      }>;
    };

    await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "omt_1" },
      {
        controls: { bridgePermissionMode: "alwaysAllow" },
        message: { prompt: "resume after restart", createdAt: 10 },
        createdAt: 1,
        updatedAt: 1,
      },
    );
    // Delivering the recovered Message admits it onto a real ChatRuntime,
    // whose background turn processing would otherwise run to completion
    // (and fire its own nested Turn-boundary check) during this test. Hold
    // that background Turn open so this test observes only the recovery
    // application itself — exactly-once delivery is asserted via the
    // `prompt` call count instead.
    const promptSpy = vi.fn(() => new Promise<never>(() => {}));
    const agent = fakeAgentProcess("sess_claude");
    agent.connection.prompt = promptSpy;
    spawnAgentMock.mockResolvedValueOnce(agent);

    await testable.acquireRuntime("oc_A", "omt_1", {
      cwd: "/tmp",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      label: "claude",
      explicit: true,
      reception: false,
    });

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        controls: { bridgePermissionMode: "alwaysAllow" },
      });
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledTimes(1));
  });

  it("trusts caller-supplied controls without probing or validating target capabilities", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly controls?: SessionControlPatch;
        },
        noticeMessageId?: string | null,
      ): Promise<{ readonly queued?: true }>;
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
    const result = await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:bad-config",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        controls: { modelId: "caller-selected-model" },
      },
      "om_handoff",
    );

    expect(result).toMatchObject({ queued: true });
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        controls: { modelId: "caller-selected-model" },
      },
    });
  });

  it("keeps the atomic pending configuration even if the finishing old runtime re-persists its session", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly message?: PendingSessionMessage;
        },
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

    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:atomic",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        message: { prompt: "继续执行用户任务", createdAt: 10 },
      },
      "om_handoff",
    );

    // Reproduces the real race: when the old runtime finishes, its own
    // ChatRuntime.persistSession() re-saves the old session record — as it
    // does in production, carrying `pendingConfiguration` forward untouched
    // (spec §9.3: only the Bridge mutates it). The persisted Pending
    // Configuration must still be there for the post-turn Agent switch.
    const beforeReSave = await store.getLatest("oc_A", "omt_1");
    await store.save({
      ...existingClaudeSession(),
      updatedAt: 99,
      ...(beforeReSave?.pendingConfiguration
        ? { pendingConfiguration: beforeReSave.pendingConfiguration }
        : {}),
    });

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    await vi.waitFor(() => expect(testable.activeChatCount).toBe(1));
    expect(events.noticeUpdates.at(-1)).toMatchObject({
      title: "✅ Agent 已切换",
    });
    expect(events.noticeUpdates.at(-1)?.body).toContain("已携带同一条请求中的 message");
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it("merges caller-selected model changes into the pending target Agent without probing", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: { readonly controls?: SessionControlPatch },
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
    await testable.controlSetAgent(codexProfileRecord(), "om_handoff");
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      { controls: { modelId: "gpt-5.5" } },
      "om_model",
    );

    fakeRuntime.processing = false;
    await testable.handleRuntimeTurnComplete("oc_A", "omt_1", "om_handoff");

    expect(events.notices.some((notice) => notice.title === "⚠️ 会话配置失败")).toBe(false);
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      agentLabel: "codex",
      controls: { modelId: "gpt-5.5" },
    });
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("persists controls merged into an already queued pending configuration", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly controls?: SessionControlPatch;
          readonly message?: PendingSessionMessage;
        },
        noticeMessageId?: string | null,
      ): Promise<unknown>;
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
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:atomic",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        controls: { modelId: "gpt-5.5" },
        message: { prompt: "继续检查", createdAt: 10 },
      },
      "om_handoff",
    );
    await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      { controls: { modelId: "gpt-5.6", modeId: "agent" } },
      "om_model",
    );

    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
      agentLabel: "claude",
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        controls: { modelId: "gpt-5.6", modeId: "agent" },
        message: { prompt: "继续检查" },
      },
    });
    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("selects the target Agent immediately when the topic has no real session yet", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
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

  it("persists a profile-only carrier with the pending snapshot before a brand-new target Agent starts", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly message?: PendingSessionMessage;
        },
        noticeMessageId?: string | null,
      ): Promise<{
        readonly applied?: true;
        readonly agent?: string;
        readonly messageSent?: boolean;
      }>;
    };

    const order: string[] = [];
    const savedRecords: SessionRecord[] = [];
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (record) => {
      order.push(record.pendingConfiguration ? "save-carrier-with-pending" : "save-clean");
      savedRecords.push(structuredClone(record));
      await originalSave(record);
    });
    // Hold the target Agent's first turn open so the just-started switch stays
    // observable without a background completion racing the assertions.
    spawnAgentMock.mockReset();
    spawnAgentMock.mockImplementation(async () => {
      order.push("spawn");
      const agent = fakeAgentProcess("sess_codex");
      agent.connection.prompt = vi.fn(() => new Promise<never>(() => {}));
      return agent;
    });

    const result = await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:new",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        message: { prompt: "start the task", createdAt: 10 },
      },
      "om_new",
    );

    expect(result).toMatchObject({ applied: true, agent: "codex", messageSent: true });
    // The profile-only carrier carrying the full pending snapshot was persisted
    // before the target Agent process was ever spawned.
    expect(order[0]).toBe("save-carrier-with-pending");
    expect(order.indexOf("save-carrier-with-pending")).toBeLessThan(order.indexOf("spawn"));
    expect(savedRecords[0]).toMatchObject({
      profileOnly: true,
      agentLabel: "codex",
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        message: { prompt: "start the task" },
      },
    });
    // The switch reads as "from no previous Session", never a same-Agent self-switch.
    const switched = events.notices.find((notice) => notice.title === "✅ Agent 已切换");
    expect(switched?.body).toContain("Agent：未绑定 → codex");
    expect(switched?.body).not.toContain("codex → codex");
    // Steady state: the carrier is replaced by the applied target with no
    // pending config left behind (the delivered Message then evolves it into a
    // live session).
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after).toMatchObject({ agentLabel: "codex" });
    expect(after?.pendingConfiguration).toBeUndefined();
  });

  it("applies the persisted carrier snapshot, not the caller's local candidate, on a brand-new topic", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: { readonly targetAgent?: PendingTargetAgent },
        noticeMessageId?: string | null,
      ): Promise<{ readonly applied?: true; readonly agent?: string }>;
    };

    // The store rewrites the carrier's Agent identity as it is persisted. If the
    // canonical applier re-reads the persisted snapshot (as required) the
    // rewritten Agent is applied; using the caller's local object would apply
    // the original "codex" label instead.
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (record) => {
      const pending = record.pendingConfiguration;
      const rewritten: SessionRecord = pending?.targetAgent
        ? {
            ...record,
            agentLabel: "persisted-codex",
            pendingConfiguration: {
              ...pending,
              targetAgent: { ...pending.targetAgent, agentLabel: "persisted-codex" },
            },
          }
        : record;
      await originalSave(rewritten);
    });

    const result = await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:new",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
      },
      "om_new",
    );

    expect(result).toMatchObject({ applied: true, agent: "persisted-codex" });
    expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({ agentLabel: "persisted-codex" });
    const switched = events.notices.find((notice) => notice.title === "✅ Agent 已切换");
    expect(switched?.body).toContain("Agent：未绑定 → persisted-codex");
  });

  it("retains the durable carrier with its pending configuration when a brand-new switch fails", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      controlConfigureSession(
        chatId: string,
        threadId: string | null,
        input: {
          readonly targetAgent?: PendingTargetAgent;
          readonly message?: PendingSessionMessage;
        },
        noticeMessageId?: string | null,
      ): Promise<{ readonly rejected?: true }>;
    };

    // Brand-new topic, no prior Session: the target Agent's first-turn spawn
    // fails through the same canonical applier, so the durable carrier must
    // survive with its full pending configuration for a later retry.
    spawnAgentMock.mockReset();
    spawnAgentMock.mockRejectedValue(new Error("spawn failed"));

    const result = await testable.controlConfigureSession(
      "oc_A",
      "omt_1",
      {
        targetAgent: {
          sessionId: "profile:new",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        message: { prompt: "start the task", createdAt: 10 },
      },
      "om_new",
    );

    expect(result).toMatchObject({ rejected: true });
    expect(bridge.activeChatCount).toBe(0);
    const after = await store.getLatest("oc_A", "omt_1");
    expect(after).toMatchObject({
      profileOnly: true,
      agentLabel: "codex",
      pendingConfiguration: {
        targetAgent: { agentLabel: "codex" },
        message: { prompt: "start the task" },
      },
    });
    // A brand-new failure never claims a prior-Session same-Agent self-switch.
    expect(events.notices.every((notice) => !notice.body.includes("codex → codex"))).toBe(true);
    expect(events.noticeUpdates.every((notice) => !notice.body.includes("codex → codex"))).toBe(
      true,
    );
  });

  it("sends only the dedicated pending failure notice, not a generic Agent failure notice, when the pending application fails after a successful turn", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as {
      acquireRuntime(
        chatId: string,
        threadId: string | null,
        binding: unknown,
      ): Promise<{
        enqueue(message: {
          prompt: { type: "text"; text: string }[];
          messageId: string;
          chatId: string;
        }): Promise<void>;
        readonly processing: boolean;
      }>;
    };

    // A live claude turn whose prompt we hold open so a Pending Configuration
    // can be queued mid-turn and applied exactly at the Turn boundary.
    let resolvePrompt: (response: acp.PromptResponse) => void = () => {};
    const agent = fakeAgentProcess("sess_claude");
    agent.connection.prompt = () =>
      new Promise<acp.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
    spawnAgentMock.mockReset();
    spawnAgentMock.mockResolvedValue(agent);

    const runtime = await testable.acquireRuntime("oc_A", "omt_1", {
      cwd: "/tmp",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      label: "claude",
      explicit: true,
      reception: false,
    });
    await runtime.enqueue({
      prompt: [{ type: "text", text: "do the work" }],
      messageId: "om_turn",
      chatId: "oc_A",
    });
    await vi.waitFor(() => expect(runtime.processing).toBe(true));

    // Queue a controls-only Pending Configuration that is valid to persist but
    // fails to apply at the Turn boundary (the live agent exposes no model
    // controls), simulating capabilities drift between queue and apply.
    await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "omt_1" },
      { controls: { modelId: "gone-at-apply-time" }, createdAt: 1, updatedAt: 1 },
    );

    // The turn itself completes successfully; only the Pending Configuration
    // application fails at the Turn boundary.
    resolvePrompt({ stopReason: "end_turn" });

    await vi.waitFor(() => {
      expect(
        [...events.notices, ...events.noticeUpdates].some(
          (notice) => notice.title === "⚠️ 待应用配置变更未完成",
        ),
      ).toBe(true);
    });
    // Let any (erroneous) second failure card flush before asserting only one.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const failureCards = [...events.notices, ...events.noticeUpdates].filter(
      (notice) => notice.template === "red",
    );
    expect(failureCards).toHaveLength(1);
    expect(failureCards[0]).toMatchObject({ title: "⚠️ 待应用配置变更未完成" });
    // The Pending Configuration is retained for retry after the failed apply.
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toMatchObject({
      controls: { modelId: "gone-at-apply-time" },
    });
  });
});

describe("LarkBridge global defaults from direct-message control chat", () => {
  beforeEach(() => {
    probeAgentSessionCapabilitiesMock.mockReset();
    probeAgentSessionCapabilitiesMock.mockResolvedValue({ sessionId: "probe", capabilities: {} });
    spawnAgentMock.mockReset();
    spawnAgentMock.mockResolvedValue(fakeAgentProcess("sess_default"));
  });

  it("persists an Agent change from the configured direct-message control chat into settings.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-global-default-agent-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ runtime: { agent: "claude", globalControlChatIds: ["oc_DM"] } }),
      );
      const store = new MemorySessionStore();
      const events: PresenterEvents = {
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      };
      const bridge = makeBridge(store, recordingPresenter(events), {
        settingsPath,
        globalDefaultControlChatIds: ["oc_DM"],
      });

      await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" }, "om_dm_agent", {
        chatId: "oc_DM",
        threadId: null,
        isDirectMessage: true,
      });

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
        runtime?: { agent?: string };
      };
      expect(settings.runtime?.agent).toBe("codex");
      expect(events.notices.at(-1)?.body).toContain("全局默认");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist an Agent change from the same configured chat when the message is not a direct message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-global-default-agent-group-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ runtime: { agent: "claude", globalControlChatIds: ["oc_DM"] } }),
      );
      const store = new MemorySessionStore();
      const events: PresenterEvents = {
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      };
      const bridge = makeBridge(store, recordingPresenter(events), {
        settingsPath,
        globalDefaultControlChatIds: ["oc_DM"],
      });

      await dispatchCommand(bridge, { kind: "set-agent", agent: "codex" }, "om_group_agent", {
        chatId: "oc_DM",
        threadId: null,
        isDirectMessage: false,
      });

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
        runtime?: { agent?: string };
      };
      expect(settings.runtime?.agent).toBe("claude");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists session controls from the configured direct-message control chat into runtime.defaultControls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-global-default-controls-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ runtime: { globalControlChatIds: ["oc_DM"] } }),
      );
      const store = new MemorySessionStore([
        {
          chatId: "oc_DM",
          threadId: null,
          sessionId: "profile:dm",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/claude-code-acp"],
          agentLabel: "claude",
          cwd: "/tmp",
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
      const events: PresenterEvents = {
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      };
      const bridge = makeBridge(store, recordingPresenter(events), {
        settingsPath,
        globalDefaultControlChatIds: ["oc_DM"],
      });

      await dispatchCommand(
        bridge,
        { kind: "set-permission", permissionMode: "alwaysAllow" },
        "om_dm_permission",
        { chatId: "oc_DM", threadId: null, isDirectMessage: true },
      );

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
        runtime?: { permissionMode?: string; defaultControls?: SessionControls };
      };
      expect(settings.runtime?.permissionMode).toBe("alwaysAllow");
      expect(settings.runtime?.defaultControls).toMatchObject({
        bridgePermissionMode: "alwaysAllow",
      });
      expect(events.notices.at(-1)?.body).toContain("全局默认");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists atomic pending configuration Agent and controls from the configured control chat into settings.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-global-default-target-profile-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ runtime: { agent: "claude", globalControlChatIds: ["oc_DM"] } }),
      );
      const store = new MemorySessionStore();
      const events: PresenterEvents = {
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      };
      const bridge = makeBridge(store, recordingPresenter(events), {
        settingsPath,
        globalDefaultControlChatIds: ["oc_DM"],
      });
      const testable = bridge as unknown as {
        controlConfigureSession(
          chatId: string,
          threadId: string | null,
          input: {
            readonly targetAgent?: PendingTargetAgent;
            readonly controls?: SessionControlPatch;
          },
          noticeMessageId?: string | null,
        ): Promise<{ readonly rejected?: true }>;
        persistGlobalDefaultAgent(target: string, messageId: string | null): Promise<void>;
        persistGlobalDefaultControls(
          controls: SessionControlPatch,
          messageId: string | null,
        ): Promise<void>;
      };
      const input = {
        targetAgent: {
          sessionId: "profile:codex-gpt",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@zed-industries/codex-acp"],
          agentLabel: "codex",
          cwd: "/tmp",
        },
        controls: { modelId: "gpt-5.5" },
      };
      // Mirrors the `configureSession` control-server handler wrapper in
      // startControlServer(), which persists global defaults after a
      // successful configure from a configured DM control chat.
      const result = await testable.controlConfigureSession("oc_DM", null, input, "om_dm_handoff");
      expect(result).not.toHaveProperty("rejected");
      expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
      await testable.persistGlobalDefaultAgent(input.targetAgent.agentLabel, null);
      await testable.persistGlobalDefaultControls(input.controls, null);

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
        runtime?: { agent?: string; defaultControls?: SessionControls };
      };
      expect(settings.runtime?.agent).toBe("codex");
      expect(settings.runtime?.defaultControls).toMatchObject({ modelId: "gpt-5.5" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses configured global default controls for a new topic with no pinned or inherited profile", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events), {
      defaultControls: { bridgePermissionMode: "alwaysAllow" },
    });
    const testable = bridge as unknown as {
      acquireRuntime(
        chatId: string,
        threadId: string | null,
        binding: unknown,
      ): Promise<{
        enqueue(message: { prompt: []; messageId: string; chatId: string }): Promise<void>;
      }>;
    };

    const runtime = await testable.acquireRuntime("oc_A", "omt_new", {
      cwd: "/tmp",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      label: "claude",
      explicit: true,
      reception: false,
    });
    await runtime.enqueue({ prompt: [], messageId: "om_new", chatId: "oc_A" });

    expect(await store.getLatest("oc_A", "omt_new")).toMatchObject({
      controls: { bridgePermissionMode: "alwaysAllow" },
    });
  });

  it("uses hot-reloaded settings runtime Agent and default controls for a new topic", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-hot-reload-global-defaults-"));
    try {
      const settingsPath = path.join(dir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ runtime: { agent: "claude" } }));
      const store = new MemorySessionStore();
      const events: PresenterEvents = {
        warnings: [],
        warningResolutions: [],
        notices: [],
        commandResults: [],
        noticeUpdates: [],
      };
      const bridge = makeBridge(store, recordingPresenter(events), { settingsPath });
      const testable = bridge as unknown as {
        resolveBinding(chatId: string): Promise<unknown>;
        acquireRuntime(
          chatId: string,
          threadId: string | null,
          binding: unknown,
        ): Promise<{
          enqueue(message: { prompt: []; messageId: string; chatId: string }): Promise<void>;
        }>;
      };

      const bindingResolvedBeforeSettingsChange = await testable.resolveBinding("oc_A");
      spawnAgentMock.mockResolvedValueOnce(
        fakeAgentProcess("sess_codex_hot", {
          models: {
            currentModelId: "auto",
            availableModels: [
              { modelId: "auto", name: "Auto" },
              { modelId: "gpt-5.6 solar", name: "GPT-5.6 Solar" },
            ],
          },
        }),
      );
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          runtime: {
            agent: "codex",
            defaultControls: { modelId: "gpt-5.6 solar" },
          },
        }),
      );

      const runtime = await testable.acquireRuntime(
        "oc_A",
        "omt_hot",
        bindingResolvedBeforeSettingsChange,
      );
      await runtime.enqueue({ prompt: [], messageId: "om_hot", chatId: "oc_A" });

      expect(await store.getLatest("oc_A", "omt_hot")).toMatchObject({
        agentLabel: "codex",
        controls: { modelId: "gpt-5.6 solar" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Resolve `work`, or reject once `ms` elapses, so a deadlocked call surfaces
 * as an explicit "did not settle" failure instead of a generic test timeout.
 */
async function settlesWithin<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

describe("LarkBridge Pending Configuration lock — runtime acquisition under lock", () => {
  interface AcquisitionTestable {
    controlSendMessage(
      chatId: string,
      threadId: string | null,
      message: PendingSessionMessage,
      noticeMessageId?: string | null,
    ): Promise<{ readonly sent: true } | { readonly queued: true }>;
    acquireRuntime(
      chatId: string,
      threadId: string | null,
      binding: unknown,
    ): Promise<{
      enqueue(message: {
        prompt: { type: "text"; text: string }[];
        messageId: string;
        chatId: string;
      }): Promise<void>;
    }>;
  }

  beforeEach(() => {
    probeAgentSessionCapabilitiesMock.mockReset();
    probeAgentSessionCapabilitiesMock.mockResolvedValue({ sessionId: "probe", capabilities: {} });
    spawnAgentMock.mockReset();
    spawnAgentMock.mockResolvedValue(fakeAgentProcess("sess_claude"));
  });

  it("controlSendMessage with no cached runtime settles and sends exactly once without deadlocking", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as AcquisitionTestable;

    // Hold the delivered Message's turn open so the test observes only the
    // send path; exactly-once delivery is asserted via the prompt spy.
    const promptSpy = vi.fn(() => new Promise<never>(() => {}));
    const agent = fakeAgentProcess("sess_claude");
    agent.connection.prompt = promptSpy;
    spawnAgentMock.mockReset();
    spawnAgentMock.mockResolvedValue(agent);

    // There is no cached runtime and no persisted Pending Configuration, so
    // this holds withPendingConfigurationLock and then acquires a runtime.
    // Before the fix that acquisition re-entered the same non-reentrant lock
    // via restart recovery and deadlocked (empirically reproduced as a
    // timeout); it must now settle.
    const result = await settlesWithin(
      testable.controlSendMessage("oc_A", "omt_1", { prompt: "hello", createdAt: 10 }, "om_send"),
      2000,
      "controlSendMessage",
    );

    expect(result).toEqual({ sent: true });
    // Exactly one runtime built (no recursive acquire) and the Message
    // delivered exactly once.
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledTimes(1));
    // No phantom Pending Configuration was written behind the send.
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
  });

  it("ordinary runtime acquisition still runs pending recovery (send-path skip does not leak)", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
      noticeUpdates: [],
    };
    const bridge = makeBridge(store, recordingPresenter(events));
    const testable = bridge as unknown as AcquisitionTestable;

    // A leftover controls-only Pending Configuration, as if the Bridge
    // restarted before its Turn boundary ran.
    await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "omt_1" },
      { controls: { bridgePermissionMode: "alwaysAllow" }, createdAt: 1, updatedAt: 1 },
    );

    // Ordinary ingress acquisition (default "recover-on-acquire" policy) must
    // still apply the leftover Pending Configuration before building the
    // runtime — the send-path "pending-observed-under-lock" skip must not leak.
    await testable.acquireRuntime("oc_A", "omt_1", {
      cwd: "/tmp",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      label: "claude",
      explicit: true,
      reception: false,
    });

    await vi.waitFor(async () => {
      expect(await store.getLatest("oc_A", "omt_1")).toMatchObject({
        controls: { bridgePermissionMode: "alwaysAllow" },
      });
    });
    expect((await store.getLatest("oc_A", "omt_1"))?.pendingConfiguration).toBeUndefined();
  });
});
