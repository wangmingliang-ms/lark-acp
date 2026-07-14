/**
 * Reception-area + hot-reload behaviour (task 2, natural-language binding).
 *
 * Same black-box approach as binding-routing.test.ts: a recording presenter, a
 * spy resolver, real temp-dir stores, and a narrow typed view of the private
 * routing methods. No Lark credentials, no real agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LarkBridge,
  FileSessionStore,
  SettingsBindingStore,
  type LarkPresenter,
  type NoticeCardSpec,
  type AgentSwitchWarningCardSpec,
  type AgentSwitchWarningResolution,
  type SessionControlPatch,
  type SessionRecord,
  type AgentResolver,
  type ResolvedAgentInvocation,
} from "../src/index.js";
import type * as Lark from "@larksuiteoapi/node-sdk";

const probeAgentSessionCapabilitiesMock = vi.fn(async (_opts?: unknown) => ({
  sessionId: "probe_session",
  capabilities: {},
}));

vi.mock("../src/acp/agent-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp/agent-process.js")>();
  return {
    ...actual,
    probeAgentSessionCapabilities: (opts: unknown) => probeAgentSessionCapabilitiesMock(opts),
  };
});

class RecordingPresenter implements LarkPresenter {
  readonly notices: NoticeCardSpec[] = [];
  readonly commandResults: NoticeCardSpec[] = [];
  readonly agentSwitchWarnings: AgentSwitchWarningCardSpec[] = [];
  readonly agentSwitchResolutions: AgentSwitchWarningResolution[] = [];
  async replyText(): Promise<void> {}
  async sendConversationCard(): Promise<string | null> {
    return null;
  }
  async updateConversationCard(): Promise<boolean> {
    return true;
  }
  async sendPermissionRequestCard(): Promise<string | null> {
    return null;
  }
  async expirePermissionCard(): Promise<void> {}
  async replyNoticeCard(_id: string, notice: NoticeCardSpec): Promise<string | null> {
    this.notices.push(notice);
    return "notice_msg";
  }
  async replyCommandResultCard(_id: string, result: NoticeCardSpec): Promise<void> {
    this.commandResults.push(result);
  }
  async sendNoticeCard(_chatId: string, notice: NoticeCardSpec): Promise<string | null> {
    this.notices.push(notice);
    return "notice_msg";
  }
  async replyAgentSwitchWarningCard(
    _id: string,
    warning: AgentSwitchWarningCardSpec,
  ): Promise<string | null> {
    this.agentSwitchWarnings.push(warning);
    return "agent_switch_warning_msg";
  }
  async updateAgentSwitchWarningCard(
    _id: string,
    resolution: AgentSwitchWarningResolution,
  ): Promise<void> {
    this.agentSwitchResolutions.push(resolution);
  }
}

interface ReceptionBinding {
  cwd: string;
  label: string;
  explicit: boolean;
  reception: boolean;
  fallbackFrom?: {
    chatId: string;
    cwd: string;
    reason: string;
    reboundCwd: string;
    reboundAgentLabel: string;
  };
}
interface BridgeInternals {
  resolveBinding(chatId: string): Promise<ReceptionBinding | null>;
  reloadBindings(): Promise<void>;
  snapshotBindings(): Promise<void>;
  acquireRuntime(
    chatId: string,
    threadId: string | null,
    binding: ReceptionBinding,
  ): Promise<unknown>;
  notifyUnavailableBindingFallback(
    messageId: string,
    from: NonNullable<ReceptionBinding["fallbackFrom"]>,
  ): Promise<void>;
  controlConfigureSession(
    chatId: string,
    threadId: string | null,
    input: {
      readonly targetAgent?: unknown;
      readonly controls?: SessionControlPatch;
      readonly message?: unknown;
    },
    noticeMessageId?: string | null,
  ): Promise<unknown>;
  controlBindSession(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
  controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
  controlAgentProbeFailed(
    chatId: string,
    threadId: string | null,
    agent: { label?: string; command: string; args: readonly string[]; cwd: string },
    error: string,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
  routeMessage(
    event: Lark.RawMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<void>;
  handleCardAction(event: Lark.CardActionEvent): void;
  readonly activeChatCount: number;
}
function asInternals(bridge: LarkBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals;
}

function textEvent(
  text: string,
  chatId: string,
  threadId: string | null,
  messageId: string,
): Lark.RawMessageEvent {
  return {
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...(threadId ? { thread_id: threadId } : {}),
    },
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_user" },
    },
  } as unknown as Lark.RawMessageEvent;
}

const CLAUDE: ResolvedAgentInvocation = {
  command: "npx",
  args: ["-y", "claude-code-acp"],
  label: "claude",
};
const CODEX: ResolvedAgentInvocation = {
  command: "npx",
  args: ["-y", "codex-acp"],
  label: "codex",
};
const resolver: AgentResolver = (sel) => {
  if (sel === "claude") return CLAUDE;
  if (sel === "codex") return CODEX;
  const [command, ...args] = sel.trim().split(/\s+/);
  return { command: command ?? "x", args, label: sel };
};

let root: string;
let home: string;
let settingsPath: string;
let repoA: string;
let presenter: RecordingPresenter;
let bindingStore: SettingsBindingStore;
let sessionStore: FileSessionStore;
let bridge: LarkBridge;

function makeBridge(opts?: { unboundCwd?: string | null }): LarkBridge {
  return new LarkBridge({
    lark: { appId: "cli_test", appSecret: "secret_test" },
    agent: {
      resolver,
      availableAgents: [
        { id: "claude", label: "Claude Code", description: "Claude test preset" },
        { id: "codex", label: "Codex CLI", description: "Codex test preset" },
      ],
      defaultAgent: CLAUDE,
      defaultCwd: null,
      permissionMode: "alwaysAllow",
    },
    sessionStore,
    bindingStore,
    presenter,
    settingsPath,
    controlSocketPath: path.join(home, "control.sock"),
    unboundCwd: opts && "unboundCwd" in opts ? opts.unboundCwd : home,
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "humming-recv-"));
  home = path.join(root, "home");
  repoA = path.join(root, "repo-a");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repoA, { recursive: true });
  settingsPath = path.join(home, "settings.json");

  presenter = new RecordingPresenter();
  probeAgentSessionCapabilitiesMock.mockReset();
  probeAgentSessionCapabilitiesMock.mockResolvedValue({
    sessionId: "probe_session",
    capabilities: {
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
          { id: "agent", name: "Agent", description: "Autonomous mode" },
        ],
      },
      configOptions: [
        { id: "autoSave", name: "Auto Save", type: "boolean", currentValue: true },
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
  });
  bindingStore = new SettingsBindingStore(settingsPath);
  sessionStore = new FileSessionStore(home);
  await bindingStore.init();
  await sessionStore.init();
});

afterEach(async () => {
  await bridge?.stop?.().catch(() => {});
  await bindingStore.close();
  await sessionStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reception area", () => {
  it("routes an unbound chat to the reception cwd with the default agent", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    const eff = await b.resolveBinding("oc_new");
    expect(eff).toMatchObject({ cwd: home, label: "claude", explicit: false, reception: true });
  });

  it("returns null (no reception) when unboundCwd is disabled", async () => {
    bridge = makeBridge({ unboundCwd: null });
    const b = asInternals(bridge);
    expect(await b.resolveBinding("oc_new")).toBeNull();
  });

  it("prefers a real repo binding over the reception area and uses the default agent", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_bound", cwd: repoA, createdAt: 1, updatedAt: 1 });
    const eff = await b.resolveBinding("oc_bound");
    expect(eff).toMatchObject({ cwd: repoA, label: "claude", explicit: true, reception: false });
  });

  it("new topic runtime inherits Agent + controls from the latest session in the same repo", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_bound", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_bound",
      threadId: "th_old",
      sessionId: "s_codex",
      agentCommand: CODEX.command,
      agentArgs: [...CODEX.args],
      agentLabel: CODEX.label,
      cwd: repoA,
      controls: { modeId: "agent", bridgePermissionMode: "alwaysAsk" },
      createdAt: 1,
      updatedAt: 10,
    });

    const eff = await b.resolveBinding("oc_bound");
    const runtime = await b.acquireRuntime("oc_bound", "th_new", eff!);

    const opts = (
      runtime as {
        opts: { agentLabel?: string; agentCommand: string; inheritedControls?: unknown };
      }
    ).opts;
    expect(opts).toMatchObject({ agentLabel: "codex", agentCommand: "npx" });
    expect(opts.inheritedControls).toMatchObject({
      modeId: "agent",
      bridgePermissionMode: "alwaysAsk",
    });
  });

  it("warns once and automatically rebinds to the reception area when the bound repo was deleted", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_deleted", cwd: repoA, createdAt: 1, updatedAt: 1 });
    fs.rmSync(repoA, { recursive: true, force: true });

    const eff = await b.resolveBinding("oc_deleted");

    expect(eff).toMatchObject({
      cwd: home,
      label: "claude",
      explicit: false,
      reception: true,
      fallbackFrom: {
        chatId: "oc_deleted",
        cwd: repoA,
        reboundCwd: home,
        reboundAgentLabel: "claude",
      },
    });
    expect(await bindingStore.get("oc_deleted")).toMatchObject({ cwd: home });

    const next = await b.resolveBinding("oc_deleted");
    expect(next).toMatchObject({ cwd: home, label: "claude", explicit: true, reception: false });
    expect(next?.fallbackFrom).toBeUndefined();
  });

  it("sends an error notice and continues in the reception area for a deleted repo", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_deleted", cwd: repoA, createdAt: 1, updatedAt: 1 });
    fs.rmSync(repoA, { recursive: true, force: true });

    const eff = await b.resolveBinding("oc_deleted");
    await b.notifyUnavailableBindingFallback("om_deleted", eff!.fallbackFrom!);
    await b.acquireRuntime("oc_deleted", null, eff!);

    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({
      title: "⚠️ Repo 不可用，已重新绑定到 Humming home",
      template: "orange",
    });
    expect(notice?.body).toContain(repoA);
    expect(notice?.body).toContain(home);
    expect(notice?.body).toContain("路径不存在");
    expect(notice?.body).toContain("不会重复发送本 warning");
    expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf-8")).toContain("oc_deleted");

    const count = presenter.notices.length;
    const next = await b.resolveBinding("oc_deleted");
    if (next?.fallbackFrom)
      await b.notifyUnavailableBindingFallback("om_deleted_2", next.fallbackFrom);
    expect(presenter.notices.length).toBe(count);
  });

  it("drops AGENTS.md + CLAUDE.md bind instructions into the reception cwd", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    const eff = await b.resolveBinding("oc_new");
    await b.acquireRuntime("oc_new", null, eff!);
    const agents = fs.readFileSync(path.join(home, "AGENTS.md"), "utf-8");
    const claude = fs.readFileSync(path.join(home, "CLAUDE.md"), "utf-8");
    expect(agents).toContain("oc_new");
    expect(agents).toContain("bindings");
    expect(agents).toContain(settingsPath);
    expect(claude).toEqual(agents);
  });

  it("installs home guide and example JSON files on bridge start", async () => {
    bridge = makeBridge({ unboundCwd: home });
    await bridge.start();

    expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf-8")).toContain(
      "humming operating guide",
    );
    expect(fs.readFileSync(path.join(home, "CLAUDE.md"), "utf-8")).toContain(
      "humming operating guide",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "settings.back.json"), "utf-8")),
    ).toMatchObject({
      runtime: { agent: "claude" },
      bindings: { oc_example_chat_id: { cwd: "/absolute/path/to/repo" } },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "settings.back.json"), "utf-8")),
    ).not.toMatchObject({ bindings: { oc_example_chat_id: { agent: "claude" } } });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [{ controls: { bridgePermissionMode: "alwaysAsk" } }],
    });
  });
});

describe("hot-reload of bindings", () => {
  it("tears down a chat runtime when its repo binding appears via settings.json and notifies details", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await b.snapshotBindings();

    // A reception runtime exists for the unbound chat.
    const recv = await b.resolveBinding("oc_x");
    await b.acquireRuntime("oc_x", null, recv!);
    expect(b.activeChatCount).toBe(1);

    // Simulate the agent binding the chat by editing settings.json directly.
    const settings = { bindings: { oc_x: { cwd: repoA } } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    await b.reloadBindings();

    // The stale reception runtime is gone; next message will respawn in repoA.
    expect(b.activeChatCount).toBe(0);
    const eff = await b.resolveBinding("oc_x");
    expect(eff).toMatchObject({ cwd: repoA, label: "claude", explicit: true });
    const notice = presenter.notices.find((n) => n.title === "✅ 已绑定 repo");
    expect(notice?.body).toContain("修改明细");
    expect(notice?.body).toContain(repoA);
    expect(notice?.body).not.toContain("Agent：");
  });

  it("no-ops when the settings file is unchanged", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_y", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await b.snapshotBindings();
    const recv = await b.resolveBinding("oc_y");
    await b.acquireRuntime("oc_y", null, recv!);
    expect(b.activeChatCount).toBe(1);

    await b.reloadBindings(); // nothing changed
    expect(b.activeChatCount).toBe(1); // runtime survives
  });

  it("tolerates a half-written settings.json (keeps last-good state)", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_z", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await b.snapshotBindings();
    await b.acquireRuntime("oc_z", null, (await b.resolveBinding("oc_z"))!);
    expect(b.activeChatCount).toBe(1);

    fs.writeFileSync(settingsPath, "{ half writ"); // corrupt mid-write
    await b.reloadBindings();

    // A transient corrupt read must NOT be mistaken for "all bindings removed":
    // the live runtime survives and the binding is still resolvable once the
    // file is (conceptually) rewritten. The reload simply deferred.
    expect(b.activeChatCount).toBe(1);
  });
});

describe("compact slash session profile commands", () => {
  it("lists all Humming commands via /help", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);

    await b.routeMessage(
      textEvent("/help", "oc_x", "th_topic", "om_help"),
      "ou_user",
      "om_help",
      "oc_x",
      "th_topic",
    );

    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "ℹ️ Humming commands", template: "blue" });
    expect(result?.body).toContain("/capabilities");
    expect(result?.body).toContain("/capabilities <agent>");
    expect(result?.body).toContain("/agent <agent>");
    expect(result?.body).toContain("/model auto");
    expect(result?.body).toContain("/mode <mode-id>");
    expect(result?.body).toContain("/permission <alwaysAsk|alwaysAllow|alwaysDeny>");
    expect(result?.body).toContain("/bind <路径>");
    expect(result?.body).toContain("/cancel");
    expect(result?.body).toContain("/stop");
    expect(result?.body).toContain("/new");
    expect(result?.body).toContain("/restart");
    expect(result?.body).toContain("/where");
    expect(result?.body).toContain("/pwd");
    expect(result?.body).toContain("/unbind");
    expect(result?.body).toContain("/unpin");
  });

  it("lists available Agents via bare /agent", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);

    await b.routeMessage(
      textEvent("/agent", "oc_x", "th_topic", "om_agent_list"),
      "ou_user",
      "om_agent_list",
      "oc_x",
      "th_topic",
    );

    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🤖 可用 Agents", template: "blue" });
    expect(result?.body).toContain("claude — Claude Code");
    expect(result?.body).toContain("codex — Codex CLI");
    expect(result?.body).toContain("/agent <agent>");
  });

  it("lists available Models via bare /model by probing the effective Agent", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });

    await b.routeMessage(
      textEvent("/model", "oc_x", "th_topic", "om_model_list"),
      "ou_user",
      "om_model_list",
      "oc_x",
      "th_topic",
    );

    expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: CLAUDE.command, args: CLAUDE.args, cwd: repoA }),
    );
    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🧠 可用 Models", template: "blue" });
    expect(result?.body).toContain("model-old — Old（当前）");
    expect(result?.body).toContain("model-new — New");
    expect(result?.body).toContain("/model auto");
  });

  it("lists available Modes via bare /mode by probing the effective Agent", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });

    await b.routeMessage(
      textEvent("/mode", "oc_x", "th_topic", "om_mode_list"),
      "ou_user",
      "om_mode_list",
      "oc_x",
      "th_topic",
    );

    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🧭 可用 Modes", template: "blue" });
    expect(result?.body).toContain("ask — Ask（当前）");
    expect(result?.body).toContain("agent — Agent：Autonomous mode");
    expect(result?.body).toContain("/mode <mode-id>");
  });

  it("lists bridge permission modes via bare /permission", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);

    await b.routeMessage(
      textEvent("/permission", "oc_x", "th_topic", "om_perm_list"),
      "ou_user",
      "om_perm_list",
      "oc_x",
      "th_topic",
    );

    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🛂 可用 Permission modes", template: "blue" });
    expect(result?.body).toContain("alwaysAsk");
    expect(result?.body).toContain("alwaysAllow");
    expect(result?.body).toContain("alwaysDeny");
    expect(result?.body).toContain("/permission <mode>");
  });

  it("lists full capabilities for the current effective Agent via /capabilities", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });

    await b.routeMessage(
      textEvent("/capabilities", "oc_x", "th_topic", "om_caps"),
      "ou_user",
      "om_caps",
      "oc_x",
      "th_topic",
    );

    expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: CLAUDE.command, args: CLAUDE.args, cwd: repoA }),
    );
    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🧩 Agent capabilities", template: "blue" });
    expect(result?.body).toContain("查询范围：当前有效 Agent");
    expect(result?.body).toContain("**Models**");
    expect(result?.body).toContain("model-old — Old（当前）");
    expect(result?.body).toContain("**Modes**");
    expect(result?.body).toContain("agent — Agent：Autonomous mode");
    expect(result?.body).toContain("**Config options**");
    expect(result?.body).toContain("autoSave — Auto Save (boolean, 当前 on)");
    expect(result?.body).toContain("effort — Effort (select, 当前 high; 可选 low=Low, high=High)");
    expect(result?.body).toContain("**Permission modes**");
    expect(result?.body).toContain("alwaysAsk");
  });

  it("probes another Agent capabilities via /capabilities <agent> without switching", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/capabilities codex", "oc_x", "th_topic", "om_caps_codex"),
      "ou_user",
      "om_caps_codex",
      "oc_x",
      "th_topic",
    );

    expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: CODEX.command, args: CODEX.args, cwd: repoA }),
    );
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      sessionId: "s_claude",
      agentLabel: "claude",
    });
    const result = presenter.commandResults.at(-1);
    expect(result).toMatchObject({ title: "🧩 Agent capabilities", template: "blue" });
    expect(result?.body).toContain("查询范围：probe: /capabilities codex");
    expect(result?.body).toContain("Agent：codex");
  });

  it("handles /model auto through the shared stored setControls path without spawning a runtime", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s1",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      controls: { modelId: "opus", modeId: "default" },
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/model auto", "oc_x", "th_topic", "om_model_auto"),
      "ou_user",
      "om_model_auto",
      "oc_x",
      "th_topic",
    );

    expect(b.activeChatCount).toBe(0);
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      controls: { modeId: "default" },
    });
    expect(await sessionStore.getLatest("oc_x", "th_topic")).not.toMatchObject({
      controls: { modelId: expect.any(String) },
    });
    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "✅ 会话配置已更新", template: "green" });
    expect(notice?.body).toContain("Model：opus → —");
  });

  it("rejects an invalid stored /model before writing session controls", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s1",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      controls: { modelId: "model-old" },
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/model missing-model", "oc_x", "th_topic", "om_bad_model"),
      "ou_user",
      "om_bad_model",
      "oc_x",
      "th_topic",
    );

    expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: CLAUDE.command, args: CLAUDE.args, cwd: repoA }),
    );
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      controls: { modelId: "model-old" },
    });
    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "⚠️ 会话配置失败", template: "red" });
    expect(notice?.body).toContain("失败项: Model missing-model");
    expect(notice?.body).toContain("会话配置未更新");
  });

  it("uses the same configureSession validation path for humming sessions set-control", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s1",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      controls: { modelId: "model-old" },
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      b.controlConfigureSession(
        "oc_x",
        "th_topic",
        { controls: { modelId: "missing-model" } },
        "om_control_bad_model",
      ),
    ).resolves.toMatchObject({ rejected: true });

    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      controls: { modelId: "model-old" },
    });
    expect(presenter.notices.at(-1)).toMatchObject({ title: "⚠️ 会话配置失败" });
  });

  it("handles /permission through the shared stored setControls notice", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s1",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      controls: { bridgePermissionMode: "alwaysAsk" },
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/permission alwaysAllow", "oc_x", "th_topic", "om_perm"),
      "ou_user",
      "om_perm",
      "oc_x",
      "th_topic",
    );

    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      controls: { bridgePermissionMode: "alwaysAllow" },
    });
    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "✅ 会话配置已更新", template: "green" });
    expect(notice?.body).toContain("Permission：Ask approvals → Auto approve");
  });

  it("shows /profile from stored topic profile", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "profile:1",
      profileOnly: true,
      agentCommand: CODEX.command,
      agentArgs: [...CODEX.args],
      agentLabel: CODEX.label,
      cwd: repoA,
      controls: { modeId: "agent", bridgePermissionMode: "alwaysAllow" },
      pendingConfiguration: { controls: { clearModelId: true }, createdAt: 1, updatedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/profile", "oc_x", "th_topic", "om_profile"),
      "ou_user",
      "om_profile",
      "oc_x",
      "th_topic",
    );

    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "📋 当前会话配置", template: "blue" });
    expect(notice?.body).toContain("Agent：codex");
    expect(notice?.body).toContain(`Repo：${repoA}`);
    expect(notice?.body).toContain("Mode：agent");
    expect(notice?.body).toContain("Permission：Auto approve");
    expect(notice?.body).toContain("待应用配置变更：Model: auto/default");
    expect(notice?.body).toContain("状态：尚未开始");
  });

  it("warns before switching Agent via /agent when the topic already has a session", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/agent codex", "oc_x", "th_topic", "om_agent"),
      "ou_user",
      "om_agent",
      "oc_x",
      "th_topic",
    );

    expect(probeAgentSessionCapabilitiesMock).not.toHaveBeenCalled();
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      sessionId: "s_claude",
      agentLabel: "claude",
    });
    expect(presenter.agentSwitchWarnings).toHaveLength(1);
    expect(presenter.agentSwitchWarnings[0]).toMatchObject({
      chatId: "oc_x",
      threadId: "th_topic",
      fromAgent: "claude",
      toAgent: "codex",
      repo: repoA,
    });
    expect(presenter.agentSwitchWarnings[0]?.body).toContain(
      "这条切换消息不会作为任务发送给新 Agent",
    );
    expect(presenter.notices).toEqual([]);
  });

  it("switches Agent after the user confirms the context-loss warning", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/agent codex", "oc_x", "th_topic", "om_agent_confirm"),
      "ou_user",
      "om_agent_confirm",
      "oc_x",
      "th_topic",
    );
    const switchId = presenter.agentSwitchWarnings[0]?.switchId;
    expect(switchId).toBeDefined();

    b.handleCardAction({
      action: { value: { c: "oc_x", th: "th_topic", sw: switchId, swa: "confirm" } },
      messageId: "om_warning_card",
    } as unknown as Lark.CardActionEvent);

    await vi.waitFor(async () => {
      expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: CODEX.command, args: CODEX.args, cwd: repoA }),
      );
      expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
        profileOnly: true,
        agentLabel: "codex",
        cwd: repoA,
      });
    });
    expect(presenter.agentSwitchResolutions).toContainEqual({
      status: "confirmed",
      text: "已确认切换，正在启动目标 Agent 检查可用性。",
    });
    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "✅ Agent 已切换", template: "green" });
    expect(notice?.body).toContain("Agent：claude → codex");
    expect(notice?.body).toContain("旧 Agent 的内部对话历史不会自动迁移");
  });

  it("keeps the old Agent when confirmed /agent target probe fails", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    probeAgentSessionCapabilitiesMock.mockRejectedValueOnce(new Error("Authentication required"));
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await b.routeMessage(
      textEvent("/agent codex", "oc_x", "th_topic", "om_agent_fail"),
      "ou_user",
      "om_agent_fail",
      "oc_x",
      "th_topic",
    );
    const switchId = presenter.agentSwitchWarnings[0]?.switchId;
    expect(switchId).toBeDefined();

    b.handleCardAction({
      action: { value: { c: "oc_x", th: "th_topic", sw: switchId, swa: "confirm" } },
      messageId: "om_warning_fail_card",
    } as unknown as Lark.CardActionEvent);

    await vi.waitFor(() => expect(probeAgentSessionCapabilitiesMock).toHaveBeenCalled());
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      sessionId: "s_claude",
      agentLabel: "claude",
    });
    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "⚠️ 目标 Agent 不可用", template: "red" });
    expect(notice?.body).toContain("当前 topic 的 Agent 没有切换");
    expect(notice?.body).toContain("Authentication required");
  });
});

describe("session bind conflicts", () => {
  it("switches the current topic Agent by replacing the old session with a profile-only boundary", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({ chatId: "oc_x", cwd: repoA, createdAt: 1, updatedAt: 1 });
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude_old",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      controls: {
        modelId: "opus",
        modeId: "default",
        config: { acceptEdits: { type: "boolean", value: true } },
      },
      createdAt: 1,
      updatedAt: 1,
    });

    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_recent_codex",
      sessionId: "s_codex_recent",
      agentCommand: CODEX.command,
      agentArgs: [...CODEX.args],
      agentLabel: CODEX.label,
      cwd: repoA,
      controls: {
        modelId: "gpt-5",
        modeId: "agent",
        bridgePermissionMode: "alwaysAllow",
        config: { autoEdit: { type: "boolean", value: true } },
      },
      createdAt: 2,
      updatedAt: 2,
    });

    await expect(
      b.controlSetAgent(
        {
          chatId: "oc_x",
          threadId: "th_topic",
          sessionId: "profile:copilot",
          profileOnly: true,
          agentCommand: CODEX.command,
          agentArgs: [...CODEX.args],
          agentLabel: CODEX.label,
          cwd: repoA,
          createdAt: 3,
          updatedAt: 3,
        },
        "om_notice",
      ),
    ).resolves.toMatchObject({ switched: true, agent: "codex" });

    const stored = await sessionStore.getLatest("oc_x", "th_topic");
    expect(stored).toMatchObject({
      sessionId: "profile:copilot",
      profileOnly: true,
      agentLabel: "codex",
      controls: {
        modelId: "gpt-5",
        modeId: "agent",
        bridgePermissionMode: "alwaysAllow",
        config: { autoEdit: { type: "boolean", value: true } },
      },
    });

    const eff = await b.resolveBinding("oc_x");
    const runtime = await b.acquireRuntime("oc_x", "th_topic", eff!);
    const opts = (
      runtime as {
        opts: { agentLabel?: string; agentCommand: string; inheritedControls?: unknown };
      }
    ).opts;
    expect(opts).toMatchObject({ agentLabel: "codex", agentCommand: "npx" });
    expect(opts.inheritedControls).toBeUndefined();

    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "✅ Agent 已切换", template: "green" });
    expect(notice?.body).toContain("旧 Agent 的内部对话历史不会自动迁移");
    expect(notice?.body).toContain("**切换结果**");
    expect(notice?.body).toContain("Agent：claude → codex");
    expect(notice?.body).toContain(`Repo：${repoA}`);
    expect(notice?.body).toContain("Model：gpt-5");
    expect(notice?.body).toContain("Mode：agent");
    expect(notice?.body).toContain("Permission：Auto approve");
    expect(notice?.body).toContain("Config：autoEdit: on");
    expect(notice?.body).toContain("Metadata：已从当前 chat 最近的 codex session 继承");
    expect(notice?.body).not.toContain("**修改明细**");
    expect(notice?.body).not.toContain("**切换后**");
    expect(notice?.body).not.toContain("s_claude_old");
    expect(notice?.body).not.toContain("profile:copilot");
  });

  it("notifies when a target Agent probe fails before switching", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_topic",
      sessionId: "s_claude_old",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      b.controlAgentProbeFailed(
        "oc_x",
        "th_topic",
        {
          label: "copilot",
          command: "npx",
          args: ["-y", "@zed-industries/copilot-acp"],
          cwd: repoA,
        },
        "Authentication required",
        "om_notice",
      ),
    ).resolves.toMatchObject({ notified: true });

    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "⚠️ 目标 Agent 不可用", template: "red" });
    expect(notice?.body).toContain("当前 topic 的 Agent 没有切换");
    expect(notice?.body).toContain("Agent：copilot");
    expect(notice?.body).toContain("Authentication required");
    expect(notice?.body).not.toContain("s_claude_old");
    expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
      sessionId: "s_claude_old",
      agentLabel: "claude",
    });
  });

  it("uses consistent Title/Agent/Repo order in session bind notices", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);

    await expect(
      b.controlBindSession(
        {
          chatId: "oc_x",
          threadId: "th_new",
          sessionId: "s_desktop",
          title: "Desktop task",
          agentCommand: CLAUDE.command,
          agentArgs: [...CLAUDE.args],
          agentLabel: CLAUDE.label,
          cwd: repoA,
          createdAt: 2,
          updatedAt: 2,
        },
        "om_notice",
      ),
    ).resolves.toMatchObject({ bound: true });

    const body = presenter.notices.at(-1)?.body ?? "";
    expect(body).toContain(
      "**修改明细**\n• Title：未绑定 → Desktop task\n• Agent：未绑定 → claude\n• Repo：未绑定 → ",
    );
    expect(body).toContain("• Mode：— → —");
    expect(body).toContain("• Model：— → —");
    expect(body).toContain("• Permission：— → —");
    expect(body).toContain("• Config：— → —");
    expect(body).toContain("**绑定后**\n• Title：Desktop task\n• Agent：claude\n• Repo：");
    expect(body).toContain("• Mode：—\n• Model：—\n• Permission：—\n• Config：—");
    expect(body).not.toContain("Session title");
    expect(body).not.toContain("Title:");
  });

  it("rejects binding a session that is already bound to another thread and notifies", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await sessionStore.save({
      chatId: "oc_x",
      threadId: "th_old",
      sessionId: "s_desktop",
      title: "Desktop task",
      agentCommand: CLAUDE.command,
      agentArgs: [...CLAUDE.args],
      agentLabel: CLAUDE.label,
      cwd: repoA,
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      b.controlBindSession(
        {
          chatId: "oc_x",
          threadId: "th_new",
          sessionId: "s_desktop",
          title: "Desktop task",
          agentCommand: CLAUDE.command,
          agentArgs: [...CLAUDE.args],
          agentLabel: CLAUDE.label,
          cwd: repoA,
          createdAt: 2,
          updatedAt: 2,
        },
        "om_notice",
      ),
    ).rejects.toThrow(/已经绑定|already bound/);

    const notice = presenter.notices.at(-1);
    expect(notice).toMatchObject({ title: "⚠️ Session 已被绑定" });
    expect(notice?.body).toContain("Title：Desktop task");
    expect(notice?.body).not.toContain("已隐藏");
    expect(notice?.body).not.toContain("已绑定 Chat");
    expect(notice?.body).not.toContain("已绑定 Thread");
    expect(notice?.body).not.toContain("Session ID");
    expect(notice?.body).not.toContain("Session title");
    expect(await sessionStore.getLatest("oc_x", "th_new")).toBeNull();
    expect(await sessionStore.getLatest("oc_x", "th_old")).toMatchObject({
      sessionId: "s_desktop",
    });
  });
});
