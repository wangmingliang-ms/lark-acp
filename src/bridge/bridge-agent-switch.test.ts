import { describe, expect, it, beforeEach, vi } from "vitest";
import { LarkBridge, type LarkCommand, type ResolvedAgentInvocation } from "./bridge.js";
import type { ProbeAgentSessionCapabilitiesResult } from "../acp/agent-process.js";
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
  SessionControlPatch,
  SessionControlTarget,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";

const probeAgentSessionCapabilitiesMock = vi.hoisted(() =>
  vi.fn<() => Promise<ProbeAgentSessionCapabilitiesResult>>(),
);

vi.mock("../acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/agent-process.js")>();
  return {
    ...actual,
    probeAgentSessionCapabilities: probeAgentSessionCapabilitiesMock,
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
    sendUnifiedCard: async (_messageId, _state: UnifiedCardState) => "unified_card",
    updateUnifiedCard: async () => true,
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

describe("LarkBridge destructive Agent switch confirmation", () => {
  beforeEach(() => {
    probeAgentSessionCapabilitiesMock.mockReset();
    probeAgentSessionCapabilitiesMock.mockResolvedValue({ sessionId: "probe", capabilities: {} });
  });

  it("warns and does not probe or switch when /agent targets an already-started topic", async () => {
    const store = new MemorySessionStore([existingClaudeSession()]);
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
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

  it("selects the target Agent immediately when the topic has no real session yet", async () => {
    const store = new MemorySessionStore();
    const events: PresenterEvents = {
      warnings: [],
      warningResolutions: [],
      notices: [],
      commandResults: [],
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
