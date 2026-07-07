/**
 * Reception-area + hot-reload behaviour (task 2, natural-language binding).
 *
 * Same black-box approach as binding-routing.test.ts: a recording presenter, a
 * spy resolver, real temp-dir stores, and a narrow typed view of the private
 * routing methods. No Lark credentials, no real agent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LarkBridge,
  FileSessionStore,
  SettingsBindingStore,
  type LarkPresenter,
  type NoticeCardSpec,
  type SessionRecord,
  type AgentResolver,
  type ResolvedAgentInvocation,
} from "../src/index.js";

class RecordingPresenter implements LarkPresenter {
  readonly notices: NoticeCardSpec[] = [];
  async replyText(): Promise<void> {}
  async sendInterruptCard(): Promise<string | null> {
    return null;
  }
  async updatePermissionCard(): Promise<void> {}
  async expirePermissionCard(): Promise<void> {}
  async replyNoticeCard(_id: string, notice: NoticeCardSpec): Promise<void> {
    this.notices.push(notice);
  }
  async sendNoticeCard(_chatId: string, notice: NoticeCardSpec): Promise<string | null> {
    this.notices.push(notice);
    return "notice_msg";
  }
  async sendUnifiedCard(): Promise<string | null> {
    return null;
  }
  async updateUnifiedCard(): Promise<boolean> {
    return true;
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
  controlBindSession(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
  controlSetAgent(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
  controlAgentProbeFailed(
    chatId: string,
    threadId: string | null,
    agent: { label?: string; command: string; args: readonly string[]; cwd: string },
    error: string,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
  readonly activeChatCount: number;
}
function asInternals(bridge: LarkBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals;
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
    agent: { resolver, defaultAgent: CLAUDE, defaultCwd: null, permissionMode: "alwaysAllow" },
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
    expect(notice?.body).toContain("Controls：autoEdit: on");
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
    expect(body).toContain("• Controls：— → —");
    expect(body).toContain("**绑定后**\n• Title：Desktop task\n• Agent：claude\n• Repo：");
    expect(body).toContain("• Mode：—\n• Model：—\n• Permission：—\n• Controls：—");
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
