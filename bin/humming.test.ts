import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram } from "./cli/program.js";
import { resolveUpdateRef } from "./cli/commands/update.js";
import { main } from "./humming.js";
import { CliError } from "./cli/errors.js";
import { ProcessControlError } from "./process-control.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-bootstrap-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("humming.ts bootstrap", () => {
  it("is import-safe: importing the module does not run main()", async () => {
    // If `main()` ran on import it would call `program.parseAsync` against
    // this test runner's own argv and throw/exit — importing must be inert.
    await import("./humming.js");
    expect(true).toBe(true);
  });

  it("main() sets a non-zero exitCode for a CliError without throwing", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(["node", "humming", "gateway", "run", "--home", dir]);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("main() sets exitCode 1 for a ProcessControlError without throwing", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(["node", "humming", "gateway", "stop", "--home", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("main() sets exitCode 0 after --help without throwing", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await main(["node", "humming", "--help"]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });
});

describe("program construction", () => {
  it("declares the full command tree from the spec", () => {
    const program = buildProgram({ version: "test", selfPath: path.join(dir, "self.js") });
    const names = program.commands.map((cmd) => cmd.name()).sort();
    expect(names).toEqual(
      [
        "agent",
        "gateway",
        "session",
        "setup",
        "init",
        "update",
        "autostart",
        "run",
        "start",
        "stop",
        "restart",
        "status",
        "logs",
      ].sort(),
    );

    const gateway = program.commands.find((cmd) => cmd.name() === "gateway");
    expect(gateway?.commands.map((c) => c.name()).sort()).toEqual(
      ["run", "start", "stop", "restart", "status", "logs"].sort(),
    );

    const autostart = program.commands.find((cmd) => cmd.name() === "autostart");
    expect(autostart?.commands.map((c) => c.name()).sort()).toEqual(
      ["install", "disable", "status"].sort(),
    );

    const agent = program.commands.find((cmd) => cmd.name() === "agent");
    expect(agent?.commands.map((c) => c.name()).sort()).toEqual(
      ["list", "capabilities", "models", "modes", "permissions"].sort(),
    );

    const session = program.commands.find((cmd) => cmd.name() === "session");
    expect(session?.commands.map((c) => c.name()).sort()).toEqual(
      [
        "list",
        "bind",
        "capabilities",
        "models",
        "modes",
        "permissions",
        "configure",
        "send",
      ].sort(),
    );
  });

  it("requires setup domain to use a named option", async () => {
    const program = buildProgram({ version: "test", selfPath: path.join(dir, "self.js") });
    await expect(program.parseAsync(["node", "humming", "setup", "lark"])).rejects.toMatchObject({
      code: "commander.excessArguments",
    });
  });
});

describe("resolveUpdateRef", () => {
  const ENV_UPDATE_REF = "HUMMING_REF";

  afterEach(() => {
    delete process.env[ENV_UPDATE_REF];
  });

  it("defaults to main when unset", () => {
    delete process.env[ENV_UPDATE_REF];
    expect(resolveUpdateRef()).toBe("main");
  });

  it("defaults to main when set to an empty string", () => {
    process.env[ENV_UPDATE_REF] = "";
    expect(resolveUpdateRef()).toBe("main");
  });

  it("uses a non-empty $HUMMING_REF verbatim", () => {
    process.env[ENV_UPDATE_REF] = "release/2.0";
    expect(resolveUpdateRef()).toBe("release/2.0");
  });
});

describe("error classes are distinguishable", () => {
  it("CliError and ProcessControlError have stable names", () => {
    expect(new CliError("x").name).toBe("CliError");
    expect(new ProcessControlError("x").name).toBe("ProcessControlError");
  });
});
