import { describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  SlashCommandController,
  renderCommandHelpBody,
  slashCommandController,
  type SlashCommandContext,
} from "./commands.js";

function recordingContext(): {
  readonly context: SlashCommandContext;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const record = (value: string): Promise<void> => {
    calls.push(value);
    return Promise.resolve();
  };
  return {
    calls,
    context: {
      cancel: () => record("cancel"),
      newSession: () => record("new"),
      restart: () => record("restart"),
      help: () => record("help"),
      capabilities: (agent) => record(`capabilities:${agent ?? ""}`),
      bind: (cwd, agent) => record(`bind:${cwd}:${agent ?? ""}`),
      bindUsage: () => record("bind-usage"),
      unbind: () => record("unbind"),
      where: () => record("where"),
      setAgent: (agent) => record(`set-agent:${agent}`),
      listAgents: () => record("list-agents"),
      setModel: (model) => record(`set-model:${model}`),
      listModels: () => record("list-models"),
      setMode: (mode) => record(`set-mode:${mode}`),
      listModes: () => record("list-modes"),
      setPermission: (permission) => record(`set-permission:${permission}`),
      listPermissions: () => record("list-permissions"),
      profile: () => record("profile"),
    },
  };
}

describe("SlashCommandController", () => {
  it("lists every registered slash token in help", () => {
    const help = renderCommandHelpBody();
    const slashTokens = SLASH_COMMANDS.flatMap((command) => command.tokens).filter((token) =>
      token.startsWith("/"),
    );

    for (const token of slashTokens) expect(help).toContain(token);
  });

  it("resolves and dispatches every semantic command through its registered handler", async () => {
    const cases = [
      ["/help", "help"],
      ["/capabilities", "capabilities:"],
      ["/capabilities codex", "capabilities:codex"],
      ["/agent", "list-agents"],
      ["/agent copilot", "set-agent:copilot"],
      ["/model", "list-models"],
      ["/model auto", "set-model:auto"],
      ["/mode", "list-modes"],
      ["/mode plan", "set-mode:plan"],
      ["/permission", "list-permissions"],
      ["/permission alwaysAllow", "set-permission:alwaysAllow"],
      ["/profile", "profile"],
      ["/bind", "bind-usage"],
      ["/bind /repo claude", "bind:/repo:claude"],
      ["/where", "where"],
      ["/unbind", "unbind"],
      ["/new", "new"],
      ["/restart", "restart"],
      ["/cancel", "cancel"],
    ] as const;

    for (const [input, expected] of cases) {
      const invocation = slashCommandController.resolve(input);
      expect(invocation, input).not.toBeNull();
      const { context, calls } = recordingContext();
      if (invocation !== null) await slashCommandController.dispatch(invocation, context);
      expect(calls, input).toEqual([expected]);
    }
  });

  it("routes aliases to the same semantic command handler", async () => {
    for (const input of ["/stop", "取消", "停止"]) {
      const invocation = slashCommandController.resolve(input);
      const { context, calls } = recordingContext();
      if (invocation !== null) await slashCommandController.dispatch(invocation, context);
      expect(calls, input).toEqual(["cancel"]);
    }
    for (const input of ["/pwd", "/binding"]) {
      const invocation = slashCommandController.resolve(input);
      const { context, calls } = recordingContext();
      if (invocation !== null) await slashCommandController.dispatch(invocation, context);
      expect(calls, input).toEqual(["where"]);
    }
  });

  it("documents reset and restart as distinct operations", () => {
    const help = renderCommandHelpBody();

    expect(help).toContain("• /new — 清空当前 topic session");
    expect(help).toContain("• /restart — 取消当前任务，重启当前 topic Agent 并恢复同一 session");
  });

  it("rejects duplicate command tokens during registration", () => {
    const duplicate = {
      ...SLASH_COMMANDS[0],
      name: "duplicate-help",
    };

    expect(() => new SlashCommandController([...SLASH_COMMANDS, duplicate])).toThrow(
      "slash command token /help is registered by both help and duplicate-help",
    );
  });

  it("does not invoke handlers for unmatched human input", () => {
    const handle = vi.spyOn(SLASH_COMMANDS[0], "handle");

    expect(slashCommandController.resolve("please help")).toBeNull();
    expect(handle).not.toHaveBeenCalled();
    handle.mockRestore();
  });
});
