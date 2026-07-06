import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bridgeControlSocketPath,
  bridgeControlSocketPathForPlatform,
  bridgeLaunchPath,
  bridgeLogPath,
  bridgePidPath,
  bridgeRestartMarkerPath,
  bridgeUnitName,
  clearBridgeRestartMarker,
  isAlive,
  managedCheckoutDir,
  markBridgeRestart,
  parseProcessElapsedSeconds,
  persistLaunchArgv,
  readLaunchArgv,
  readPid,
  rewriteSubcommand,
  ProcessControlError,
} from "./process-control.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-pc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("compose PID, log, and restart-marker paths under the home dir", () => {
    expect(bridgePidPath(dir)).toBe(path.join(dir, "bridge.pid"));
    expect(bridgeLogPath(dir)).toBe(path.join(dir, "bridge.log"));
    expect(bridgeRestartMarkerPath(dir)).toBe(path.join(dir, "bridge.restart"));
  });

  it("composes the managed checkout and launch-file paths under the home dir", () => {
    expect(managedCheckoutDir(dir)).toBe(path.join(dir, "humming-project"));
    expect(bridgeLaunchPath(dir)).toBe(path.join(dir, "bridge.launch.json"));
    expect(bridgeControlSocketPath(dir)).toBe(path.join(dir, "control.sock"));
  });

  it("uses a Windows named pipe for the control socket on Windows", () => {
    const pipe = bridgeControlSocketPathForPlatform("C:\\Users\\miller\\.humming", "win32");

    expect(pipe).toMatch(/^\\\\\.\\pipe\\humming-bridge-[a-f0-9]{10}-control$/);
    expect(pipe).toBe(bridgeControlSocketPathForPlatform("C:\\Users\\miller\\.humming", "win32"));
  });

  it("derives a stable per-home systemd unit name", () => {
    expect(bridgeUnitName(dir)).toMatch(/^humming-bridge-[a-f0-9]{10}\.service$/);
    expect(bridgeUnitName(dir)).toBe(bridgeUnitName(dir));
    expect(bridgeUnitName(path.join(dir, "other"))).not.toBe(bridgeUnitName(dir));
  });
});

describe("launch descriptor round-trip", () => {
  it("returns null when no launch file exists", () => {
    expect(readLaunchArgv(dir)).toBeNull();
  });

  it("persists and reads back the spawn argv and working directory", () => {
    persistLaunchArgv(dir, ["proxy", "--agent", "codex"], "/home/user/repo");
    const restored = readLaunchArgv(dir);
    expect(restored).not.toBeNull();
    expect(restored?.spawnArgv).toEqual(["proxy", "--agent", "codex"]);
    expect(restored?.workingDirectory).toBe("/home/user/repo");
    // savedAt is an ISO-8601 timestamp string (informational).
    expect(typeof restored?.savedAt).toBe("string");
    expect(Number.isNaN(Date.parse(restored?.savedAt ?? ""))).toBe(false);
  });

  it("overwrites a previous descriptor on re-persist", () => {
    persistLaunchArgv(dir, ["proxy", "--agent", "claude"], "/a");
    persistLaunchArgv(dir, ["proxy", "--agent", "codex"], "/b");
    const restored = readLaunchArgv(dir);
    expect(restored?.spawnArgv).toEqual(["proxy", "--agent", "codex"]);
    expect(restored?.workingDirectory).toBe("/b");
  });

  it("creates the home dir if missing before writing", () => {
    const nested = path.join(dir, "does", "not", "exist");
    persistLaunchArgv(nested, ["proxy"], "/repo");
    expect(readLaunchArgv(nested)?.spawnArgv).toEqual(["proxy"]);
  });

  it("throws a typed error for malformed JSON rather than throwing through", () => {
    fs.writeFileSync(bridgeLaunchPath(dir), "{ not json");
    expect(() => readLaunchArgv(dir)).toThrow(ProcessControlError);
  });

  it("throws a typed error for a well-formed JSON of the wrong shape", () => {
    fs.writeFileSync(bridgeLaunchPath(dir), JSON.stringify({ spawnArgv: "not-an-array" }));
    expect(() => readLaunchArgv(dir)).toThrow(ProcessControlError);
  });

  it("rejects a spawnArgv array containing non-string entries", () => {
    fs.writeFileSync(
      bridgeLaunchPath(dir),
      JSON.stringify({ spawnArgv: ["proxy", 42], workingDirectory: "/x", savedAt: "now" }),
    );
    expect(() => readLaunchArgv(dir)).toThrow(ProcessControlError);
  });
});

describe("restart marker helpers", () => {
  it("creates and clears the restart marker", () => {
    const marker = bridgeRestartMarkerPath(dir);
    expect(fs.existsSync(marker)).toBe(false);

    markBridgeRestart(dir);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf-8").trim()).toMatch(/^\d+$/);

    clearBridgeRestartMarker(dir);
    expect(fs.existsSync(marker)).toBe(false);
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

describe("parseProcessElapsedSeconds", () => {
  it("parses the integer-seconds form of `ps -o etimes=`", () => {
    expect(parseProcessElapsedSeconds("  10267\n")).toBe(10267);
    expect(parseProcessElapsedSeconds("0\n")).toBe(0);
  });

  it("returns null for the empty output of a nonexistent PID", () => {
    expect(parseProcessElapsedSeconds("")).toBeNull();
    expect(parseProcessElapsedSeconds("   \n")).toBeNull();
  });

  it("returns null for non-integer / negative garbage", () => {
    for (const bad of ["abc", "-5", "3.14", "10 20"]) {
      expect(parseProcessElapsedSeconds(bad)).toBeNull();
    }
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
