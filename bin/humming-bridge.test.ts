import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommanderError } from "commander";
import { buildProgram } from "./cli/program.js";
import { buildBridgeRunArgv, hasExplicitBridgeRunOptions } from "./cli/commands/bridge.js";

const HUMMING_ENV_KEYS = [
  "HUMMING_CHAT_ID",
  "HUMMING_THREAD_ID",
  "HUMMING_HOME",
  "HUMMING_APP_ID",
  "HUMMING_APP_SECRET",
  "HUMMING_PERMISSION_MODE",
];
let savedEnv: Record<string, string | undefined>;

let dir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(HUMMING_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of HUMMING_ENV_KEYS) delete process.env[key];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-bridge-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of HUMMING_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function newProgram() {
  return buildProgram({ version: "test", selfPath: path.join(dir, "self.js") });
}

async function parse(argv: readonly string[]) {
  const program = newProgram();
  await program.parseAsync(["node", "humming", ...argv]);
  return program;
}

describe("bridge command tree — Commander parsing", () => {
  it("rejects an unknown top-level command", async () => {
    await expect(parse(["proxy"])).rejects.toBeInstanceOf(CommanderError);
  });

  it("rejects an unknown option on `bridge run`", async () => {
    await expect(parse(["bridge", "run", "--home", dir, "--bogus"])).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("rejects a positional agent value without an explicit `--`", async () => {
    // A stray positional before `--` is intentionally rejected: the spec's
    // only positional pass-through is an explicit external Agent command
    // after `--`.
    await expect(parse(["bridge", "run", "--home", dir, "copilot"])).rejects.toThrowError(
      /may only be passed after `--`/,
    );
  });

  it("`bridge run` fails fast with a friendly error when credentials are missing", async () => {
    await expect(parse(["bridge", "run", "--home", dir])).rejects.toThrowError(
      /credentials missing/,
    );
  });

  it("captures an explicit external agent command after `--`", async () => {
    // We can't let the real action run (it would try to connect to Lark), so
    // assert indirectly via the missing-credentials failure still surfacing —
    // proving argument parsing accepted the trailing passthrough before the
    // action ran.
    await expect(
      parse(["bridge", "run", "--home", dir, "--", "node", "./agent.js", "--acp"]),
    ).rejects.toThrowError(/credentials missing/);
  });

  it("`bridge status` reports not running for a fresh home", async () => {
    const logs: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await parse(["bridge", "status", "--home", dir]);
    } finally {
      process.stdout.write = original;
    }
    expect(logs.join("")).toContain("not running");
  });

  it("`bridge stop` errors when the bridge is not running", async () => {
    await expect(parse(["bridge", "stop", "--home", dir])).rejects.toThrowError(
      /bridge is not running/,
    );
  });

  it("`bridge restart` rejects explicit run options as unsupported", async () => {
    await expect(
      parse(["bridge", "restart", "--home", dir, "--agent", "codex"]),
    ).rejects.toThrowError(/not supported by coordinated restart/);
  });

  it("`bridge restart` accepts --home as target selection, not a launch option", async () => {
    await expect(parse(["bridge", "restart", "--home", dir])).rejects.toThrowError(
      /bridge is not running/,
    );
  });

  it("only `bridge run` accepts a raw Agent command after --", async () => {
    await expect(
      parse(["bridge", "start", "--home", dir, "--", "node", "./agent.js"]),
    ).rejects.toBeInstanceOf(CommanderError);
    await expect(
      parse(["bridge", "restart", "--home", dir, "--", "node", "./agent.js"]),
    ).rejects.toBeInstanceOf(CommanderError);
  });

  it("`bridge logs` requires a log file to exist", async () => {
    await expect(parse(["bridge", "logs", "--home", dir])).rejects.toThrowError(/no log file/);
  });

  it("top-level shortcuts share the Bridge command behavior", async () => {
    const logs: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await parse(["status", "--home", dir]);
    } finally {
      process.stdout.write = original;
    }
    expect(logs.join("")).toContain("not running");
    await expect(parse(["stop", "--home", dir])).rejects.toThrowError(/bridge is not running/);
    await expect(parse(["restart", "--home", dir])).rejects.toThrowError(/bridge is not running/);
    await expect(parse(["run", "--home", dir])).rejects.toThrowError(/credentials missing/);
    await expect(parse(["logs", "--home", dir])).rejects.toThrowError(/no log file/);
  });

  it("top-level run preserves the explicit raw-command contract", async () => {
    await expect(parse(["run", "--home", dir, "--", "node", "./agent.js"])).rejects.toThrowError(
      /credentials missing/,
    );
    await expect(parse(["run", "--home", dir, "node", "./agent.js"])).rejects.toThrowError(
      /may only be passed after `--`/,
    );
  });
});

describe("buildBridgeRunArgv — start/restart argv rewriting", () => {
  it("rewrites a bare `start` into a bare `bridge run`", () => {
    expect(buildBridgeRunArgv({}, {}, [])).toEqual(["bridge", "run"]);
  });

  it("forwards every typed option verbatim", () => {
    const argv = buildBridgeRunArgv(
      { home: "/x", settingsPath: "/x/settings.json", dataDir: "/x/data" },
      {
        agent: "codex",
        cwd: "/repo",
        unboundCwd: "/reception",
        idleTimeout: 30,
        maxChats: 5,
        hideThoughts: true,
        hideTools: true,
        hideCancelButton: true,
        permission: "alwaysAllow",
        requireMention: true,
      },
      [],
    );
    expect(argv).toEqual([
      "bridge",
      "run",
      "--home",
      "/x",
      "--settings-path",
      "/x/settings.json",
      "--data-dir",
      "/x/data",
      "--agent",
      "codex",
      "--cwd",
      "/repo",
      "--unbound-cwd",
      "/reception",
      "--idle-timeout",
      "30",
      "--max-chats",
      "5",
      "--hide-thoughts",
      "--hide-tools",
      "--hide-cancel-button",
      "--permission",
      "alwaysAllow",
      "--require-mention",
    ]);
  });

  it("appends a trailing raw agent command after `--`", () => {
    const argv = buildBridgeRunArgv({}, { agent: "copilot" }, ["node", "./agent.js", "--acp"]);
    expect(argv).toEqual([
      "bridge",
      "run",
      "--agent",
      "copilot",
      "--",
      "node",
      "./agent.js",
      "--acp",
    ]);
  });

  it("--no-require-mention forwards as an explicit negation", () => {
    const argv = buildBridgeRunArgv({}, { requireMention: false }, []);
    expect(argv).toEqual(["bridge", "run", "--no-require-mention"]);
  });
});

describe("hasExplicitBridgeRunOptions", () => {
  it("is false for a bare restart (falls back to the persisted launch argv)", () => {
    expect(hasExplicitBridgeRunOptions({}, [])).toBe(false);
  });

  it("is true when any run-affecting option was typed", () => {
    expect(hasExplicitBridgeRunOptions({ agent: "codex" }, [])).toBe(true);
  });

  it("is true when a raw agent command was typed", () => {
    expect(hasExplicitBridgeRunOptions({}, ["node", "./agent.js"])).toBe(true);
  });
});

describe("`bridge start` rebuilds and persists the `bridge run` launch argv", () => {
  it("persists a spawnArgv rewritten from `start` flags", async () => {
    // `start` always fails once it gets to spawning (there's nothing runnable
    // at the fake selfPath), but persistLaunchArgv runs first — so the
    // persisted descriptor is still observable and asserts the rewrite.
    await parse(["bridge", "start", "--home", dir, "--agent", "codex", "--cwd", dir]).catch(
      () => {},
    );
    const launchPath = path.join(dir, "bridge.launch.json");
    expect(fs.existsSync(launchPath)).toBe(true);
    const launch = JSON.parse(fs.readFileSync(launchPath, "utf-8")) as { spawnArgv: string[] };
    expect(launch.spawnArgv).toEqual([
      "bridge",
      "run",
      "--home",
      dir,
      "--agent",
      "codex",
      "--cwd",
      dir,
    ]);
  });

  it("the top-level start shortcut persists the same canonical launch argv", async () => {
    await parse(["start", "--home", dir, "--agent", "codex", "--cwd", dir]).catch(() => {});
    const launch = JSON.parse(fs.readFileSync(path.join(dir, "bridge.launch.json"), "utf-8")) as {
      spawnArgv: string[];
    };
    expect(launch.spawnArgv).toEqual([
      "bridge",
      "run",
      "--home",
      dir,
      "--agent",
      "codex",
      "--cwd",
      dir,
    ]);
  });
});
