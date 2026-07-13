import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armLifecycleCoordinator,
  buildLifecycleCoordinatorLaunch,
  isCoordinatorMainModule,
  LifecycleTransactionError,
  readLifecycleTransaction,
  runLifecycleCoordinator,
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

describe("coordinator CLI entrypoint", () => {
  it("recognizes a package-bin symlink as the main module", () => {
    const realPath = path.join(dir, "lifecycle-coordinator.js");
    const symlinkPath = path.join(dir, "humming-lifecycle-coordinator");
    fs.writeFileSync(realPath, "");
    fs.symlinkSync(realPath, symlinkPath);

    expect(isCoordinatorMainModule(symlinkPath, realPath)).toBe(true);
  });
});

describe("coordinator lifecycle execution", () => {
  it("waits for Bridge readiness, old PID exit, starts restart, and waits for new readiness", async () => {
    const calls: string[] = [];
    const tx = transaction();
    await runLifecycleCoordinator(tx, {
      arm: async () => calls.push("arm"),
      beginLifecycle: async (received) => {
        calls.push(`begin:${received.intent}`);
        return { accepted: true, transactionId: received.id, readyToExit: true };
      },
      isAlive: (pid) => {
        calls.push(`alive:${pid}`);
        return calls.filter((item) => item === `alive:${pid}`).length === 1;
      },
      delay: async () => {},
      startBridge: async (received) => {
        calls.push(`start:${received.launch.spawnArgv.join(" ")}`);
      },
      isReady: async () => {
        calls.push("ready");
        return calls.filter((item) => item === "ready").length > 1;
      },
      forceTerminate: async () => {
        calls.push("force");
      },
      complete: async (result) => {
        calls.push(`complete:${result.outcome}`);
      },
      now: () => 500,
    });

    expect(calls).toEqual([
      "arm",
      "begin:restart",
      "alive:4242",
      "alive:4242",
      "start:proxy --agent copilot",
      "ready",
      "ready",
      "complete:restarted",
    ]);
  });

  it("does not start a bridge for Stop", async () => {
    const complete: string[] = [];
    await runLifecycleCoordinator(transaction({ intent: "stop" }), {
      arm: async () => {},
      beginLifecycle: async (received) => ({
        accepted: true,
        transactionId: received.id,
        readyToExit: true,
      }),
      isAlive: () => false,
      delay: async () => {},
      startBridge: async () => {
        throw new Error("must not start");
      },
      isReady: async () => false,
      forceTerminate: async () => {},
      complete: async (result) => {
        complete.push(result.outcome);
      },
      now: () => 500,
    });
    expect(complete).toEqual(["stopped"]);
  });

  it("records restartFailed when beginLifecycle fails", async () => {
    const complete: string[] = [];
    await expect(
      runLifecycleCoordinator(transaction(), {
        arm: async () => {},
        beginLifecycle: async () => {
          throw new Error("control unavailable");
        },
        isAlive: () => true,
        delay: async () => {},
        startBridge: async () => {},
        isReady: async () => false,
        forceTerminate: async () => {},
        complete: async (result) => {
          complete.push(result.outcome);
        },
        now: () => 500,
      }),
    ).rejects.toThrow("control unavailable");
    expect(complete).toEqual(["restartFailed"]);
  });

  it("records restartFailed when the new Bridge cannot start", async () => {
    const complete: string[] = [];
    await expect(
      runLifecycleCoordinator(transaction(), {
        arm: async () => {},
        beginLifecycle: async (received) => ({
          accepted: true,
          transactionId: received.id,
          readyToExit: true,
        }),
        isAlive: () => false,
        delay: async () => {},
        startBridge: async () => {
          throw new Error("spawn failed");
        },
        isReady: async () => false,
        forceTerminate: async () => {},
        complete: async (result) => {
          complete.push(result.outcome);
        },
        now: () => 500,
      }),
    ).rejects.toThrow("spawn failed");
    expect(complete).toEqual(["restartFailed"]);
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

  it("builds a separate transient systemd unit on capable Linux and forwards agent auth", () => {
    const previous = process.env["COPILOT_PROXY_API_KEY"];
    process.env["COPILOT_PROXY_API_KEY"] = "test-proxy-key";
    const launch = buildLifecycleCoordinatorLaunch(transaction(), {
      platform: "linux",
      systemdAvailable: true,
      nodePath: "/usr/bin/node",
      coordinatorPath: "/opt/humming/lifecycle-coordinator.js",
    });
    if (previous === undefined) delete process.env["COPILOT_PROXY_API_KEY"];
    else process.env["COPILOT_PROXY_API_KEY"] = previous;

    expect(launch).toMatchObject({
      strategy: "systemd",
      command: "systemd-run",
    });
    expect(launch.args).toContain("COPILOT_PROXY_API_KEY=test-proxy-key");
    expect(launch.args.slice(-3)).toEqual([
      "/usr/bin/node",
      "/opt/humming/lifecycle-coordinator.js",
      transaction().statePath,
    ]);
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
