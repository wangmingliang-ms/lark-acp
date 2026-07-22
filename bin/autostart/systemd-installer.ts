import type { AutostartReport } from "./autostart.js";

/** Inputs for the persistent systemd user unit that boots the gateway. */
export interface SystemdUnitSpec {
  readonly nodePath: string;
  readonly selfPath: string;
  readonly agent: string | null;
}

/** Render the `.service` file text (pure). Trailing newline included. */
export function renderSystemdUnit(spec: SystemdUnitSpec): string {
  const agentSuffix = spec.agent !== null ? ` --agent ${spec.agent}` : "";
  const execStart = `${spec.nodePath} ${spec.selfPath} gateway run${agentSuffix}`;
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
 * @throws {Error} when a systemctl/loginctl command exits non-zero.
 */
export function installSystemdAutostart(args: SystemdInstallArgs): AutostartReport {
  const desired = renderSystemdUnit(args.spec);
  const current = args.deps.readFile(args.unitPath);
  if (current === desired) {
    return { kind: "already-current", mechanism: "systemd", path: args.unitPath };
  }
  const dir = args.unitPath.slice(0, args.unitPath.lastIndexOf("/"));
  args.deps.mkdirp(dir);
  args.deps.writeFile(args.unitPath, desired);
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
