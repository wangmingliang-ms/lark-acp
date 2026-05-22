#!/usr/bin/env node
/**
 * `lark-acp` — bridge a Feishu/Lark bot to any ACP-compatible AI agent.
 *
 * Synopsis:
 *
 *     lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
 *
 * The CLI is a thin wrapper around {@link LarkBridge}. It reads a
 * general config file (credentials + runtime defaults), merges in
 * environment variables and command-line overrides, then spawns the
 * agent subprocess specified after `proxy --` and pipes Feishu traffic
 * through it.
 *
 * Precedence (highest first):
 *
 *   1. CLI flags
 *   2. Environment variables (LARK_ACP_*)
 *   3. Config file (`config.json`)
 *   4. Built-in defaults
 *
 * See README.md for the full reference.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import {
  LarkBridge,
  FileSessionStore,
  BUILT_IN_AGENTS,
  resolveAgent,
  createPinoLogger,
} from "../src/index.js";
import type { LarkLogger } from "../src/index.js";

const VERSION = "0.4.0";

const APP_NAME = "lark-acp";
const CONFIG_FILE = "config.json";

const ENV_APP_ID = "LARK_ACP_APP_ID";
const ENV_APP_SECRET = "LARK_ACP_APP_SECRET";
const ENV_CONFIG = "LARK_ACP_CONFIG";
const ENV_DATA_DIR = "LARK_ACP_DATA_DIR";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 1440;
const DEFAULT_MAX_CHATS = 10;

// ---------- paths ---------------------------------------------------------

/** $XDG_CONFIG_HOME/lark-acp, falling back to ~/.config/lark-acp. */
function defaultConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".config", APP_NAME);
}

/** $XDG_DATA_HOME/lark-acp, falling back to ~/.local/share/lark-acp. */
function defaultDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".local", "share", APP_NAME);
}

function resolveConfigPath(override: string | undefined): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env[ENV_CONFIG];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(defaultConfigDir(), CONFIG_FILE);
}

function envDataDirOverride(): string | undefined {
  const fromEnv = process.env[ENV_DATA_DIR];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

// ---------- config file schema -------------------------------------------

type FileCredentials = {
  readonly appId?: string;
  readonly appSecret?: string;
};

type FileRuntime = {
  readonly cwd?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
};

type FileConfig = {
  readonly credentials: FileCredentials;
  readonly dataDir?: string;
  readonly runtime: FileRuntime;
};

const EMPTY_FILE_CONFIG: FileConfig = { credentials: {}, runtime: {} };

class CliError extends Error {}

function asStringOpt(label: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CliError(`config: ${label} must be a string`);
  return value;
}

function asBoolOpt(label: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CliError(`config: ${label} must be a boolean`);
  return value;
}

function asNonNegIntOpt(label: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliError(`config: ${label} must be a non-negative integer`);
  }
  return value;
}

function asPositiveIntOpt(label: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CliError(`config: ${label} must be a positive integer`);
  }
  return value;
}

function asObjectOpt(label: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`config: ${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Read and validate the JSON config file if present.
 *
 * @throws {CliError} when the file exists but is malformed.
 */
function readConfigFile(filePath: string): FileConfig {
  if (!fs.existsSync(filePath)) return EMPTY_FILE_CONFIG;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new CliError(`failed to read config file ${filePath}: ${formatError(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`config file ${filePath} is not valid JSON: ${formatError(err)}`);
  }
  const root = asObjectOpt("(root)", parsed);
  if (!root) throw new CliError(`config file ${filePath} must contain a JSON object`);

  const credentialsObj = asObjectOpt("credentials", root["credentials"]) ?? {};
  const runtimeObj = asObjectOpt("runtime", root["runtime"]) ?? {};

  const credentials: FileCredentials = {
    ...(asStringOpt("credentials.appId", credentialsObj["appId"]) !== undefined
      ? { appId: asStringOpt("credentials.appId", credentialsObj["appId"])! }
      : {}),
    ...(asStringOpt("credentials.appSecret", credentialsObj["appSecret"]) !== undefined
      ? { appSecret: asStringOpt("credentials.appSecret", credentialsObj["appSecret"])! }
      : {}),
  };

  const runtime: FileRuntime = {
    ...optStringField("runtime.cwd", runtimeObj["cwd"]),
    ...optNumberField(
      "runtime.idleTimeoutMinutes",
      asNonNegIntOpt("runtime.idleTimeoutMinutes", runtimeObj["idleTimeoutMinutes"]),
      "idleTimeoutMinutes",
    ),
    ...optNumberField(
      "runtime.maxChats",
      asPositiveIntOpt("runtime.maxChats", runtimeObj["maxChats"]),
      "maxChats",
    ),
    ...optBoolField("runtime.hideThoughts", runtimeObj["hideThoughts"]),
    ...optBoolField("runtime.hideTools", runtimeObj["hideTools"]),
    ...optBoolField("runtime.hideCancelButton", runtimeObj["hideCancelButton"]),
  };

  const dataDir = asStringOpt("dataDir", root["dataDir"]);

  return {
    credentials,
    ...(dataDir !== undefined ? { dataDir } : {}),
    runtime,
  };
}

function optStringField(label: string, value: unknown): Record<string, string> {
  const v = asStringOpt(label, value);
  if (v === undefined) return {};
  const key = label.split(".").pop() ?? label;
  return { [key]: v };
}

function optBoolField(label: string, value: unknown): Record<string, boolean> {
  const v = asBoolOpt(label, value);
  if (v === undefined) return {};
  const key = label.split(".").pop() ?? label;
  return { [key]: v };
}

function optNumberField(
  _label: string,
  value: number | undefined,
  key: string,
): Record<string, number> {
  if (value === undefined) return {};
  return { [key]: value };
}

// ---------- argv parsing --------------------------------------------------

type ParsedArgs = {
  readonly command: "proxy" | "agents" | "help" | "version";
  readonly agentPreset?: string;
  readonly agentCommand?: string;
  readonly agentArgs: readonly string[];
  readonly cwd?: string;
  readonly configPath?: string;
  readonly dataDir?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
};

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-v", "--version"]);

/**
 * Parse `process.argv.slice(2)` into a {@link ParsedArgs}.
 *
 * Global options come before the subcommand. Anything after `--` (which
 * must follow the `proxy` subcommand) is forwarded verbatim to the agent
 * process, so the agent's own flags are never consumed by this parser.
 *
 * @throws {CliError} when the input is structurally invalid.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let i = 0;
  let cwd: string | undefined;
  let configPath: string | undefined;
  let dataDir: string | undefined;
  let idleTimeoutMinutes: number | undefined;
  let maxChats: number | undefined;
  let hideThoughts: boolean | undefined;
  let hideTools: boolean | undefined;
  let hideCancelButton: boolean | undefined;
  let agentPreset: string | undefined;

  const takeValue = (flag: string): string => {
    const value = argv[++i];
    if (value === undefined || value.startsWith("-")) {
      throw new CliError(`option ${flag} requires a value`);
    }
    return value;
  };

  const parseInt = (flag: string, raw: string, allowZero: boolean): number => {
    const n = Number(raw);
    const lower = allowZero ? 0 : 1;
    if (!Number.isInteger(n) || n < lower) {
      throw new CliError(
        `${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer (got: ${raw})`,
      );
    }
    return n;
  };

  // ----- 1. global options + subcommand discovery -----
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;

    if (HELP_FLAGS.has(token)) return finalize("help");
    if (VERSION_FLAGS.has(token)) return finalize("version");

    if (token === "proxy") {
      i++;
      break;
    }
    if (token === "agents") return finalize("agents");
    if (token === "help") return finalize("help");
    if (token === "version") return finalize("version");

    switch (token) {
      case "--cwd":
        cwd = takeValue("--cwd");
        break;
      case "--config":
        configPath = takeValue("--config");
        break;
      case "--data-dir":
        dataDir = takeValue("--data-dir");
        break;
      case "--idle-timeout":
        idleTimeoutMinutes = parseInt("--idle-timeout", takeValue("--idle-timeout"), true);
        break;
      case "--max-chats":
        maxChats = parseInt("--max-chats", takeValue("--max-chats"), false);
        break;
      case "--hide-thoughts":
        hideThoughts = true;
        break;
      case "--hide-tools":
        hideTools = true;
        break;
      case "--hide-cancel-button":
        hideCancelButton = true;
        break;
      default:
        if (token.startsWith("-")) throw new CliError(`unknown option: ${token}`);
        throw new CliError(`unexpected positional argument before subcommand: ${token}`);
    }
    i++;
  }

  if (i === argv.length && !argv.includes("proxy")) return finalize("help");

  // ----- 2. proxy-local options (everything until `--` or end) -----
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;
    if (token === "--") break;
    if (!token.startsWith("-")) break; // first positional starts the agent command
    if (token === "--agent") {
      agentPreset = takeValue("--agent");
      i++;
      continue;
    }
    throw new CliError(
      `unknown option after \`proxy\`: ${token}` +
        " (global options must appear before `proxy`; agent flags must appear after `--`)",
    );
  }

  // ----- 3. agent command -----
  const sawDashDash = argv[i] === "--";
  if (sawDashDash) i++;
  const trailing = argv.slice(i);

  let agentCommand: string | undefined;
  let agentArgs: readonly string[];

  if (agentPreset !== undefined) {
    if (!sawDashDash && trailing.length > 0) {
      throw new CliError(
        "cannot combine --agent with a positional command; pass extra flags after `--`",
      );
    }
    const resolved = resolveAgent(agentPreset, BUILT_IN_AGENTS);
    if (resolved.source === "raw") {
      throw new CliError(
        `unknown agent preset: ${agentPreset} (run \`lark-acp agents\` to list presets)`,
      );
    }
    agentCommand = resolved.command;
    agentArgs = [...resolved.args, ...trailing];
  } else {
    agentCommand = trailing[0];
    if (!agentCommand) {
      throw new CliError(
        "proxy requires either --agent <preset> or a command after `--`. " +
          "Example: lark-acp proxy --agent claude",
      );
    }
    agentArgs = trailing.slice(1);
  }

  return finalize("proxy", agentCommand, agentArgs);

  function finalize(
    command: ParsedArgs["command"],
    agentCmd?: string,
    agentArgsList: readonly string[] = [],
  ): ParsedArgs {
    return {
      command,
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      ...(agentCmd !== undefined ? { agentCommand: agentCmd } : {}),
      agentArgs: agentArgsList,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(configPath !== undefined ? { configPath } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      ...(maxChats !== undefined ? { maxChats } : {}),
      ...(hideThoughts !== undefined ? { hideThoughts } : {}),
      ...(hideTools !== undefined ? { hideTools } : {}),
      ...(hideCancelButton !== undefined ? { hideCancelButton } : {}),
    };
  }
}

// ---------- effective config ---------------------------------------------

type EffectiveConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly credentialsSource: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly idleTimeoutMs: number;
  readonly maxChats: number;
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
};

/**
 * Merge file config, env vars, and CLI flags into a single resolved
 * config. Order of precedence is documented at the top of this file.
 *
 * @throws {CliError} when required fields (credentials, valid cwd) are
 *         missing or invalid.
 */
function resolveConfig(args: ParsedArgs, configPath: string): EffectiveConfig {
  const file = readConfigFile(configPath);

  // ----- credentials: env > file -----
  const envId = process.env[ENV_APP_ID];
  const envSecret = process.env[ENV_APP_SECRET];
  const appId = envId ?? file.credentials.appId;
  const appSecret = envSecret ?? file.credentials.appSecret;
  if (!appId || !appSecret) {
    const lines = [
      "Feishu credentials missing.",
      "",
      "Provide them via either:",
      `  • environment variables ${ENV_APP_ID} and ${ENV_APP_SECRET}`,
      `  • a JSON config file at ${configPath} of the form:`,
      `      { "credentials": { "appId": "cli_...", "appSecret": "..." } }`,
    ];
    throw new CliError(lines.join("\n"));
  }
  const idSource = envId ? `env:${ENV_APP_ID}` : `file:${configPath}`;
  const secretSource = envSecret ? `env:${ENV_APP_SECRET}` : `file:${configPath}`;
  const credentialsSource = idSource === secretSource ? idSource : `${idSource}+${secretSource}`;

  // ----- cwd: flag > file > process.cwd() -----
  const rawCwd = args.cwd ?? file.runtime.cwd ?? process.cwd();
  const cwd = path.resolve(rawCwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CliError(`cwd "${cwd}" is not a directory`);
  }

  // ----- dataDir: flag > env > file > XDG default -----
  const rawDataDir = args.dataDir ?? envDataDirOverride() ?? file.dataDir ?? defaultDataDir();
  const dataDir = path.resolve(rawDataDir);

  // ----- runtime knobs: flag > file > built-in default -----
  const idleTimeoutMinutes =
    args.idleTimeoutMinutes ?? file.runtime.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
  const maxChats = args.maxChats ?? file.runtime.maxChats ?? DEFAULT_MAX_CHATS;

  // The CLI flags are inverted from the LarkBridge option names — keep
  // the user-facing "hide-X" semantics here and flip once when handing
  // off to the bridge.
  const hideThoughts = args.hideThoughts ?? file.runtime.hideThoughts ?? false;
  const hideTools = args.hideTools ?? file.runtime.hideTools ?? false;
  const hideCancelButton = args.hideCancelButton ?? file.runtime.hideCancelButton ?? false;

  return {
    appId,
    appSecret,
    credentialsSource,
    cwd,
    dataDir,
    idleTimeoutMs: idleTimeoutMinutes * 60_000,
    maxChats,
    showThoughts: !hideThoughts,
    showTools: !hideTools,
    showCancelButton: !hideCancelButton,
  };
}

// ---------- output helpers -----------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function printVersion(): void {
  process.stdout.write(`${APP_NAME} v${VERSION}\n`);
}

function printHelp(): void {
  const presetIds = Object.keys(BUILT_IN_AGENTS).join(" | ");
  const lines = [
    `${APP_NAME} v${VERSION} — bridge Feishu/Lark to any ACP-compatible AI agent`,
    ``,
    `Usage:`,
    `  ${APP_NAME} [global-options] proxy --agent <preset> [-- <extra-args>...]`,
    `  ${APP_NAME} [global-options] proxy -- <agent-cmd> [agent-args]...`,
    `  ${APP_NAME} agents`,
    `  ${APP_NAME} help`,
    `  ${APP_NAME} version`,
    ``,
    `Global options (must appear BEFORE the proxy subcommand):`,
    `  --cwd <dir>            Working directory for the agent subprocess`,
    `  --config <path>        Override the config file path`,
    `                         (default: $XDG_CONFIG_HOME/${APP_NAME}/${CONFIG_FILE},`,
    `                          fallback ~/.config/${APP_NAME}/${CONFIG_FILE})`,
    `  --data-dir <dir>       Override the on-disk state directory`,
    `                         (default: $XDG_DATA_HOME/${APP_NAME},`,
    `                          fallback ~/.local/share/${APP_NAME})`,
    `  --idle-timeout <min>   Evict idle chats after N minutes (0 = never; default ${DEFAULT_IDLE_TIMEOUT_MINUTES})`,
    `  --max-chats <n>        Maximum concurrent chats (default ${DEFAULT_MAX_CHATS})`,
    `  --hide-thoughts        Skip agent_thought_chunk events in the unified card`,
    `  --hide-tools           Skip tool_call events in the unified card`,
    `  --hide-cancel-button   Don't render the in-card "interrupt" button`,
    `  -h, --help             Show this help and exit`,
    `  -v, --version          Show version and exit`,
    ``,
    `Subcommands:`,
    `  proxy                  Spawn an ACP agent subprocess and bridge it to Feishu/Lark.`,
    `    --agent <preset>     Use a built-in preset: ${presetIds}`,
    `    -- <cmd> [args...]   Or pass a raw command. Tokens after \`--\` are forwarded`,
    `                         verbatim, so the agent's own flags are never re-parsed.`,
    `                         Combined with --agent, extra tokens are appended to the`,
    `                         preset's args.`,
    `  agents                 List built-in agent presets and exit.`,
    ``,
    `Configuration file (${CONFIG_FILE}):`,
    `  {`,
    `    "credentials": { "appId": "cli_...", "appSecret": "..." },`,
    `    "dataDir": "./var/lark-acp",`,
    `    "runtime": {`,
    `      "cwd": "/work/project",`,
    `      "idleTimeoutMinutes": ${DEFAULT_IDLE_TIMEOUT_MINUTES},`,
    `      "maxChats": ${DEFAULT_MAX_CHATS},`,
    `      "hideThoughts": false,`,
    `      "hideTools": false,`,
    `      "hideCancelButton": false`,
    `    }`,
    `  }`,
    ``,
    `  All fields are optional. CLI flags override file values; env vars`,
    `  ${ENV_APP_ID} / ${ENV_APP_SECRET} override the credentials block.`,
    ``,
    `Examples:`,
    `  ${APP_NAME} proxy --agent claude`,
    `  ${APP_NAME} --cwd /work/project proxy --agent opencode`,
    `  ${APP_NAME} --hide-thoughts proxy --agent copilot`,
    `  ${APP_NAME} proxy -- node ./my-acp-server.js`,
    ``,
  ];
  process.stdout.write(lines.join("\n"));
}

function printAgents(): void {
  const lines = [`Built-in ACP agent presets:`, ``];
  const idColWidth = Math.max(...Object.keys(BUILT_IN_AGENTS).map((id) => id.length));
  for (const [id, preset] of Object.entries(BUILT_IN_AGENTS)) {
    const fullCmd = [preset.command, ...preset.args].join(" ");
    lines.push(`  ${id.padEnd(idColWidth)}  ${preset.label}`);
    if (preset.description) lines.push(`  ${" ".repeat(idColWidth)}  ${preset.description}`);
    lines.push(`  ${" ".repeat(idColWidth)}  $ ${fullCmd}`);
    lines.push("");
  }
  lines.push(`Use any of these with \`${APP_NAME} proxy --agent <id>\`.`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

// ---------- main ---------------------------------------------------------

async function runProxy(args: ParsedArgs): Promise<void> {
  if (!args.agentCommand) {
    throw new CliError("internal: runProxy called without an agent command");
  }

  const configPath = resolveConfigPath(args.configPath);
  const cfg = resolveConfig(args, configPath);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const rootLogger = createPinoLogger();
  const cliLogger: LarkLogger = rootLogger.child({ name: "cli" });

  cliLogger.info(
    `config:      ${configPath}${fs.existsSync(configPath) ? "" : " (not found, using defaults)"}`,
  );
  cliLogger.info(`credentials: ${cfg.credentialsSource}`);
  const agentLabel = args.agentPreset
    ? `${args.agentPreset} (${args.agentCommand} ${args.agentArgs.join(" ")})`
    : `${args.agentCommand} ${args.agentArgs.join(" ")}`;
  cliLogger.info(`agent:       ${agentLabel}`.trimEnd());
  cliLogger.info(`cwd:         ${cfg.cwd}`);
  cliLogger.info(`data:        ${cfg.dataDir}`);

  const sessionStore = new FileSessionStore(cfg.dataDir);

  const bridge = new LarkBridge({
    feishu: { appId: cfg.appId, appSecret: cfg.appSecret },
    agent: {
      command: args.agentCommand,
      args: [...args.agentArgs],
      cwd: cfg.cwd,
      showThoughts: cfg.showThoughts,
      showTools: cfg.showTools,
      showCancelButton: cfg.showCancelButton,
    },
    session: {
      idleTimeoutMs: cfg.idleTimeoutMs,
      maxConcurrentChats: cfg.maxChats,
    },
    sessionStore,
    logger: rootLogger,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    cliLogger.info(`received ${signal}, stopping`);
    try {
      await bridge.stop();
    } catch (err) {
      cliLogger.error({ err: formatError(err) }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));

  await bridge.start();
  cliLogger.info("bridge running. Press Ctrl+C to stop.");
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.stderr.write(`run \`${APP_NAME} --help\` for usage.\n`);
      process.exit(2);
    }
    throw err;
  }

  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
    case "agents":
      printAgents();
      return;
    case "proxy":
      await runProxy(args);
      return;
    default:
      assertNever(args.command);
  }
}

function assertNever(x: never): never {
  throw new Error(`unexpected command: ${String(x)}`);
}

main().catch((err) => {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`fatal: ${formatError(err)}\n`);
  process.exit(1);
});
