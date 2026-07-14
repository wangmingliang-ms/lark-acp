import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram } from "./cli/program.js";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-agent-"));
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

function captureStdout(): { logs: string[]; restore(): void } {
  const logs: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    logs,
    restore() {
      process.stdout.write = original;
    },
  };
}

describe("agent list", () => {
  it("prints the built-in presets", async () => {
    const capture = captureStdout();
    try {
      await parse(["agent", "list", "--home", dir]);
    } finally {
      capture.restore();
    }
    const output = capture.logs.join("");
    expect(output).toContain("copilot");
    expect(output).toContain("claude");
  });

  it("supports --json", async () => {
    const capture = captureStdout();
    try {
      await parse(["agent", "list", "--home", dir, "--json"]);
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.logs.join("")) as Array<{ id: string; source: string }>;
    expect(parsed.find((entry) => entry.id === "claude")).toMatchObject({ source: "built-in" });
  });

  it("does not require --agent", async () => {
    await expect(parse(["agent", "list", "--home", dir])).resolves.toBeDefined();
  });
});

describe("agent capabilities/models/modes/permissions — Commander parsing", () => {
  for (const sub of ["capabilities", "models", "modes", "permissions"]) {
    it(`\`agent ${sub}\` requires --agent`, async () => {
      await expect(parse(["agent", sub, "--home", dir])).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    });

    it(`\`agent ${sub}\` rejects an unknown option`, async () => {
      await expect(
        parse(["agent", sub, "--home", dir, "--agent", "claude", "--bogus"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
    });

    it(`\`agent ${sub}\` fails fast for a nonexistent raw command (not a registry preset)`, async () => {
      await expect(
        parse([
          "agent",
          sub,
          "--home",
          dir,
          "--cwd",
          dir,
          "--agent",
          "humming-definitely-does-not-exist-xyz",
        ]),
      ).rejects.toThrow();
    });
  }
});

describe("agent capabilities does not accept a positional agent value", () => {
  it("rejects a positional value", async () => {
    await expect(
      parse(["agent", "capabilities", "--home", dir, "--agent", "claude", "claude"]),
    ).rejects.toMatchObject({
      code: "commander.excessArguments",
    });
  });
});
