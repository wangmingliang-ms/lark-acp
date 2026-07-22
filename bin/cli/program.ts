/**
 * Commander program construction: root options, version/help wiring, and
 * registration of every subcommand
 * (docs/cli-command-model-SPEC.md §4, §13).
 */
import { Command } from "commander";
import { registerGatewayCommand, registerGatewayShortcuts } from "./commands/gateway.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerInitCommand } from "./commands/init.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerAutostartCommand } from "./commands/autostart.js";

export interface BuildProgramOptions {
  readonly version: string;
  /** Absolute path of the built CLI entry (`dist/bin/humming.js`), used to spawn `gateway start` in the background. */
  readonly selfPath: string;
}

/**
 * Build the root `humming` Commander program. Uses `exitOverride()` so
 * parsing/validation failures throw a `CommanderError` instead of calling
 * `process.exit` directly — the bootstrap in bin/humming.ts is the only place
 * that translates errors into a process exit, keeping every command module
 * safe to import and drive with `parseAsync` from unit tests.
 */
export function buildProgram(opts: BuildProgramOptions): Command {
  const program = new Command("humming")
    .description("Connect a Lark bot to any ACP-compatible AI agent")
    .version(opts.version, "-v, --version")
    .option("--home <dir>", "Humming home directory (default: ~/.humming)")
    .option("--settings-path <path>", "settings.json path override (default: <home>/settings.json)")
    .option("--data-dir <dir>", "state directory override (default: <home>)")
    .exitOverride()
    .configureHelp({ showGlobalOptions: true });

  registerGatewayCommand(program, { selfPath: opts.selfPath });
  registerGatewayShortcuts(program, { selfPath: opts.selfPath });
  registerAgentCommand(program);
  registerSessionCommand(program);
  registerSetupCommand(program);
  registerInitCommand(program, { selfPath: opts.selfPath });
  registerUpdateCommand(program, { selfPath: opts.selfPath });
  registerAutostartCommand(program, { selfPath: opts.selfPath });

  return program;
}
