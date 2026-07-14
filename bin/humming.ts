#!/usr/bin/env node
/**
 * `humming` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * This file is bootstrap only: resolve the package version, build the
 * Commander program (`bin/cli/program.ts`), parse `argv`, and translate any
 * thrown error into a process exit code/message. All command behavior lives
 * under `bin/cli/**` — see docs/cli-command-model-SPEC.md §13 for the target
 * module layout.
 *
 * Command tree: `humming bridge|agent|session|setup|init|update` — run
 * `humming --help` (or any subcommand `--help`) for the full reference.
 */
import fs from "node:fs";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { buildProgram } from "./cli/program.js";
import { CliError, formatError } from "./cli/errors.js";
import { ProcessControlError } from "./process-control.js";

/**
 * Package version for `--version`. Resolved lazily and tolerantly: the built
 * CLI lives at `dist/bin/humming.js` (package.json two levels up), but when
 * this module is imported from source (e.g. a vitest unit test) that
 * relative path differs. Never throw at import time over a cosmetic string —
 * fall back to `"?"` if resolution fails.
 */
function resolveVersion(): string {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = createRequire(import.meta.url)(rel) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "?";
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram({
    version: resolveVersion(),
    selfPath: fileURLToPath(import.meta.url),
  });
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already printed its own usage/help text to stdout/stderr.
      process.exitCode = err.exitCode;
      return;
    }
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof ProcessControlError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`fatal: ${formatError(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * True when this module is the process entry point (run as `humming …`),
 * false when it's imported (e.g. by a vitest unit test). Lets the file be
 * imported for its exports without auto-running {@link main}. Symlinks are
 * resolved on both sides so a global-bin install (which runs through a
 * symlink) still matches.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
