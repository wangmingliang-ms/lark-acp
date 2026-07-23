import type { AutostartReport, AutostartStatus } from "./autostart.js";

/** Inputs for the persistent systemd user unit that boots the gateway. */
export interface SystemdUnitSpec {
  readonly nodePath: string;
  readonly selfPath: string;
}

/**
 * Render the `.service` file text (pure). Trailing newline included.
 *
 * Intentionally omits `--agent`: `gateway run` resolves the agent itself from
 * settings.json `runtime.agent` (falling back to the built-in default). Baking
 * the agent into the unit would freeze a stale value when the user later edits
 * settings.
 */
export function renderSystemdUnit(spec: SystemdUnitSpec): string {
  const execStart = `${spec.nodePath} ${spec.selfPath} gateway run`;
  return (
    [
      "[Unit]",
      "Description=Humming gateway",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${execStart}`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\n") + "\n"
  );
}

/** Result of a spawned command. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injected side effects for the systemd installer. */
export interface SystemdDeps {
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, content: string) => void;
  readonly mkdirp: (dir: string) => void;
  readonly rm: (path: string) => void;
  readonly run: (cmd: string, args: readonly string[]) => RunResult;
}

/** Everything needed to install the persistent unit. */
export interface SystemdInstallArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly user: string;
  readonly spec: SystemdUnitSpec;
  readonly deps: SystemdDeps;
}

/**
 * Write the unit (only when changed), reload/enable it, and enable linger.
 * Treats a content-identical but *disabled* unit as needing re-enable, so
 * `install` recovers a unit left disabled by `disable` without rewriting it.
 * @throws {Error} when a systemctl/loginctl command exits non-zero.
 */
export function installSystemdAutostart(args: SystemdInstallArgs): AutostartReport {
  const desired = renderSystemdUnit(args.spec);
  const current = args.deps.readFile(args.unitPath);
  const contentMatches = current === desired;
  if (contentMatches) {
    const state = args.deps.run("systemctl", ["--user", "is-enabled", args.unitName]).stdout.trim();
    if (state === "enabled") {
      return { kind: "already-current", mechanism: "systemd", path: args.unitPath };
    }
  } else {
    const dir = args.unitPath.slice(0, args.unitPath.lastIndexOf("/"));
    args.deps.mkdirp(dir);
    args.deps.writeFile(args.unitPath, desired);
  }
  runOrThrow(args.deps, "systemctl", ["--user", "daemon-reload"]);
  runOrThrow(args.deps, "systemctl", ["--user", "enable", args.unitName]);
  runOrThrow(args.deps, "loginctl", ["enable-linger", args.user]);
  return { kind: "installed", mechanism: "systemd", path: args.unitPath };
}

function runOrThrow(deps: SystemdDeps, cmd: string, cmdArgs: readonly string[]): void {
  const result = deps.run(cmd, cmdArgs);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

/** Everything needed to disable (but keep) the persistent unit. */
export interface SystemdDisableArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly deps: SystemdDeps;
}

/**
 * Disable the boot unit without deleting its file (semantics A: reversible).
 * Idempotent: reports `already-disabled` when the unit file is absent or the
 * unit is not currently enabled.
 * @throws {Error} when `systemctl --user disable` exits non-zero.
 */
export function disableSystemdAutostart(args: SystemdDisableArgs): AutostartReport {
  const present = args.deps.readFile(args.unitPath) !== null;
  if (!present) {
    return { kind: "already-disabled", mechanism: "systemd", path: args.unitPath };
  }
  const state = args.deps.run("systemctl", ["--user", "is-enabled", args.unitName]).stdout.trim();
  if (state !== "enabled") {
    return { kind: "already-disabled", mechanism: "systemd", path: args.unitPath };
  }
  runOrThrow(args.deps, "systemctl", ["--user", "disable", args.unitName]);
  return { kind: "disabled", mechanism: "systemd", path: args.unitPath };
}

/** Everything needed to enable an already-installed unit (no file writes). */
export interface SystemdEnableArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly user: string;
  readonly deps: SystemdDeps;
}

/**
 * Enable an already-installed boot unit without touching its file. Requires the
 * unit file to exist (install first). Idempotent: reports `already-current`
 * when the unit is already enabled.
 * @throws {Error} when a systemctl/loginctl command exits non-zero.
 */
export function enableSystemdAutostart(args: SystemdEnableArgs): AutostartReport {
  const present = args.deps.readFile(args.unitPath) !== null;
  if (!present) {
    return { kind: "not-installed", mechanism: "systemd", path: args.unitPath };
  }
  const state = args.deps.run("systemctl", ["--user", "is-enabled", args.unitName]).stdout.trim();
  if (state === "enabled") {
    return { kind: "already-current", mechanism: "systemd", path: args.unitPath };
  }
  runOrThrow(args.deps, "systemctl", ["--user", "daemon-reload"]);
  runOrThrow(args.deps, "systemctl", ["--user", "enable", args.unitName]);
  runOrThrow(args.deps, "loginctl", ["enable-linger", args.user]);
  return { kind: "enabled", mechanism: "systemd", path: args.unitPath };
}

/** Everything needed to uninstall (disable + delete) the persistent unit. */
export interface SystemdUninstallArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly deps: SystemdDeps;
}

/**
 * Disable (if enabled) and delete the boot unit file, then reload systemd.
 * Idempotent: reports `already-uninstalled` when the unit file is absent.
 * @throws {Error} when a systemctl command exits non-zero.
 */
export function uninstallSystemdAutostart(args: SystemdUninstallArgs): AutostartReport {
  const present = args.deps.readFile(args.unitPath) !== null;
  if (!present) {
    return { kind: "already-uninstalled", mechanism: "systemd", path: args.unitPath };
  }
  const state = args.deps.run("systemctl", ["--user", "is-enabled", args.unitName]).stdout.trim();
  if (state === "enabled") {
    runOrThrow(args.deps, "systemctl", ["--user", "disable", args.unitName]);
  }
  args.deps.rm(args.unitPath);
  runOrThrow(args.deps, "systemctl", ["--user", "daemon-reload"]);
  return { kind: "uninstalled", mechanism: "systemd", path: args.unitPath };
}

/** Everything needed to query the persistent unit's status. */
export interface SystemdQueryArgs {
  readonly unitPath: string;
  readonly unitName: string;
  readonly deps: SystemdDeps;
}

/**
 * Report whether the boot unit is installed and enabled. Read-only: never
 * mutates state and never throws for a missing/disabled unit.
 */
export function querySystemdAutostart(args: SystemdQueryArgs): AutostartStatus {
  const present = args.deps.readFile(args.unitPath) !== null;
  if (!present) {
    return { kind: "not-installed", mechanism: "systemd", path: args.unitPath };
  }
  const state = args.deps.run("systemctl", ["--user", "is-enabled", args.unitName]).stdout.trim();
  if (state === "enabled") {
    return { kind: "enabled", mechanism: "systemd", path: args.unitPath };
  }
  return { kind: "installed-disabled", mechanism: "systemd", path: args.unitPath };
}
