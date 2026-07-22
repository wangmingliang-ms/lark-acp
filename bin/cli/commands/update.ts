/**
 * `humming update` — hard-sync the machine-managed checkout, rebuild, and
 * restart a running gateway with its original launch arguments
 * (docs/cli-command-model-SPEC.md §6).
 */
import fs from "node:fs";
import process from "node:process";
import { Command } from "commander";
import {
  managedCheckoutDir,
  gatewayLaunchPath,
  isGatewayRunning,
  readLaunchArgv,
  runGit,
  runNpm,
  ProcessControlError,
} from "../../process-control.js";
import { resolveHomeDir } from "../config/load.js";
import { ensureAutostartForHome } from "../../autostart/runtime.js";
import { formatAutostartReport } from "./autostart.js";
import type { GlobalOptions } from "../context.js";
import { handoffLifecycle } from "../lifecycle.js";

const ENV_UPDATE_REF = "HUMMING_REF";
const DEFAULT_UPDATE_REF = "main";
const DEFAULT_UPDATE_REPO = "wangmingliang-ms/humming";

export function registerUpdateCommand(program: Command, opts: { readonly selfPath: string }): void {
  program
    .command("update")
    .description("hard-sync the managed checkout, rebuild, and restart a running gateway")
    .action(async function (this: Command) {
      await runUpdate(this.optsWithGlobals<GlobalOptions>(), opts.selfPath);
    });
}

/** The branch `update` hard-syncs to: `$HUMMING_REF` if set and non-empty, else `main`. */
export function resolveUpdateRef(): string {
  const fromEnv = process.env[ENV_UPDATE_REF];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_UPDATE_REF;
}

/**
 * @throws {ProcessControlError} when the checkout is missing, a git/npm step
 *         fails, or a running gateway has no readable launch descriptor.
 */
export async function runUpdate(globals: GlobalOptions, selfPath: string): Promise<void> {
  const homeDir = resolveHomeDir(globals.home);
  const checkoutDir = managedCheckoutDir(homeDir);
  if (!isDirectory(checkoutDir)) {
    throw new ProcessControlError(
      `no managed checkout at ${checkoutDir}. ` +
        `Re-run the install script to create it:\n` +
        `  curl -fsSL https://raw.githubusercontent.com/${DEFAULT_UPDATE_REPO}/main/install.sh | sh`,
    );
  }

  const ref = resolveUpdateRef();
  process.stdout.write(`humming update: syncing ${checkoutDir} to origin/${ref} ...\n`);
  runGit(["fetch", "origin"], checkoutDir);
  runGit(["checkout", "-f", ref], checkoutDir);
  runGit(["reset", "--hard", `origin/${ref}`], checkoutDir);

  process.stdout.write("humming update: installing dependencies ...\n");
  runNpm(["install", "--no-audit", "--no-fund"], checkoutDir);
  process.stdout.write("humming update: building ...\n");
  runNpm(["run", "build"], checkoutDir);
  process.stdout.write("humming update: refreshing global command ...\n");
  runNpm(["link"], checkoutDir);

  const report = ensureAutostartForHome(homeDir, selfPath);
  process.stdout.write(`humming update: ${formatAutostartReport(report)}\n`);

  await restartGatewayAfterUpdate(homeDir);
}

/**
 * After a successful build, restart the gateway iff one is running, reusing
 * the persisted launch argv. When nothing is running, print a start hint.
 *
 * @throws {ProcessControlError} when a gateway is running but its launch
 *         descriptor is missing/unreadable.
 */
async function restartGatewayAfterUpdate(homeDir: string): Promise<void> {
  if (!isGatewayRunning(homeDir)) {
    process.stdout.write(
      "humming update: done. Gateway is not running — start it with `humming gateway start`.\n",
    );
    return;
  }

  const launch = readLaunchArgv(homeDir);
  if (launch === null) {
    throw new ProcessControlError(
      `update rebuilt the checkout, but the running gateway has no launch record at ` +
        `${gatewayLaunchPath(homeDir)}. Restart it manually with \`humming gateway restart\` ` +
        `(or \`humming gateway start --agent <preset>\` if needed).`,
    );
  }

  process.stdout.write("humming update: handing restart to lifecycle coordinator ...\n");
  handoffLifecycle(homeDir, "restart", launch);
}

/** Whether `candidate` exists and is a directory. Swallows stat errors as `false`. */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
