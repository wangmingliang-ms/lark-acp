/**
 * `humming autostart install|disable` — manage OS-native boot autostart for
 * the gateway. `install` is also invoked by init/update; `disable` stops the
 * autostart without deleting its unit/task (reversible).
 */
import process from "node:process";
import { Command } from "commander";
import { resolveHomeDir } from "../config/load.js";
import { ensureAutostartForHome, disableAutostartForHome } from "../../autostart/runtime.js";
import type { AutostartReport } from "../../autostart/index.js";
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
    case "skipped":
      return `autostart skipped: ${report.reason}`;
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
    .command("disable")
    .description("disable boot autostart (keeps the unit/task for later re-enable)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      const homeDir = resolveHomeDir(globals.home);
      const report = disableAutostartForHome(homeDir);
      process.stdout.write(`${formatAutostartReport(report)}\n`);
    });
}
