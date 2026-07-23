/**
 * `humming autostart install|enable|disable|uninstall|status` — manage
 * OS-native boot autostart for the gateway. `install` writes the unit/task and
 * enables it (also invoked by init/update); `enable`/`disable` flip the enabled
 * state without touching files; `uninstall` removes the unit/task and files;
 * `status` reports the current state read-only.
 */
import process from "node:process";
import { Command } from "commander";
import { resolveHomeDir } from "../config/load.js";
import {
  ensureAutostartForHome,
  disableAutostartForHome,
  enableAutostartForHome,
  uninstallAutostartForHome,
  queryAutostartForHome,
} from "../../autostart/runtime.js";
import type { AutostartReport, AutostartStatus } from "../../autostart/index.js";
import type { GlobalOptions } from "../context.js";

/** Human-readable one-liner for a report. */
export function formatAutostartReport(report: AutostartReport): string {
  switch (report.kind) {
    case "installed":
      return `autostart installed (${report.mechanism}) at ${report.path}`;
    case "already-current":
      return `autostart already current (${report.mechanism}) at ${report.path}`;
    case "disabled":
      return `autostart disabled (${report.mechanism}) at ${report.path}`;
    case "already-disabled":
      return `autostart already disabled (${report.mechanism}) at ${report.path}`;
    case "enabled":
      return `autostart enabled (${report.mechanism}) at ${report.path}`;
    case "not-installed":
      return `autostart not installed (${report.mechanism}) at ${report.path}`;
    case "uninstalled":
      return `autostart uninstalled (${report.mechanism}) at ${report.path}`;
    case "already-uninstalled":
      return `autostart already uninstalled (${report.mechanism}) at ${report.path}`;
    case "skipped":
      return `autostart skipped: ${report.reason}`;
  }
}

/** Human-readable one-liner for a status query. */
export function formatAutostartStatus(status: AutostartStatus): string {
  switch (status.kind) {
    case "enabled":
      return `autostart enabled (${status.mechanism}) at ${status.path}`;
    case "installed-disabled":
      return `autostart installed but disabled (${status.mechanism}) at ${status.path}`;
    case "not-installed":
      return `autostart not installed (${status.mechanism}) at ${status.path}`;
    case "unsupported":
      return `autostart unsupported: ${status.reason}`;
  }
}

export interface RegisterAutostartOptions {
  readonly selfPath: string;
}

export function registerAutostartCommand(program: Command, opts: RegisterAutostartOptions): void {
  const autostart = program
    .command("autostart")
    .description("manage OS-native boot autostart for the gateway");

  autostart
    .command("install")
    .description("install (idempotently) boot autostart for the gateway")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = ensureAutostartForHome(homeDir, opts.selfPath);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });

  autostart
    .command("enable")
    .description("enable an already-installed boot autostart (no file changes)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = enableAutostartForHome(homeDir);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });

  autostart
    .command("disable")
    .description("disable boot autostart (keeps the unit/task for later re-enable)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = disableAutostartForHome(homeDir);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });

  autostart
    .command("uninstall")
    .description("remove boot autostart entirely (deletes the unit/task and files)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = uninstallAutostartForHome(homeDir);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });

  autostart
    .command("status")
    .description("report the current boot autostart status (read-only)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const status = queryAutostartForHome(homeDir);
      process.stdout.write(`${formatAutostartStatus(status)}\n`);
    });
}
