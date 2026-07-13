import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armLifecycleCoordinator,
  buildLifecycleCoordinatorLaunch,
  LifecycleTransactionError,
  readLifecycleTransaction,
  writeLifecycleTransaction,
  type LifecycleTransaction,
} from "./lifecycle-coordinator.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-lifecycle-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function transaction(overrides: Partial<LifecycleTransaction> = {}): LifecycleTransaction {
  const statePath = path.join(dir, "lifecycle.json");
  return {
    id: "lifecycle-123",
    intent: "restart",
    home: dir,
    oldPid: 4242,
    launch: {
      spawnArgv: ["proxy", "--agent", "copilot"],
      workingDirectory: "/repo",
      savedAt: "2026-07-13T10:00:00.000Z",
    },
    deadlines: {
      readyToExitAt: 1_000,
      oldPidExitAt: 2_000,
      restartReadyAt: 3_000,
    },
    statePath,
    ...overrides,
  };
}

describe("lifecycle transaction persistence", () => {
  it("atomically persists and validates a serializable lifecycle transaction", () => {
    const expected = transaction();

    writeLifecycleTransaction(expected);

    expect(readLifecycleTransaction(expected.statePath)).toEqual(expected);
    expect(fs.readdirSync(dir)).toEqual(["lifecycle.json"]);
  });

  it("rejects malformed transaction state", () => {
    const statePath = path.join(dir, "lifecycle.json");
    fs.writeFileSync(statePath, JSON.stringify({ ...transaction(), oldPid: 0 }));

    expect(() => readLifecycleTransaction(statePath)).toThrow(LifecycleTransactionError);
  });
});

describe("coordinator launch strategy", () => {
  it("builds a detached Node helper for Windows", () => {
    expect(
      buildLifecycleCoordinatorLaunch(transaction(), {
        platform: "win32",
        systemdAvailable: false,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        coordinatorPath: "C:\\humming\\lifecycle-coordinator.js",
      }),
    ).toEqual({
      strategy: "detached",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\humming\\lifecycle-coordinator.js", transaction().statePath],
    });
  });

  it("builds a separate transient systemd unit on capable Linux", () => {
    expect(
      buildLifecycleCoordinatorLaunch(transaction(), {
        platform: "linux",
        systemdAvailable: true,
        nodePath: "/usr/bin/node",
        coordinatorPath: "/opt/humming/lifecycle-coordinator.js",
      }),
    ).toEqual({
      strategy: "systemd",
      command: "systemd-run",
      args: [
        "--user",
        "--unit",
        "humming-lifecycle-lifecycle-123",
        "--collect",
        "--property",
        "Type=exec",
        "--property",
        "StandardInput=null",
        "/usr/bin/node",
        "/opt/humming/lifecycle-coordinator.js",
        transaction().statePath,
      ],
    });
  });

  it("falls back to a detached Node helper without systemd", () => {
    expect(
      buildLifecycleCoordinatorLaunch(transaction({ intent: "stop" }), {
        platform: "linux",
        systemdAvailable: false,
        nodePath: "/usr/bin/node",
        coordinatorPath: "/opt/humming/lifecycle-coordinator.js",
      }).strategy,
    ).toBe("detached");
  });

  it("detaches and acknowledges the helper launch", () => {
    const calls: string[] = [];
    const child = { pid: 9876, unref: () => calls.push("unref") };

    expect(
      armLifecycleCoordinator(
        transaction(),
        {
          platform: "win32",
          systemdAvailable: false,
          nodePath: "node.exe",
          coordinatorPath: "coordinator.js",
        },
        {
          spawn: (_command, _args, options) => {
            expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
            calls.push("spawn");
            return child;
          },
          spawnSync: () => {
            throw new Error("not expected");
          },
        },
      ),
    ).toEqual({ strategy: "detached", pid: 9876 });
    expect(calls).toEqual(["spawn", "unref"]);
  });
});
