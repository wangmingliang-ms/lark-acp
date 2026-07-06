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
  async sendUnifiedCard(): Promise<string | null> {
    return null;
  }
  async updateUnifiedCard(): Promise<void> {}
}

interface ReceptionBinding {
  cwd: string;
  label: string;
  explicit: boolean;
  reception: boolean;
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
const resolver: AgentResolver = (sel) => {
  if (sel === "claude") return CLAUDE;
  if (sel === "codex") return { command: "npx", args: ["-y", "codex-acp"], label: "codex" };
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-recv-"));
  home = path.join(root, "home");
  repoA = path.join(root, "repo-a");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repoA, { recursive: true });
  settingsPath = path.join(home, "settings.json");

  presenter = new RecordingPresenter();
  bindingStore = new SettingsBindingStore(settingsPath, (sel) => {
    const inv = sel ? resolver(sel) : CLAUDE;
    return { agentLabel: inv.label, agentCommand: inv.command, agentArgs: inv.args };
  });
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

  it("prefers a real binding over the reception area", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({
      chatId: "oc_bound",
      cwd: repoA,
      agentLabel: "codex",
      agentCommand: "npx",
      agentArgs: ["-y", "codex-acp"],
      createdAt: 1,
      updatedAt: 1,
    });
    const eff = await b.resolveBinding("oc_bound");
    expect(eff).toMatchObject({ cwd: repoA, label: "codex", explicit: true, reception: false });
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
      "lark-acp operating guide",
    );
    expect(fs.readFileSync(path.join(home, "CLAUDE.md"), "utf-8")).toContain(
      "lark-acp operating guide",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "settings.back.json"), "utf-8")),
    ).toMatchObject({ runtime: { agent: "claude" } });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [
        {
          controls: { bridgePermissionMode: "alwaysAsk" },
        },
      ],
    });
  });
});

describe("hot-reload of bindings", () => {
  it("tears down a chat runtime when its binding appears via settings.json", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await b.snapshotBindings();

    // A reception runtime exists for the unbound chat.
    const recv = await b.resolveBinding("oc_x");
    await b.acquireRuntime("oc_x", null, recv!);
    expect(b.activeChatCount).toBe(1);

    // Simulate the agent binding the chat by editing settings.json directly.
    const settings = { bindings: { oc_x: { cwd: repoA, agent: "codex" } } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    await b.reloadBindings();

    // The stale reception runtime is gone; next message will respawn in repoA.
    expect(b.activeChatCount).toBe(0);
    const eff = await b.resolveBinding("oc_x");
    expect(eff).toMatchObject({ cwd: repoA, label: "codex", explicit: true });
  });

  it("no-ops when the settings file is unchanged", async () => {
    bridge = makeBridge({ unboundCwd: home });
    const b = asInternals(bridge);
    await bindingStore.set({
      chatId: "oc_y",
      cwd: repoA,
      agentLabel: "claude",
      agentCommand: "npx",
      agentArgs: ["-y", "claude-code-acp"],
      createdAt: 1,
      updatedAt: 1,
    });
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
    await bindingStore.set({
      chatId: "oc_z",
      cwd: repoA,
      agentLabel: "claude",
      agentCommand: "npx",
      agentArgs: ["-y", "claude-code-acp"],
      createdAt: 1,
      updatedAt: 1,
    });
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
