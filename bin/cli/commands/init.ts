/**
 * `humming init` — seed `~/.humming` guide/example files without creating
 * live `settings.json`/`sessions.json` (docs/cli-command-model-SPEC.md §6).
 */
import { Command } from "commander";
import { installHomeBootstrap } from "../config/load.js";
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import { formatAutostartReport } from "./autostart.js";
import type { GlobalOptions } from "../context.js";

export function registerInitCommand(program: Command, opts: { readonly selfPath: string }): void {
  program
    .command("init")
    .description("seed ~/.humming guide/example files (no live settings/sessions)")
    .action(function (this: Command) {
      runInit(this.optsWithGlobals<GlobalOptions>(), opts.selfPath);
    });
}

export function runInit(globals: GlobalOptions, selfPath: string): void {
  const { homeDir } = installHomeBootstrap(globals, true);
  process.stdout.write(
    [
      `initialized humming home templates in ${homeDir}:`,
      `  AGENTS.md`,
      `  CLAUDE.md`,
      `  settings.back.json`,
      `  sessions.back.json`,
      ``,
      `Note: settings.json and sessions.json were not created. Copy/edit the .back.json files if you want to configure them manually.`,
      ``,
    ].join("\n"),
  );
  const report = ensureAutostartForHome(homeDir, selfPath);
  process.stdout.write(`${formatAutostartReport(report)}\n`);
}
