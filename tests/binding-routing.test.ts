/**
 * Black-box integration test for per-chat repo routing.
 *
 * Proves the core promise — "one Lark bot, each chat bound to its own repo" —
 * without Lark credentials or a real agent: a fake presenter records the
 * notice cards, a spy resolver stands in for the CLI preset registry, and the
 * real FileBindingStore / FileSessionStore persist to a temp dir.
 *
 * The bridge's inbound entry points (handleMessage / routeMessage) are private
 * and driven by the Lark WebSocket. We reach the command + routing layer
 * through a narrow typed view of those private methods — acceptable in a test
 * (CLAUDE.md §4 allows a documented cast here) and still observes results only
 * through public surface (the binding store and activeChatCount).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LarkBridge,
  FileSessionStore,
  FileBindingStore,
  type LarkPresenter,
  type NoticeCardSpec,
  type AgentResolver,
  type ResolvedAgentInvocation,
} from "../src/index.js";
import type { LarkCommand } from "../src/interpreter/lark-interpreter.js";

/** Records every notice card the bridge tries to render. */
class RecordingPresenter implements LarkPresenter {
  readonly notices: NoticeCardSpec[] = [];
  readonly texts: string[] = [];

  async replyText(_messageId: string, text: string): Promise<void> {
    this.texts.push(text);
  }
  async addReaction(): Promise<string | null> {
    return null;
  }
  async removeReaction(): Promise<void> {}
  async sendInterruptCard(): Promise<string | null> {
    return null;
  }
  async updatePermissionCard(): Promise<void> {}
  async expirePermissionCard(): Promise<void> {}
  async replyNoticeCard(_replyToMessageId: string, notice: NoticeCardSpec): Promise<void> {
    this.notices.push(notice);
  }
  async sendUnifiedCard(): Promise<string | null> {
    return null;
  }
  async updateUnifiedCard(): Promise<void> {}
}

/** Minimal view of the private methods this test drives. */
interface BridgeInternals {
  handleCommand(
    command: LarkCommand,
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void>;
  resolveBinding(chatId: string): Promise<{ cwd: string; label: string; explicit: boolean } | null>;
}

function asInternals(bridge: LarkBridge): BridgeInternals {
  // The bridge exposes routing only through WS-driven private methods; a
  // typed view lets the test exercise them directly without a live socket.
  return bridge as unknown as BridgeInternals;
}

/** Spy resolver: `claude` / `codex` presets, anything else echoes as a raw cmd. */
const resolver: AgentResolver = (selection: string): ResolvedAgentInvocation => {
  if (selection === "claude") {
    return { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" };
  }
  if (selection === "codex") {
    return { command: "npx", args: ["-y", "codex-acp"], label: "codex" };
  }
  const [command, ...args] = selection.trim().split(/\s+/);
  if (!command) throw new Error("empty agent selection");
  return { command, args, label: selection };
};

let dataDir: string;
let repoA: string;
let repoB: string;
let presenter: RecordingPresenter;
let bindingStore: FileBindingStore;
let sessionStore: FileSessionStore;
let bridge: LarkBridge;

function makeBridge(defaults?: {
  defaultAgent?: ResolvedAgentInvocation;
  defaultCwd?: string;
}): LarkBridge {
  return new LarkBridge({
    lark: { appId: "cli_test", appSecret: "secret_test" },
    agent: {
      resolver,
      defaultAgent: defaults?.defaultAgent ?? null,
      defaultCwd: defaults?.defaultCwd ?? null,
      permissionMode: "alwaysAllow",
    },
    sessionStore,
    bindingStore,
    presenter,
  });
}

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-e2e-"));
  dataDir = path.join(root, "data");
  repoA = path.join(root, "repo-a");
  repoB = path.join(root, "repo-b");
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  presenter = new RecordingPresenter();
  bindingStore = new FileBindingStore(dataDir);
  sessionStore = new FileSessionStore(dataDir);
  await bindingStore.init();
  await sessionStore.init();
});

afterEach(async () => {
  await bindingStore.close();
  await sessionStore.close();
  fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
});

describe("per-chat repo routing (integration)", () => {
  it("binds two chats to two different repos + agents, isolated", async () => {
    bridge = makeBridge();
    const b = asInternals(bridge);

    await b.handleCommand({ kind: "bind", cwd: repoA, agent: "claude" }, "oc_A", null, "om_1");
    await b.handleCommand({ kind: "bind", cwd: repoB, agent: "codex" }, "oc_B", null, "om_2");

    const bindA = await bindingStore.get("oc_A");
    const bindB = await bindingStore.get("oc_B");
    expect(bindA).toMatchObject({ cwd: repoA, agentLabel: "claude", agentCommand: "npx" });
    expect(bindB).toMatchObject({ cwd: repoB, agentLabel: "codex", agentCommand: "npx" });

    // Resolution returns each chat's own repo — no cross-talk.
    expect(await b.resolveBinding("oc_A")).toMatchObject({ cwd: repoA, explicit: true });
    expect(await b.resolveBinding("oc_B")).toMatchObject({ cwd: repoB, explicit: true });

    // Both bind commands acked with a green "已绑定" card.
    expect(presenter.notices.filter((n) => n.title === "已绑定").length).toBe(2);
  });

  it("persists bindings across a bridge/process restart", async () => {
    bridge = makeBridge();
    await asInternals(bridge).handleCommand(
      { kind: "bind", cwd: repoA, agent: "claude" },
      "oc_A",
      null,
      "om_1",
    );
    await bindingStore.close();

    // Simulate a restart: brand-new stores + bridge over the same dataDir.
    const store2 = new FileBindingStore(dataDir);
    await store2.init();
    const restored = await store2.get("oc_A");
    expect(restored).toMatchObject({ cwd: repoA, agentLabel: "claude" });
    await store2.close();
  });

  it("rejects /bind to a non-existent directory (no binding written)", async () => {
    bridge = makeBridge();
    await asInternals(bridge).handleCommand(
      { kind: "bind", cwd: path.join(repoA, "does-not-exist"), agent: "claude" },
      "oc_A",
      null,
      "om_1",
    );
    expect(await bindingStore.get("oc_A")).toBeNull();
    expect(presenter.notices.some((n) => n.title === "绑定失败")).toBe(true);
  });

  it("unbound chat with no default resolves to null (bridge asks for /bind)", async () => {
    bridge = makeBridge();
    expect(await asInternals(bridge).resolveBinding("oc_new")).toBeNull();
  });

  it("falls back to the configured default when a chat has no explicit bind", async () => {
    bridge = makeBridge({
      defaultAgent: { command: "npx", args: ["-y", "claude-code-acp"], label: "claude" },
      defaultCwd: repoA,
    });
    const resolved = await asInternals(bridge).resolveBinding("oc_unbound");
    expect(resolved).toMatchObject({ cwd: repoA, explicit: false });
  });

  it("/unbind removes the binding", async () => {
    bridge = makeBridge();
    const b = asInternals(bridge);
    await b.handleCommand({ kind: "bind", cwd: repoA, agent: "claude" }, "oc_A", null, "om_1");
    expect(await bindingStore.get("oc_A")).not.toBeNull();

    await b.handleCommand({ kind: "unbind" }, "oc_A", null, "om_2");
    expect(await bindingStore.get("oc_A")).toBeNull();
  });

  it("rebinding a chat overwrites its repo + agent", async () => {
    bridge = makeBridge();
    const b = asInternals(bridge);
    await b.handleCommand({ kind: "bind", cwd: repoA, agent: "claude" }, "oc_A", null, "om_1");
    await b.handleCommand({ kind: "bind", cwd: repoB, agent: "codex" }, "oc_A", null, "om_2");

    expect(await bindingStore.get("oc_A")).toMatchObject({ cwd: repoB, agentLabel: "codex" });
    expect((await bindingStore.list()).length).toBe(1);
  });
});
