/**
 * Wires the pure autostart logic to real side effects: filesystem, spawnSync,
 * settings.json, and process-control's systemd probes. This is the only file
 * in the module that touches the OS directly, so it stays thin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { isUserSystemdAvailable, gatewayUnitName } from "../process-control.js";
import { readConfigFile } from "../cli/config/load.js";
import {
  installSystemdAutostart,
  type RunResult,
  type SystemdDeps,
} from "./systemd-installer.js";
import { installWindowsAutostart, renderTaskXml, type WindowsDeps } from "./windows-installer.js";
import { ensureAutostart, type AutostartReport, type AutostartRuntime } from "./autostart.js";

/** Minimal shape read from settings for the agent default. */
export interface AgentSettingsView {
  readonly runtime: { readonly agent?: string };
}

/** The `--agent` default: settings `runtime.agent`, else null. */
export function resolveAgentFlag(settings: AgentSettingsView): string | null {
  return settings.runtime.agent ?? null;
}

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
  run: realRun,
};

const WINDOWS_TASK_NAME = "Humming Gateway Autostart";

/** Read `runtime.agent` from settings.json, tolerating a missing/unreadable file. */
function readAgentFlag(homeDir: string): string | null {
  try {
    return resolveAgentFlag(readConfigFile(path.join(homeDir, "settings.json")));
  } catch {
    return null;
  }
}

/**
 * Build an {@link AutostartRuntime} bound to the real OS for the given home.
 * @throws {Error} propagated from installers when systemctl/schtasks fails.
 */
export function buildAutostartRuntime(homeDir: string, selfPath: string): AutostartRuntime {
  const agent = readAgentFlag(homeDir);
  return {
    env: { platform: process.platform, systemdAvailable: isUserSystemdAvailable() },
    installSystemd: () => {
      const unitName = gatewayUnitName(homeDir);
      const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unitName);
      const systemdDeps: SystemdDeps = fsDeps;
      return installSystemdAutostart({
        unitPath,
        unitName,
        user: os.userInfo().username,
        spec: { nodePath: process.execPath, selfPath, agent },
        deps: systemdDeps,
      });
    },
    installWindows: () => {
      const ps1Path = path.join(homeDir, "autostart", "humming-autostart.ps1");
      const pwshPath = "pwsh.exe";
      const userId = `${os.hostname()}\\${os.userInfo().username}`;
      const taskXml = renderTaskXml({
        description: "Humming gateway autostart",
        pwshPath,
        ps1Path,
        userId,
      });
      const winDeps: WindowsDeps = {
        ...fsDeps,
        taskExists: (name) => realRun("schtasks.exe", ["/query", "/tn", name]).status === 0,
      };
      return installWindowsAutostart({
        ps1Path,
        ps1Spec: { hummingCommand: "humming", agent },
        taskName: WINDOWS_TASK_NAME,
        taskXml,
        deps: winDeps,
      });
    },
  };
}

/** Convenience: build the real runtime and run the dispatcher. */
export function ensureAutostartForHome(homeDir: string, selfPath: string): AutostartReport {
  return ensureAutostart(buildAutostartRuntime(homeDir, selfPath));
}
