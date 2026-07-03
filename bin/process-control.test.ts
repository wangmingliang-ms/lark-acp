import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bridgeLogPath,
  bridgePidPath,
  isAlive,
  readPid,
  rewriteSubcommand,
  ProcessControlError,
} from "./process-control.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-pc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("compose PID and log paths under the home dir", () => {
    expect(bridgePidPath(dir)).toBe(path.join(dir, "bridge.pid"));
    expect(bridgeLogPath(dir)).toBe(path.join(dir, "bridge.log"));
  });
});

describe("readPid", () => {
  it("returns null when the PID file is absent", () => {
    expect(readPid(path.join(dir, "nope.pid"))).toBeNull();
  });

  it("returns null for an empty or whitespace-only file", () => {
    const p = path.join(dir, "empty.pid");
    fs.writeFileSync(p, "   \n");
    expect(readPid(p)).toBeNull();
  });

  it("returns null for non-integer / non-positive garbage", () => {
    const p = path.join(dir, "garbage.pid");
    for (const bad of ["abc", "0", "-5", "3.14"]) {
      fs.writeFileSync(p, bad);
      expect(readPid(p)).toBeNull();
    }
  });

  it("parses a valid PID, tolerating a trailing newline", () => {
    const p = path.join(dir, "ok.pid");
    fs.writeFileSync(p, "12345\n");
    expect(readPid(p)).toBe(12345);
  });
});

describe("isAlive", () => {
  it("reports the current process as alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("rejects invalid PIDs without throwing", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });

  it("reports a very-high, almost-certainly-unused PID as dead", () => {
    // 0x7fffffff is above any real PID on Linux/Windows; signal-0 → ESRCH.
    expect(isAlive(0x7fffffff)).toBe(false);
  });
});

describe("rewriteSubcommand", () => {
  it("swaps the token at the given index, preserving all others in order", () => {
    const argv = ["--cwd", "/work", "start", "--agent", "claude"];
    expect(rewriteSubcommand(argv, 2, "proxy")).toEqual([
      "--cwd",
      "/work",
      "proxy",
      "--agent",
      "claude",
    ]);
  });

  it("preserves a `--` passthrough tail unchanged", () => {
    const argv = ["start", "--", "node", "./my-acp.js", "--flag"];
    expect(rewriteSubcommand(argv, 0, "proxy")).toEqual([
      "proxy",
      "--",
      "node",
      "./my-acp.js",
      "--flag",
    ]);
  });

  it("does not mutate the input argv", () => {
    const argv = ["restart", "--agent", "codex"];
    const copy = [...argv];
    rewriteSubcommand(argv, 0, "proxy");
    expect(argv).toEqual(copy);
  });

  it("throws a ProcessControlError for an out-of-range index", () => {
    expect(() => rewriteSubcommand(["start"], 5, "proxy")).toThrow(ProcessControlError);
    expect(() => rewriteSubcommand(["start"], -1, "proxy")).toThrow(ProcessControlError);
  });
});
