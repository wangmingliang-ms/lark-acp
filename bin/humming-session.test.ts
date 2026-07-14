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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-session-"));
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

describe("session list", () => {
  it("requires a resolvable cwd (no binding, no --cwd)", async () => {
    await expect(
      parse(["session", "list", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/no cwd available/);
  });

  it("rejects an unknown option", async () => {
    await expect(
      parse(["session", "list", "--home", dir, "--cwd", dir, "--bogus"]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
  });
});

describe("session bind", () => {
  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(
      parse(["session", "bind", "--home", dir, "--session-id", "s1"]),
    ).rejects.toThrowError(/requires --chat-id/);
  });

  it("requires --session-id", async () => {
    await expect(
      parse(["session", "bind", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });

  it("does not accept --cwd (only binds within the current chat repo)", async () => {
    await expect(
      parse([
        "session",
        "bind",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--session-id",
        "s1",
        "--cwd",
        dir,
      ]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
  });
});

describe("session capabilities/models/modes/permissions", () => {
  for (const sub of ["capabilities", "models", "modes", "permissions"]) {
    it(`\`session ${sub}\` does not accept --agent`, async () => {
      await expect(
        parse(["session", sub, "--home", dir, "--chat-id", "oc_x", "--agent", "claude"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
    });

    it(`\`session ${sub}\` requires chat scope`, async () => {
      await expect(parse(["session", sub, "--home", dir])).rejects.toThrowError(
        /requires --chat-id/,
      );
    });

    it(`\`session ${sub}\` fails when the bridge is unreachable`, async () => {
      await expect(
        parse(["session", sub, "--home", dir, "--chat-id", "oc_x"]),
      ).rejects.toThrowError(/could not reach the bridge control socket/);
    });
  }
});

describe("session configure", () => {
  it("requires at least one profile field", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/at least one profile field/);
  });

  it("rejects a message with no profile field, pointing at `session send`", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--message", "hello"]),
    ).rejects.toThrowError(/session send/);
  });

  it("rejects conflicting message sources", async () => {
    await expect(
      parse([
        "session",
        "configure",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--mode",
        "agent",
        "--message",
        "hi",
        "--message-stdin",
      ]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("fails when the bridge is unreachable, once a profile field is present", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--mode", "agent"]),
    ).rejects.toThrowError(/could not reach the bridge control socket/);
  });

  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--mode", "agent"]),
    ).rejects.toThrowError(/requires --chat-id/);
  });

  it("--model auto is accepted as the explicit clear sentinel", async () => {
    await expect(
      parse(["session", "configure", "--home", dir, "--chat-id", "oc_x", "--model", "auto"]),
    ).rejects.toThrowError(/could not reach the bridge control socket/);
  });

  it("rejects a malformed --config assignment", async () => {
    await expect(
      parse([
        "session",
        "configure",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--config",
        "no-equals-sign",
      ]),
    ).rejects.toThrowError(/--config requires/);
  });
});

describe("session send", () => {
  it("requires exactly one message source", async () => {
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x"]),
    ).rejects.toThrowError(/exactly one message source/);
  });

  it("rejects conflicting message sources", async () => {
    await expect(
      parse([
        "session",
        "send",
        "--home",
        dir,
        "--chat-id",
        "oc_x",
        "--message",
        "hi",
        "--message-file",
        "x",
      ]),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("requires --chat-id (or $HUMMING_CHAT_ID)", async () => {
    await expect(parse(["session", "send", "--home", dir, "--message", "hi"])).rejects.toThrowError(
      /requires --chat-id/,
    );
  });

  it("fails when the bridge is unreachable", async () => {
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x", "--message", "hi"]),
    ).rejects.toThrowError(/could not reach the bridge control socket/);
  });

  it("rejects an empty --message-file", async () => {
    const file = path.join(dir, "empty.md");
    fs.writeFileSync(file, "   \n");
    await expect(
      parse(["session", "send", "--home", dir, "--chat-id", "oc_x", "--message-file", file]),
    ).rejects.toThrowError(/must not be empty/);
  });
});
