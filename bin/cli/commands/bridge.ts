/**
 * `humming bridge run|start|stop|restart|status|logs`
 * (docs/cli-command-model-SPEC.md §6).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  LarkBridge,
  FileSessionStore,
  SettingsBindingStore,
  LarkHttpClient,
  createPinoLogger,
  sendLifecycleNotice,
} from "../../../src/index.js";
import type { LarkLogger, ResolvedAgentInvocation } from "../../../src/index.js";
import { resolveAgent, type Registry } from "../../agents.js";
import {
  startBridge,
  statusBridge,
  tailLog,
  bridgeControlSocketPath,
  bridgeRestartMarkerPath,
  markBridgeRestart,
  persistLaunchArgv,
  readLaunchArgv,
  readCodeRevision,
  ProcessControlError,
  DEFAULT_LOG_LINES,
} from "../../process-control.js";
import { loadCliBase, type GlobalOptions } from "../context.js";
import {
  DEFAULT_AGENT,
  installHomeBootstrap,
  resolveConfig,
  resolveHomeDir,
  type BridgeRunFlags,
} from "../config/load.js";
import { parsePermissionOption } from "../options.js";
import { handoffLifecycle } from "../lifecycle.js";
import { CliError, formatError } from "../errors.js";

/** Non-zero exit tells the systemd supervisor to restart after graceful shutdown. */
const SUPERVISOR_RESTART_EXIT_CODE = 75;

interface BridgeRunCliOptions {
  readonly agent?: string;
  readonly cwd?: string;
  readonly unboundCwd?: string;
  readonly idleTimeout?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permission?: string;
  readonly requireMention?: boolean;
}

export interface RegisterBridgeCommandOptions {
  /** Absolute path of the built CLI entry (`dist/bin/humming.js`), used to spawn `bridge start` in the background. */
  readonly selfPath: string;
}

export function registerBridgeCommand(program: Command, opts: RegisterBridgeCommandOptions): void {
  const bridge = program.command("bridge").description("run and manage the Humming bridge process");
  registerBridgeActions(bridge, opts);
}

/** Register top-level shortcuts that share the canonical Bridge action handlers. */
export function registerBridgeShortcuts(
  program: Command,
  opts: RegisterBridgeCommandOptions,
): void {
  registerBridgeActions(program, opts);
}

function registerBridgeActions(parent: Command, opts: RegisterBridgeCommandOptions): void {
  addRunOptions(parent.command("run").description("run the bridge in the foreground"), true).action(
    async function (this: Command, rawAgentCommand: readonly string[]) {
      requireDoubleDashForRawCommand(this, rawAgentCommand);
      await runBridgeRun(
        this.optsWithGlobals<GlobalOptions & BridgeRunCliOptions>(),
        rawAgentCommand,
      );
    },
  );

  addRunOptions(parent.command("start").description("start the bridge in the background")).action(
    async function (this: Command) {
      await runBridgeStart(
        this.optsWithGlobals<GlobalOptions & BridgeRunCliOptions>(),
        opts.selfPath,
      );
    },
  );

  parent
    .command("stop")
    .description("stop the running bridge")
    .action(async function (this: Command) {
      await runBridgeStop(this.optsWithGlobals<GlobalOptions>());
    });

  addRunOptions(parent.command("restart").description("restart the running bridge")).action(
    async function (this: Command) {
      await runBridgeRestart(this.optsWithGlobals<GlobalOptions & BridgeRunCliOptions>());
    },
  );

  parent
    .command("status")
    .description("show whether the bridge is running")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions>();
      statusBridge({ homeDir: loadCliBase(globals).homeDir });
    });

  parent
    .command("logs")
    .description("tail the bridge log file")
    .option("-f, --follow", "keep streaming appended log lines")
    .option("-n, --lines <n>", "number of trailing lines to print first", parsePositiveInt)
    .action(async function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions & { follow?: boolean; lines?: number }>();
      await tailLog({
        homeDir: loadCliBase(globals).homeDir,
        follow: globals.follow ?? false,
        lines: globals.lines ?? DEFAULT_LOG_LINES,
      });
    });
}

function addRunOptions(cmd: Command, allowRawAgentCommand = false): Command {
  const configured = cmd
    .option("-a, --agent <id>", "Agent preset id or raw command")
    .option("-C, --cwd <path>", "default working directory for unbound chats")
    .option("--unbound-cwd <path>", "reception-area cwd for unbound chats (empty string disables)")
    .option(
      "--idle-timeout <minutes>",
      "idle timeout before a chat's session is dropped",
      parseNonNegInt,
    )
    .option("--max-chats <n>", "maximum concurrent chats", parsePositiveInt)
    .option("--hide-thoughts", "hide Agent thought/reasoning updates")
    .option("--hide-tools", "hide Agent tool-call updates")
    .option("--hide-cancel-button", "hide the in-chat cancel button")
    .option("-p, --permission <mode>", "default Humming approval-card policy")
    .option("--require-mention", "in groups, only respond to @-mentions")
    .option("--no-require-mention", "in groups, respond to all messages");
  return allowRawAgentCommand
    ? configured.argument(
        "[agentCommand...]",
        "explicit external Agent command, after `--` (bridge run only)",
      )
    : configured;
}

function parseNonNegInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`must be a non-negative integer (got: ${raw})`);
  }
  return n;
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`must be a positive integer (got: ${raw})`);
  return n;
}

/**
 * Enforce spec §4: the only positional pass-through is an explicit external
 * Agent command after `--`. Commander itself accepts trailing positional
 * tokens for the variadic `[agentCommand...]` argument whether or not `--`
 * was typed, so this closes that gap by requiring the literal separator.
 *
 * `rawArgs` is set by Commander at parse time but isn't part of its public
 * `.d.ts` surface; the shape is stable across Commander's own source, so this
 * is one narrow, documented structural cast rather than an unsafe `any`.
 *
 * @throws {CliError} when a raw agent command was captured without `--`.
 */
function requireDoubleDashForRawCommand(cmd: Command, rawAgentCommand: readonly string[]): void {
  if (rawAgentCommand.length === 0) return;
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  // `rawArgs` exists at runtime (Commander sets it in `_parseCommand`) but is
  // not part of the public `.d.ts` — one narrow, documented cast.
  const rawArgs = (root as unknown as { readonly rawArgs: readonly string[] }).rawArgs;
  if (!rawArgs.includes("--")) {
    throw new CliError(
      "a raw Agent command may only be passed after `--` (e.g. `humming bridge run -- node ./agent.js`)",
    );
  }
}

function toBridgeRunFlags(opts: BridgeRunCliOptions & GlobalOptions): BridgeRunFlags {
  return {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    ...(opts.unboundCwd !== undefined ? { unboundCwd: opts.unboundCwd } : {}),
    ...(opts.idleTimeout !== undefined ? { idleTimeout: opts.idleTimeout } : {}),
    ...(opts.maxChats !== undefined ? { maxChats: opts.maxChats } : {}),
    ...(opts.hideThoughts !== undefined ? { hideThoughts: opts.hideThoughts } : {}),
    ...(opts.hideTools !== undefined ? { hideTools: opts.hideTools } : {}),
    ...(opts.hideCancelButton !== undefined ? { hideCancelButton: opts.hideCancelButton } : {}),
    ...(opts.permission !== undefined
      ? { permission: parsePermissionOption(opts.permission) }
      : {}),
    ...(opts.requireMention !== undefined ? { requireMention: opts.requireMention } : {}),
  };
}

/**
 * Resolve the Agent invocation for `bridge run`/`start`/`restart`. Precedence:
 *   1. `--agent <preset>` (with any trailing `-- <extra args>`)
 *   2. an explicit raw command (`-- <cmd> [args...]`)
 *   3. settings.json `runtime.agent`
 *   4. the built-in {@link DEFAULT_AGENT} (`claude`)
 *
 * @throws {CliError} when `--agent` names an unknown preset, or
 *         `runtime.agent` cannot be resolved.
 */
function resolveBridgeAgent(
  selection: { readonly agent?: string },
  rawAgentCommand: readonly string[],
  registry: Registry,
  fallbackAgent: string | undefined,
): ResolvedAgentInvocation {
  if (selection.agent !== undefined) {
    const entry = resolveAgent(selection.agent, registry);
    return {
      command: entry.command,
      args: [...entry.args, ...rawAgentCommand],
      ...(entry.env ? { env: { ...entry.env } } : {}),
      label: entry.id ?? selection.agent,
    };
  }
  if (rawAgentCommand.length > 0) {
    const [command, ...cmdArgs] = rawAgentCommand;
    if (command === undefined) throw new CliError("internal: empty agent command");
    return { command, args: cmdArgs, label: `${command} ${cmdArgs.join(" ")}`.trimEnd() };
  }
  const fallback = fallbackAgent ?? DEFAULT_AGENT;
  try {
    const resolved = resolveAgent(fallback, registry);
    const label = resolved.id ?? `${resolved.command} ${resolved.args.join(" ")}`.trim();
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.env ? { env: { ...resolved.env } } : {}),
      label,
    };
  } catch (err) {
    throw new CliError(
      `settings.json runtime.agent "${fallback}" is invalid: ${formatError(err)}`,
      { cause: err },
    );
  }
}

/** Build the canonical `bridge run [flags...] [-- <agentCommand...>]` argv used to spawn/persist a background launch. */
export function buildBridgeRunArgv(
  globals: GlobalOptions,
  opts: BridgeRunCliOptions,
  rawAgentCommand: readonly string[],
): string[] {
  const argv: string[] = ["bridge", "run"];
  if (globals.home !== undefined) argv.push("--home", globals.home);
  if (globals.settingsPath !== undefined) argv.push("--settings-path", globals.settingsPath);
  if (globals.dataDir !== undefined) argv.push("--data-dir", globals.dataDir);
  if (opts.agent !== undefined) argv.push("--agent", opts.agent);
  if (opts.cwd !== undefined) argv.push("--cwd", opts.cwd);
  if (opts.unboundCwd !== undefined) argv.push("--unbound-cwd", opts.unboundCwd);
  if (opts.idleTimeout !== undefined) argv.push("--idle-timeout", String(opts.idleTimeout));
  if (opts.maxChats !== undefined) argv.push("--max-chats", String(opts.maxChats));
  if (opts.hideThoughts === true) argv.push("--hide-thoughts");
  if (opts.hideTools === true) argv.push("--hide-tools");
  if (opts.hideCancelButton === true) argv.push("--hide-cancel-button");
  if (opts.permission !== undefined) argv.push("--permission", opts.permission);
  if (opts.requireMention === true) argv.push("--require-mention");
  if (opts.requireMention === false) argv.push("--no-require-mention");
  if (rawAgentCommand.length > 0) argv.push("--", ...rawAgentCommand);
  return argv;
}

/** Whether any `bridge run`-affecting option or a raw agent command was explicitly supplied. */
export function hasExplicitBridgeRunOptions(
  opts: BridgeRunCliOptions,
  rawAgentCommand: readonly string[],
): boolean {
  return (
    rawAgentCommand.length > 0 ||
    opts.agent !== undefined ||
    opts.cwd !== undefined ||
    opts.unboundCwd !== undefined ||
    opts.idleTimeout !== undefined ||
    opts.maxChats !== undefined ||
    opts.hideThoughts !== undefined ||
    opts.hideTools !== undefined ||
    opts.hideCancelButton !== undefined ||
    opts.permission !== undefined ||
    opts.requireMention !== undefined
  );
}

function installCrashHandlers(opts: {
  readonly appId: string;
  readonly appSecret: string;
  readonly chatIds: readonly string[];
  readonly logger: LarkLogger;
}): { dispose(): void } {
  let handling = false;
  const crashLogger = opts.logger.child({ name: "crash" });
  const notify = async (kind: "uncaughtException" | "unhandledRejection", err: unknown) => {
    if (handling) return;
    handling = true;
    crashLogger.error({ err, kind }, "fatal unhandled bridge error");
    if (opts.chatIds.length > 0) {
      try {
        const http = new LarkHttpClient({
          appId: opts.appId,
          appSecret: opts.appSecret,
          logger: opts.logger,
        });
        await sendLifecycleNotice({
          http,
          chatIds: opts.chatIds,
          kind: "crashed",
          logger: opts.logger,
        });
      } catch (notifyErr) {
        crashLogger.error({ err: notifyErr }, "crash notification failed");
      }
    }
    process.exit(1);
  };
  const onUncaught = (err: Error) => void notify("uncaughtException", err);
  const onUnhandled = (reason: unknown) => void notify("unhandledRejection", reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  return {
    dispose(): void {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

async function runBridgeRun(
  globals: GlobalOptions & BridgeRunCliOptions,
  rawAgentCommand: readonly string[],
): Promise<void> {
  const rootLogger = createPinoLogger();
  const cliLogger: LarkLogger = rootLogger.child({ name: "cli" });

  const { homeDir, configPath } = installHomeBootstrap(globals);

  const base = loadCliBase(globals);
  const defaultAgent = resolveBridgeAgent(
    globals,
    rawAgentCommand,
    base.registry,
    base.file.runtime.agent,
  );

  const cfg = resolveConfig(toBridgeRunFlags(globals), configPath, homeDir, base.file);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  cliLogger.info(
    `config:      ${configPath}${fs.existsSync(configPath) ? "" : " (not found, using defaults)"}`,
  );
  cliLogger.info(`home:        ${homeDir}`);
  cliLogger.info(`credentials: ${cfg.credentialsSource}`);
  cliLogger.info(
    `agent:       ${defaultAgent.label} (${defaultAgent.command} ${defaultAgent.args.join(" ")})`.trimEnd(),
  );
  cliLogger.info(`default cwd: ${cfg.defaultCwd ?? "(none — chats must /bind)"}`);
  cliLogger.info(`data:        ${cfg.dataDir}`);
  cliLogger.info(`permission:  ${cfg.permissionMode}`);
  cliLogger.info(
    `group msgs:  ${cfg.groupRequireMention ? "@-mention required" : "respond to all"}`,
  );
  cliLogger.info(
    `unbound:     ${cfg.unboundCwd ? `reception area @ ${cfg.unboundCwd}` : "off (reply /bind notice)"}`,
  );
  cliLogger.info(
    `lifecycle:   ${cfg.lifecycleNotifyChatIds.length > 0 ? `notify ${cfg.lifecycleNotifyChatIds.length} chat(s)` : "off"}`,
  );

  const sessionStore = new FileSessionStore(cfg.dataDir);
  const bindingStore = new SettingsBindingStore(configPath);
  const notifyCrash = installCrashHandlers({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    chatIds: cfg.lifecycleNotifyChatIds,
    logger: rootLogger,
  });
  const codeRevision = readCodeRevision(path.dirname(fileURLToPath(import.meta.url)));

  let requestShutdown = (): void => {};
  let requestRestart = (): void => {};
  const bridge = new LarkBridge({
    lark: { appId: cfg.appId, appSecret: cfg.appSecret },
    agent: {
      resolver: (selection) =>
        resolveBridgeAgent({ agent: selection }, [], base.registry, undefined),
      availableAgents: [...base.registry.entries()]
        .map(([id, entry]) => ({
          id,
          label: entry.preset.label,
          ...(entry.preset.description !== undefined
            ? { description: entry.preset.description }
            : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      defaultAgent,
      defaultCwd: cfg.defaultCwd,
      showThoughts: cfg.showThoughts,
      showTools: cfg.showTools,
      showCancelButton: cfg.showCancelButton,
      permissionMode: cfg.permissionMode,
      ...(cfg.defaultControls !== undefined ? { defaultControls: cfg.defaultControls } : {}),
      idleStatusCardMs: cfg.idleStatusCardMs,
    },
    session: { idleTimeoutMs: cfg.idleTimeoutMs, maxConcurrentChats: cfg.maxChats },
    groupRequireMention: cfg.groupRequireMention,
    unboundCwd: cfg.unboundCwd,
    settingsPath: configPath,
    controlSocketPath: bridgeControlSocketPath(homeDir),
    onShutdownRequested: () => requestShutdown(),
    onRestartRequested: () => requestRestart(),
    globalDefaultControlChatIds: cfg.globalControlChatIds,
    lifecycle: {
      notificationChatIds: cfg.lifecycleNotifyChatIds,
      restartMarkerPath: bridgeRestartMarkerPath(homeDir),
      ...(codeRevision !== undefined ? { codeRevision } : {}),
    },
    sessionStore,
    bindingStore,
    logger: rootLogger,
  });

  let stopping = false;
  const shutdown = async (
    reason: NodeJS.Signals | "CONTROL" | "RESTART",
    exitCode = 0,
  ): Promise<void> => {
    if (stopping) return;
    stopping = true;
    cliLogger.info(`received ${reason}, stopping`);
    try {
      await bridge.stop();
    } catch (err) {
      cliLogger.error({ err: formatError(err) }, "error during shutdown");
    } finally {
      notifyCrash.dispose();
    }
    process.exit(exitCode);
  };
  requestShutdown = () => setImmediate(() => void shutdown("CONTROL"));
  requestRestart = () => {
    markBridgeRestart(homeDir);
    setImmediate(() => void shutdown("RESTART", SUPERVISOR_RESTART_EXIT_CODE));
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));

  await bridge.start();
  cliLogger.info("bridge running. Press Ctrl+C to stop.");
}

/**
 * The `start` handler: launch this CLI's own `bridge run` invocation in the
 * background, rebuilt from typed Commander options so every flag the user
 * passed to `start` is forwarded verbatim.
 *
 * @throws {ProcessControlError} on an already-running or failed start.
 */
async function runBridgeStart(
  globals: GlobalOptions & BridgeRunCliOptions,
  selfPath: string,
): Promise<void> {
  const homeDir = resolveHomeDir(globals.home);
  const spawnArgv = buildBridgeRunArgv(globals, globals, []);
  const workingDirectory = process.cwd();
  persistLaunchArgv(homeDir, spawnArgv, workingDirectory);
  await startBridge({ homeDir, selfPath, spawnArgv, workingDirectory });
}

async function runBridgeStop(globals: GlobalOptions): Promise<void> {
  const homeDir = resolveHomeDir(globals.home);
  const launch = readLaunchArgv(homeDir) ?? {
    spawnArgv: ["bridge", "run"],
    workingDirectory: process.cwd(),
    savedAt: new Date().toISOString(),
  };
  const transaction = handoffLifecycle(homeDir, "stop", launch);
  process.stdout.write(`bridge stop coordinator armed (${transaction.id})\n`);
}

/** The `restart` handler hands ownership to an independent coordinator. */
async function runBridgeRestart(globals: GlobalOptions & BridgeRunCliOptions): Promise<void> {
  const homeDir = resolveHomeDir(globals.home);
  if (hasExplicitBridgeRunOptions(globals, [])) {
    throw new ProcessControlError(
      "restart launch options are not supported by coordinated restart yet; " +
        "use `humming bridge stop` then `humming bridge start` with the new options",
    );
  }
  const launch = resolveRestartLaunch(globals);
  persistLaunchArgv(homeDir, launch.spawnArgv, launch.workingDirectory);
  const transaction = handoffLifecycle(homeDir, "restart", launch);
  process.stdout.write(`bridge restart coordinator armed (${transaction.id})\n`);
}

/**
 * Resolve the argv + working dir for a `restart`. A bare `restart` falls back
 * to the persisted launch descriptor so it doesn't forget flags from the
 * original `start`; when neither is available, argv is rebuilt fresh
 * (yielding a default `bridge run`).
 */
function resolveRestartLaunch(globals: GlobalOptions & BridgeRunCliOptions): {
  readonly spawnArgv: readonly string[];
  readonly workingDirectory: string;
} {
  const homeDir = resolveHomeDir(globals.home);
  const persisted = readLaunchArgv(homeDir);
  if (persisted !== null) {
    return { spawnArgv: persisted.spawnArgv, workingDirectory: persisted.workingDirectory };
  }
  return {
    spawnArgv: buildBridgeRunArgv(globals, globals, []),
    workingDirectory: process.cwd(),
  };
}
