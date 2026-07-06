/**
 * CLI-layer unit tests for the default-agent resolution that makes a bare
 * `lark-acp start` / `lark-acp proxy` work on a fresh machine.
 *
 * Regression guard for the bug where `start` (no `--agent`) spawned a
 * background `proxy` that immediately died with "proxy requires either
 * --agent <preset> or a command after `--`", because:
 *   1. the parser hard-threw on a bare `proxy` (no agent), and
 *   2. there was nowhere to persist a default agent.
 *
 * Both are covered here: the parser now accepts a bare `proxy`, and
 * resolveDefaultAgent walks --agent > settings.json runtime.agent > built-in
 * `claude`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  resolveDefaultAgent,
  readConfigFile,
  migrateLegacyIfNeeded,
  resolveHomeDir,
  parseControlJson,
  runInit,
  DEFAULT_AGENT,
  type ParsedArgs,
} from "./lark-acp.js";
import { buildRegistry } from "./agents.js";

const registry = buildRegistry();

const silentLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): typeof silentLogger {
    return silentLogger;
  },
};

describe("parseArgs — bare subcommands need no --agent", () => {
  it("accepts a bare `proxy` (agent resolved later, not at parse time)", () => {
    const args = parseArgs(["proxy"]);
    expect(args.command).toBe("proxy");
    expect(args.agentPreset).toBeUndefined();
    expect(args.agentRawCommand).toBeUndefined();
  });

  it("accepts a bare `start` and records argv for backgrounding", () => {
    const args = parseArgs(["start"]);
    expect(args.command).toBe("start");
    expect(args.agentPreset).toBeUndefined();
    // start captures the raw argv + the index of its own subcommand token so
    // the handler can rewrite `start` -> `proxy` verbatim.
    expect(args.rawArgv).toEqual(["start"]);
    expect(args.subcommandIndex).toBe(0);
  });

  it("accepts explicit init without spawning the bridge", () => {
    const args = parseArgs(["--home", "/tmp/lark-acp-home", "init"]);
    expect(args.command).toBe("init");
    expect(args.home).toBe("/tmp/lark-acp-home");
  });

  it("still parses an explicit --agent preset", () => {
    const args = parseArgs(["proxy", "--agent", "codex"]);
    expect(args.agentPreset).toBe("codex");
  });

  it("still parses a raw `-- <cmd>` passthrough", () => {
    const args = parseArgs(["proxy", "--", "node", "./my-acp.js", "--flag"]);
    expect(args.agentRawCommand).toBe("node");
    expect(args.agentExtraArgs).toEqual(["./my-acp.js", "--flag"]);
  });
});

describe("parseArgs — control and session-control subcommands", () => {
  it("parses live capabilities target flags", () => {
    const args = parseArgs([
      "control",
      "capabilities",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--json",
    ]);
    expect(args.command).toBe("control");
    expect(args.controlAction).toBe("capabilities");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
  });

  it("parses set-control JSON payloads", () => {
    const json = '{"modeId":"agent"}';
    const args = parseArgs([
      "sessions",
      "set-control",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "<main>",
      "--json",
      json,
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("set-control");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBeNull();
    expect(args.controlJson).toBe(json);
  });

  it("parses session list with optional cwd and agent", () => {
    const args = parseArgs([
      "sessions",
      "list",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "claude",
      "--cwd",
      "/repo",
      "--json",
    ]);
    expect(args.command).toBe("sessions");
    expect(args.sessionsAction).toBe("list");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("claude");
    expect(args.targetCwd).toBe("/repo");
    expect(args.controlJson).toBe(true);
  });

  it("parses session bind and rejects cwd", () => {
    const args = parseArgs([
      "sessions",
      "bind",
      "--chat-id",
      "oc_A",
      "--thread-id",
      "th_1",
      "--agent",
      "codex",
      "--session-id",
      "sess_1",
    ]);
    expect(args.sessionsAction).toBe("bind");
    expect(args.targetChatId).toBe("oc_A");
    expect(args.targetThreadId).toBe("th_1");
    expect(args.targetAgent).toBe("codex");
    expect(args.targetSessionId).toBe("sess_1");

    expect(() =>
      parseArgs([
        "sessions",
        "bind",
        "--chat-id",
        "oc_A",
        "--session-id",
        "sess_1",
        "--cwd",
        "/repo",
      ]),
    ).toThrowError(/does not accept --cwd/);
  });
});

describe("parseControlJson", () => {
  it("accepts ACP-shaped controls and normalizes select config values", () => {
    expect(
      parseControlJson(
        JSON.stringify({
          modelId: "model-new",
          modeId: "agent",
          bridgePermissionMode: "alwaysAsk",
          config: {
            auto_edit: { type: "boolean", value: true },
            approval_mode: { type: "select", value: "auto" },
          },
        }),
      ),
    ).toEqual({
      modelId: "model-new",
      modeId: "agent",
      bridgePermissionMode: "alwaysAsk",
      config: {
        auto_edit: { type: "boolean", value: true },
        approval_mode: { value: "auto" },
      },
    });
  });

  it("rejects invalid permission modes", () => {
    expect(() => parseControlJson('{"bridgePermissionMode":"bypass"}')).toThrowError(
      /bridgePermissionMode/,
    );
  });
});

describe("runInit", () => {
  let dir: string;
  let stdoutSpy: ReturnType<typeof viSpyWrite>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-init-"));
    stdoutSpy = viSpyWrite();
  });

  afterEach(() => {
    stdoutSpy.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("seeds templates/examples but does not create live settings or sessions", async () => {
    const home = path.join(dir, "home");
    await runInit(parseArgs(["--home", home, "init"]));

    expect(fs.existsSync(path.join(home, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, "CLAUDE.md"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "settings.back.json"), "utf-8")),
    ).toMatchObject({
      runtime: { agent: "claude" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [{ controls: { bridgePermissionMode: "alwaysAsk" } }],
    });
    expect(fs.existsSync(path.join(home, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "sessions.json"))).toBe(false);
    expect(stdoutSpy.output()).toContain("initialized lark-acp home templates");
  });
});

function viSpyWrite(): { output(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

/** Build a ParsedArgs the way parseArgs would, for the CLI-precedence cases. */
function argsFor(argv: readonly string[]): ParsedArgs {
  return parseArgs(argv);
}

describe("resolveDefaultAgent — precedence chain", () => {
  it("falls back to the built-in claude when nothing is specified", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, undefined);
    expect(inv.label).toBe(DEFAULT_AGENT);
    expect(inv.command).toBe("npx");
    expect(inv.args).toContain("@zed-industries/claude-code-acp");
  });

  it("uses settings.json runtime.agent (preset id) when the CLI names none", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, "codex");
    expect(inv.label).toBe("codex");
    expect(inv.args).toContain("@zed-industries/codex-acp");
  });

  it("resolves a runtime.agent raw command string", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy"]), registry, "node ./srv.js --acp");
    expect(inv.command).toBe("node");
    expect(inv.args).toEqual(["./srv.js", "--acp"]);
  });

  it("CLI --agent overrides settings.json runtime.agent", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy", "--agent", "copilot"]), registry, "codex");
    expect(inv.label).toBe("copilot");
  });

  it("CLI raw command overrides settings.json runtime.agent", () => {
    const inv = resolveDefaultAgent(argsFor(["proxy", "--", "node", "x.js"]), registry, "codex");
    expect(inv.command).toBe("node");
    expect(inv.args).toEqual(["x.js"]);
  });

  it("appends --agent extra args to the preset", () => {
    const inv = resolveDefaultAgent(
      argsFor(["proxy", "--agent", "claude", "--", "--verbose"]),
      registry,
      undefined,
    );
    expect(inv.args[inv.args.length - 1]).toBe("--verbose");
  });

  it("throws a friendly error when --agent names an unknown preset", () => {
    expect(() =>
      resolveDefaultAgent(argsFor(["proxy", "--agent", "nope"]), registry, undefined),
    ).toThrowError(/unknown agent preset: nope/);
  });
});

describe("readConfigFile — runtime.agent round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads runtime.agent from settings.json", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: "codex" } }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.agent).toBe("codex");
  });

  it("leaves runtime.agent undefined when absent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: {} }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.agent).toBeUndefined();
  });

  it("rejects a non-string runtime.agent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: 42 } }));
    expect(() => readConfigFile(p)).toThrowError(/runtime\.agent must be a string/);
  });

  it("reads lifecycle notification chat ids from settings.json", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", "oc_B"] } }));
    const cfg = readConfigFile(p);
    expect(cfg.runtime.lifecycleNotifyChatIds).toEqual(["oc_A", "oc_B"]);
  });

  it("rejects non-string lifecycle notification chat ids", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", 42] } }));
    expect(() => readConfigFile(p)).toThrowError(
      /runtime\.lifecycleNotifyChatIds\[1\] must be a string/,
    );
  });
});

describe("legacy migration isolation", () => {
  let dir: string;
  const oldXdgConfig = process.env["XDG_CONFIG_HOME"];
  const oldXdgData = process.env["XDG_DATA_HOME"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-migrate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv("XDG_CONFIG_HOME", oldXdgConfig);
    restoreEnv("XDG_DATA_HOME", oldXdgData);
  });

  it("does not import legacy XDG config into an explicit --home", () => {
    const xdgConfig = path.join(dir, "xdg-config");
    const legacyDir = path.join(xdgConfig, "lark-acp");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ credentials: { appId: "cli_legacy", appSecret: "secret" } }),
    );
    process.env["XDG_CONFIG_HOME"] = xdgConfig;
    process.env["XDG_DATA_HOME"] = path.join(dir, "xdg-data");

    const explicitHome = path.join(dir, "explicit-home");
    const settings = path.join(explicitHome, "settings.json");
    migrateLegacyIfNeeded(explicitHome, settings, silentLogger);

    expect(fs.existsSync(settings)).toBe(false);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
