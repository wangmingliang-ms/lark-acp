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
