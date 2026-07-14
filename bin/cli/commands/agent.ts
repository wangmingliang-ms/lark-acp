/**
 * `humming agent list|capabilities|models|modes|permissions`
 * (docs/cli-command-model-SPEC.md §7). `capabilities`/`models`/`modes`/
 * `permissions` share one short-lived Agent probe; the latter three are pure
 * projections of that one result (invariant 10).
 */
import { Command } from "commander";
import { PERMISSION_MODES, probeAgentSessionCapabilities } from "../../../src/index.js";
import {
  loadCliBase,
  notifyAgentProbeFailure,
  resolveAgentProbeTarget,
  resolveOptionalChatScope,
  SILENT_LOGGER,
  type GlobalOptions,
} from "../context.js";
import { DEFAULT_PERMISSION_MODE } from "../config/load.js";
import { addAgentOption, addChatIdOption, addCwdOption, addThreadIdOption } from "../options.js";
import {
  printCapabilities,
  printJson,
  printModels,
  printModes,
  printPermissions,
  registerCapabilityProjection,
  type CapabilityProjection,
} from "../output.js";
import type { CapabilitiesView } from "../output.js";

interface AgentProbeCliOptions {
  readonly agent: string;
  readonly cwd?: string;
  readonly chatId?: string;
  readonly threadId?: string;
  readonly json?: boolean;
}

const AGENT_PROBE_PROJECTIONS: readonly CapabilityProjection[] = [
  {
    name: "capabilities",
    description: "print the full Agent capability probe result",
    project: printCapabilities,
  },
  { name: "models", description: "print the Agent's available Models", project: printModels },
  { name: "modes", description: "print the Agent's available Modes", project: printModes },
  {
    name: "permissions",
    description: "print Humming's supported approval-card policies",
    project: printPermissions,
  },
];

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("inspect ACP Agent presets and capabilities");

  agent
    .command("list")
    .description("list configured Agent presets")
    .option("--json", "print machine-readable JSON instead of a formatted summary")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions & { json?: boolean }>();
      printAgentList(globals);
    });

  for (const projection of AGENT_PROBE_PROJECTIONS) {
    registerCapabilityProjection<GlobalOptions & AgentProbeCliOptions>(
      agent,
      projection,
      (cmd) => {
        addAgentOption(cmd, { required: true });
        addCwdOption(cmd);
        addChatIdOption(cmd);
        addThreadIdOption(cmd);
      },
      fetchAgentCapabilities,
    );
  }
}

function printAgentList(globals: GlobalOptions & { json?: boolean }): void {
  const { registry } = loadCliBase(globals);
  const entries = [...registry.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (globals.json === true) {
    printJson(
      entries.map(([id, entry]) => ({
        id,
        label: entry.preset.label,
        command: entry.preset.command,
        args: entry.preset.args,
        source: entry.source,
        ...(entry.preset.description !== undefined
          ? { description: entry.preset.description }
          : {}),
      })),
    );
    return;
  }
  const idColWidth = Math.max(...entries.map(([id]) => id.length));
  const lines = ["ACP agent presets:", ""];
  for (const [id, entry] of entries) {
    const { preset, source } = entry;
    const fullCmd = [preset.command, ...preset.args].join(" ");
    lines.push(`  ${id.padEnd(idColWidth)}  ${preset.label} [${source}]`);
    if (preset.description) lines.push(`  ${" ".repeat(idColWidth)}  ${preset.description}`);
    lines.push(`  ${" ".repeat(idColWidth)}  $ ${fullCmd}`);
    lines.push("");
  }
  lines.push(
    "Use any of these with `humming agent capabilities --agent <id>` or `session configure --agent <id>`.",
  );
  lines.push("Add or override entries via the `agents` field of settings.json.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function fetchAgentCapabilities(
  globals: GlobalOptions & AgentProbeCliOptions,
): Promise<CapabilitiesView> {
  const base = loadCliBase(globals);
  const scope = resolveOptionalChatScope({ chatId: globals.chatId, threadId: globals.threadId });
  const target = resolveAgentProbeTarget(base, {
    agent: globals.agent,
    ...(globals.cwd !== undefined ? { cwd: globals.cwd } : {}),
    ...(scope.chatId !== undefined ? { chatId: scope.chatId } : {}),
    threadId: scope.threadId,
  });

  let result: Awaited<ReturnType<typeof probeAgentSessionCapabilities>>;
  try {
    result = await probeAgentSessionCapabilities({
      command: target.invocation.command,
      args: [...target.invocation.args],
      cwd: target.cwd,
      ...(target.invocation.env ? { env: { ...target.invocation.env } } : {}),
      logger: SILENT_LOGGER,
    });
  } catch (err) {
    await notifyAgentProbeFailure(target, err);
    throw err;
  }

  return {
    session: {
      ...(target.chatId !== undefined ? { chatId: target.chatId } : {}),
      threadId: target.threadId,
      sessionId: result.sessionId,
    },
    agent: {
      ...(target.invocation.label !== undefined ? { label: target.invocation.label } : {}),
      command: target.invocation.command,
      args: target.invocation.args,
      cwd: target.cwd,
    },
    ...result.capabilities,
    bridgePermissionModes: PERMISSION_MODES,
    bridgePermissionMode: base.file.runtime.permissionMode ?? DEFAULT_PERMISSION_MODE,
  };
}
