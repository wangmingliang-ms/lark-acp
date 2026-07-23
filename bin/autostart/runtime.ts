/**
 * Wires the pure autostart logic to real side effects: filesystem, spawnSync,
 * and process-control's systemd probes. This is the only file in the module
 * that touches the OS directly, so it stays thin. It deliberately does NOT read
 * settings.json — the agent is resolved by `gateway run`/`start` at boot time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { isUserSystemdAvailable, gatewayUnitName } from "../process-control.js";
import {
  installSystemdAutostart,
  disableSystemdAutostart,
  enableSystemdAutostart,
  uninstallSystemdAutostart,
  querySystemdAutostart,
  type RunResult,
  type SystemdDeps,
} from "./systemd-installer.js";
import {
  installWindowsAutostart,
  disableWindowsAutostart,
  enableWindowsAutostart,
  uninstallWindowsAutostart,
  queryWindowsAutostart,
  renderTaskXml,
  type WindowsDeps,
} from "./windows-installer.js";
import {
  ensureAutostart,
  disableAutostart,
  enableAutostart,
  uninstallAutostart,
  queryAutostart,
  type AutostartReport,
  type AutostartStatus,
  type AutostartRuntime,
} from "./autostart.js";

function realRun(cmd: string, args: readonly string[]): RunResult {
  const result = spawnSync(cmd, [...args], { encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

const fsDeps = {
  readFile: readFileOrNull,
  writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content, "utf-8"),
  mkdirp: (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  rm: (filePath: string) => {
    fs.rmSync(filePath, { force: true });
  },
  run: realRun,
};

const WINDOWS_TASK_NAME = "Humming Gateway Autostart";

/**
 * Name of the persistent boot unit. Must differ from `gatewayUnitName` — that
 * one names the *transient* `systemd-run` unit for a live `gateway start`, and
 * systemd refuses to `enable` a persistent unit whose name collides with a
 * loaded transient one. We derive a distinct "-boot" name from the same digest.
 */
function bootUnitName(homeDir: string): string {
  return gatewayUnitName(homeDir).replace(/\.service$/, "-boot.service");
}

/** Boot unit name + on-disk path for the systemd autostart unit. */
function systemdPaths(homeDir: string): { unitName: string; unitPath: string } {
  const unitName = bootUnitName(homeDir);
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unitName);
  return { unitName, unitPath };
}

/** WindowsDeps bound to real schtasks/fs. */
function windowsDeps(): WindowsDeps {
  return {
    ...fsDeps,
    taskExists: (name) => realRun("schtasks.exe", ["/query", "/tn", name]).status === 0,
  };
}

/**
 * Build an {@link AutostartRuntime} bound to the real OS for the given home.
 * @throws {Error} propagated from installers when systemctl/schtasks fails.
 */
export function buildAutostartRuntime(homeDir: string, selfPath: string): AutostartRuntime {
  const ps1Path = path.join(homeDir, "autostart", "humming-autostart.ps1");
  return {
    env: { platform: process.platform, systemdAvailable: isUserSystemdAvailable() },
    installSystemd: () => {
      const { unitName, unitPath } = systemdPaths(homeDir);
      const systemdDeps: SystemdDeps = fsDeps;
      return installSystemdAutostart({
        unitPath,
        unitName,
        user: os.userInfo().username,
        spec: { nodePath: process.execPath, selfPath },
        deps: systemdDeps,
      });
    },
    installWindows: () => {
      const userId = `${os.hostname()}\\${os.userInfo().username}`;
      const taskXml = renderTaskXml({
        description: "Humming gateway autostart",
        pwshPath: "pwsh.exe",
        ps1Path,
        userId,
      });
      return installWindowsAutostart({
        ps1Path,
        ps1Spec: { hummingCommand: "humming" },
        taskName: WINDOWS_TASK_NAME,
        taskXml,
        deps: windowsDeps(),
      });
    },
    disableSystemd: () => {
      const { unitName, unitPath } = systemdPaths(homeDir);
      return disableSystemdAutostart({ unitPath, unitName, deps: fsDeps });
    },
    disableWindows: () =>
      disableWindowsAutostart({ taskName: WINDOWS_TASK_NAME, deps: windowsDeps() }),
    enableSystemd: () => {
      const { unitName, unitPath } = systemdPaths(homeDir);
      return enableSystemdAutostart({
        unitPath,
        unitName,
        user: os.userInfo().username,
        deps: fsDeps,
      });
    },
    enableWindows: () =>
      enableWindowsAutostart({ ps1Path, taskName: WINDOWS_TASK_NAME, deps: windowsDeps() }),
    uninstallSystemd: () => {
      const { unitName, unitPath } = systemdPaths(homeDir);
      return uninstallSystemdAutostart({ unitPath, unitName, deps: fsDeps });
    },
    uninstallWindows: () =>
      uninstallWindowsAutostart({ ps1Path, taskName: WINDOWS_TASK_NAME, deps: windowsDeps() }),
    querySystemd: () => {
      const { unitName, unitPath } = systemdPaths(homeDir);
      return querySystemdAutostart({ unitPath, unitName, deps: fsDeps });
    },
    queryWindows: () => queryWindowsAutostart({ taskName: WINDOWS_TASK_NAME, deps: windowsDeps() }),
  };
}

/** Convenience: build the real runtime and run the install dispatcher. */
export function ensureAutostartForHome(homeDir: string, selfPath: string): AutostartReport {
  return ensureAutostart(buildAutostartRuntime(homeDir, selfPath));
}

/** Convenience: build the real runtime and run the disable dispatcher. */
export function disableAutostartForHome(homeDir: string): AutostartReport {
  return disableAutostart(buildAutostartRuntime(homeDir, ""));
}

/** Convenience: build the real runtime and run the enable dispatcher. */
export function enableAutostartForHome(homeDir: string): AutostartReport {
  return enableAutostart(buildAutostartRuntime(homeDir, ""));
}

/** Convenience: build the real runtime and run the uninstall dispatcher. */
export function uninstallAutostartForHome(homeDir: string): AutostartReport {
  return uninstallAutostart(buildAutostartRuntime(homeDir, ""));
}

/** Convenience: build the real runtime and query the current autostart status. */
export function queryAutostartForHome(homeDir: string): AutostartStatus {
  return queryAutostart(buildAutostartRuntime(homeDir, ""));
}
