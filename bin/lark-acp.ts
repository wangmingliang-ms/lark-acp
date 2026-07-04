#!/usr/bin/env node
/**
 * `lark-acp` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Synopsis:
 *
 *     lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
 *
 * The CLI is a thin wrapper around {@link LarkBridge}. It reads a
 * general config file (credentials + runtime defaults), merges in
 * environment variables and command-line overrides, then spawns the
 * agent subprocess specified after `proxy --` and pipes Lark traffic
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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  LarkBridge,
  FileSessionStore,
  SettingsBindingStore,
  createPinoLogger,
  PERMISSION_MODES,
} from "../src/index.js";
import type {
  LarkLogger,
  PermissionMode,
  AgentResolver,
  ResolvedAgentInvocation,
} from "../src/index.js";
import {
  buildRegistry,
  resolveAgent,
  type Registry,
  type ResolvedAgent,
  type UserPresetPatch,
} from "./agents.js";
import {
  startBridge,
  stopBridge,
  statusBridge,
  tailLog,
  rewriteSubcommand,
  ProcessControlError,
  DEFAULT_LOG_LINES,
} from "./process-control.js";

/**
 * Package version for `--version` / help text. Resolved lazily and tolerantly:
 * the built CLI lives at `dist/bin/lark-acp.js` (package.json two levels up),
 * but when this module is imported from source (e.g. a vitest unit test) that
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

const VERSION = resolveVersion();

const APP_NAME = "lark-acp";
const CONFIG_FILE = "config.json";
const SETTINGS_FILE = "settings.json";
const HOME_DIR_NAME = ".lark-acp";

const ENV_APP_ID = "LARK_ACP_APP_ID";
const ENV_APP_SECRET = "LARK_ACP_APP_SECRET";
const ENV_CONFIG = "LARK_ACP_CONFIG";
const ENV_DATA_DIR = "LARK_ACP_DATA_DIR";
const ENV_HOME = "LARK_ACP_HOME";
const ENV_PERMISSION_MODE = "LARK_ACP_PERMISSION_MODE";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 1440;
const DEFAULT_MAX_CHATS = 10;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
/**
 * Agent used when neither `--agent` nor settings.json `runtime.agent` names one.
 * Makes a bare `lark-acp start` / `lark-acp proxy` work out-of-the-box on a
 * fresh machine (claude authenticates via the local `claude` CLI, no API key).
 */
const DEFAULT_AGENT = "claude";

// ---------- paths ---------------------------------------------------------

/**
 * The unified lark-acp home directory. Precedence:
 *   1. --home <dir>       (CLI, resolved by caller and passed in)
 *   2. $LARK_ACP_HOME
 *   3. ~/.lark-acp
 *
 * Everything lark-acp owns — settings.json, sessions.json, logs, inbox —
 * lives under here.
 */
function defaultHomeDir(): string {
  return path.join(os.homedir(), HOME_DIR_NAME);
}

function resolveHomeDir(override: string | undefined): string {
  if (override && override.length > 0) return path.resolve(override);
  const fromEnv = process.env[ENV_HOME];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return defaultHomeDir();
}

/** Legacy $XDG_CONFIG_HOME/lark-acp, falling back to ~/.config/lark-acp. */
function legacyConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".config", APP_NAME);
}

/** Legacy $XDG_DATA_HOME/lark-acp, falling back to ~/.local/share/lark-acp. */
function legacyDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".local", "share", APP_NAME);
}

/**
 * Resolve the settings file path. Precedence:
 *   1. --config <path> (override)
 *   2. $LARK_ACP_CONFIG
 *   3. <home>/settings.json
 */
function resolveSettingsPath(override: string | undefined, homeDir: string): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env[ENV_CONFIG];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(homeDir, SETTINGS_FILE);
}

/**
 * One-time migration of pre-`~/.lark-acp` installs. Only the real default home
 * (`~/.lark-acp`) is eligible for legacy migration; an explicit `--home` /
 * `$LARK_ACP_HOME` is treated as an isolated home and must not silently import
 * credentials/bindings from the user's legacy XDG paths.
 *
 * When `<home>/settings.json` is absent but the legacy `~/.config/lark-acp/
 * config.json` exists, compose a fresh settings.json (config fields + any
 * legacy bindings) and copy the legacy sessions file across. Non-destructive:
 * legacy files are left in place. Idempotent: skipped once settings.json exists.
 *
 * @throws {CliError} when legacy files exist but cannot be read/parsed.
 */
function migrateLegacyIfNeeded(homeDir: string, settingsPath: string, logger: LarkLogger): void {
  if (fs.existsSync(settingsPath)) return;
  if (path.resolve(homeDir) !== path.resolve(defaultHomeDir())) return;

  const legacyConfig = path.join(legacyConfigDir(), CONFIG_FILE);
  const legacyBindings = path.join(legacyDataDir(), "bindings.json");
  const legacySessions = path.join(legacyDataDir(), "sessions.json");
  if (!fs.existsSync(legacyConfig)) return; // nothing to migrate

  let configObj: Record<string, unknown>;
  try {
    configObj = JSON.parse(fs.readFileSync(legacyConfig, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(`failed to migrate legacy config ${legacyConfig}: ${formatError(err)}`);
  }

  // Fold legacy bindings.json into a `bindings` block in settings.json,
  // normalising each entry to the compact { cwd, agent } shape the new
  // SettingsBindingStore reads (old FileBindingStore stored a fat record).
  let bindings: Record<string, { cwd: string; agent?: string }> = {};
  if (fs.existsSync(legacyBindings)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyBindings, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [chatId, raw] of Object.entries(parsed as Record<string, unknown>)) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const rec = raw as Record<string, unknown>;
          const cwd = rec["cwd"];
          if (typeof cwd !== "string") continue;
          // Old shape stored the agent under `agentLabel`; new shape uses `agent`.
          const agent = rec["agent"] ?? rec["agentLabel"];
          bindings[chatId] = { cwd, ...(typeof agent === "string" ? { agent } : {}) };
        }
      }
    } catch {
      // Corrupt legacy bindings — start empty rather than abort migration.
      logger.warn("legacy bindings.json unreadable — migrating with empty bindings");
    }
  }

  const merged = { ...configObj, bindings };
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });

  const newSessions = path.join(homeDir, "sessions.json");
  if (fs.existsSync(legacySessions) && !fs.existsSync(newSessions)) {
    fs.copyFileSync(legacySessions, newSessions);
  }

  logger.info(`migrated legacy config into ${settingsPath} (old files left in place)`);
}

// ---------- config file schema -------------------------------------------

type FileCredentials = {
  readonly appId?: string;
  readonly appSecret?: string;
};

type FileRuntime = {
  readonly cwd?: string;
  /** Default agent (preset id or raw command) for chats with no `--agent`/`/bind`. */
  readonly agent?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly groupRequireMention?: boolean;
  readonly unboundCwd?: string;
};

type FileConfig = {
  readonly credentials: FileCredentials;
  readonly dataDir?: string;
  readonly runtime: FileRuntime;
  readonly agents: Readonly<Record<string, UserPresetPatch>>;
  /** chatId -> { cwd, agent } bindings, persisted in settings.json. */
  readonly bindings: Readonly<Record<string, StoredBinding>>;
};

/** One chat's persisted binding as stored in settings.json's `bindings` block. */
type StoredBinding = {
  readonly cwd: string;
  readonly agent?: string;
};

const EMPTY_FILE_CONFIG: FileConfig = { credentials: {}, runtime: {}, agents: {}, bindings: {} };

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

function asPermissionModeOpt(label: string, value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isPermissionMode(value)) {
    throw new CliError(`${label} must be one of: ${PERMISSION_MODES.join(" | ")}`);
  }
  return value;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
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

  const permissionMode = asPermissionModeOpt(
    "runtime.permissionMode",
    runtimeObj["permissionMode"],
  );

  const runtime: FileRuntime = {
    ...optStringField("runtime.cwd", runtimeObj["cwd"]),
    ...optStringField("runtime.agent", runtimeObj["agent"]),
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
    ...optBoolField("runtime.groupRequireMention", runtimeObj["groupRequireMention"]),
    ...optStringField("runtime.unboundCwd", runtimeObj["unboundCwd"]),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };

  const dataDir = asStringOpt("dataDir", root["dataDir"]);
  const agents = parseAgentsBlock(root["agents"]);
  const bindings = parseBindingsBlock(root["bindings"]);

  return {
    credentials,
    ...(dataDir !== undefined ? { dataDir } : {}),
    runtime,
    agents,
    bindings,
  };
}

/** Parse the `bindings` block: chatId -> { cwd, agent? }. Invalid entries throw. */
function parseBindingsBlock(value: unknown): Readonly<Record<string, StoredBinding>> {
  const obj = asObjectOpt("bindings", value);
  if (!obj) return {};
  const out: Record<string, StoredBinding> = {};
  for (const [chatId, raw] of Object.entries(obj)) {
    const entry = asObjectOpt(`bindings.${chatId}`, raw);
    if (!entry) continue;
    const cwd = asStringOpt(`bindings.${chatId}.cwd`, entry["cwd"]);
    if (cwd === undefined) {
      throw new CliError(`config: bindings.${chatId}.cwd is required`);
    }
    const agent = asStringOpt(`bindings.${chatId}.agent`, entry["agent"]);
    out[chatId] = { cwd, ...(agent !== undefined ? { agent } : {}) };
  }
  return out;
}

function parseAgentsBlock(value: unknown): Readonly<Record<string, UserPresetPatch>> {
  const obj = asObjectOpt("agents", value);
  if (!obj) return {};
  const out: Record<string, UserPresetPatch> = {};
  for (const [id, raw] of Object.entries(obj)) {
    const entry = asObjectOpt(`agents.${id}`, raw);
    if (!entry) continue;
    out[id] = parseAgentPatch(id, entry);
  }
  return out;
}

function parseAgentPatch(id: string, entry: Record<string, unknown>): UserPresetPatch {
  const label = asStringOpt(`agents.${id}.label`, entry["label"]);
  const command = asStringOpt(`agents.${id}.command`, entry["command"]);
  const description = asStringOpt(`agents.${id}.description`, entry["description"]);
  const args = parseAgentArgs(id, entry["args"]);
  const env = parseAgentEnv(id, entry["env"]);

  return {
    ...(label !== undefined ? { label } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

function parseAgentArgs(id: string, value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CliError(`config: agents.${id}.args must be an array of strings`);
  }
  return value.map((token, idx) => {
    if (typeof token !== "string") {
      throw new CliError(`config: agents.${id}.args[${idx}] must be a string`);
    }
    return token;
  });
}

function parseAgentEnv(id: string, value: unknown): Readonly<Record<string, string>> | undefined {
  const obj = asObjectOpt(`agents.${id}.env`, value);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val !== "string") {
      throw new CliError(`config: agents.${id}.env.${key} must be a string`);
    }
    out[key] = val;
  }
  return out;
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
  readonly command:
    "proxy" | "agents" | "help" | "version" | "start" | "stop" | "restart" | "status" | "logs";
  /** Preset id (`--agent <id>`); resolved against the registry in {@link runProxy}. */
  readonly agentPreset?: string;
  /** Raw command from `proxy -- <cmd>`; mutually exclusive with `agentPreset`. */
  readonly agentRawCommand?: string;
  /** Extra args: appended to the preset, or following the raw command. */
  readonly agentExtraArgs: readonly string[];
  readonly cwd?: string;
  readonly configPath?: string;
  readonly dataDir?: string;
  readonly home?: string;
  readonly unboundCwd?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly groupRequireMention?: boolean;
  /**
   * Full argv (as received) plus the index of the management subcommand token,
   * set only for `start` / `restart`. The handler swaps that token to `proxy`
   * and spawns it in the background — forwarding all options verbatim.
   */
  readonly rawArgv?: readonly string[];
  readonly subcommandIndex?: number;
  /** `logs --follow` / `-f`. */
  readonly logsFollow?: boolean;
  /** `logs -n <N>` — number of trailing lines. */
  readonly logsLines?: number;
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
  let home: string | undefined;
  let unboundCwd: string | undefined;
  let idleTimeoutMinutes: number | undefined;
  let maxChats: number | undefined;
  let hideThoughts: boolean | undefined;
  let hideTools: boolean | undefined;
  let hideCancelButton: boolean | undefined;
  let permissionMode: PermissionMode | undefined;
  let groupRequireMention: boolean | undefined;
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
    // Process-management subcommands. `start`/`restart` capture the full argv +
    // this token's index so the handler can re-launch it as `proxy …` in the
    // background, forwarding every option verbatim.
    if (token === "start")
      return finalize("start", undefined, [], { rawArgv: argv, subcommandIndex: i });
    if (token === "restart")
      return finalize("restart", undefined, [], { rawArgv: argv, subcommandIndex: i });
    if (token === "stop") return finalize("stop");
    if (token === "status") return finalize("status");
    if (token === "logs") return finalize("logs", undefined, [], parseLogsFlags(argv, i + 1));

    switch (token) {
      case "--cwd":
        cwd = takeValue("--cwd");
        break;
      case "--config":
        configPath = takeValue("--config");
        break;
      case "--home":
        home = takeValue("--home");
        break;
      case "--unbound-cwd":
        unboundCwd = takeValue("--unbound-cwd");
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
      case "--require-mention":
        groupRequireMention = true;
        break;
      case "--no-require-mention":
        groupRequireMention = false;
        break;
      case "--permission-mode": {
        const raw = takeValue("--permission-mode");
        if (!isPermissionMode(raw)) {
          throw new CliError(
            `--permission-mode must be one of: ${PERMISSION_MODES.join(" | ")} (got: ${raw})`,
          );
        }
        permissionMode = raw;
        break;
      }
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

  let agentRawCommand: string | undefined;
  let agentExtraArgs: readonly string[];

  if (agentPreset !== undefined) {
    if (!sawDashDash && trailing.length > 0) {
      throw new CliError(
        "cannot combine --agent with a positional command; pass extra flags after `--`",
      );
    }
    agentExtraArgs = trailing;
  } else {
    // No --agent and no `-- <cmd>`: leave the agent unset here. runProxy
    // resolves it from settings.json `runtime.agent`, then the built-in
    // default — so a bare `proxy` / `start` works with zero config on a fresh
    // machine. `trailing[0]` is undefined when nothing follows `--`.
    agentRawCommand = trailing[0];
    agentExtraArgs = trailing.slice(1);
  }

  return finalize("proxy", agentRawCommand, agentExtraArgs);

  function finalize(
    command: ParsedArgs["command"],
    agentRawCmd?: string,
    agentExtraList: readonly string[] = [],
    extra: {
      readonly rawArgv?: readonly string[];
      readonly subcommandIndex?: number;
      readonly logsFollow?: boolean;
      readonly logsLines?: number;
    } = {},
  ): ParsedArgs {
    return {
      command,
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      ...(agentRawCmd !== undefined ? { agentRawCommand: agentRawCmd } : {}),
      agentExtraArgs: agentExtraList,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(configPath !== undefined ? { configPath } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(home !== undefined ? { home } : {}),
      ...(unboundCwd !== undefined ? { unboundCwd } : {}),
      ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      ...(maxChats !== undefined ? { maxChats } : {}),
      ...(hideThoughts !== undefined ? { hideThoughts } : {}),
      ...(hideTools !== undefined ? { hideTools } : {}),
      ...(hideCancelButton !== undefined ? { hideCancelButton } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(groupRequireMention !== undefined ? { groupRequireMention } : {}),
      ...(extra.rawArgv !== undefined ? { rawArgv: extra.rawArgv } : {}),
      ...(extra.subcommandIndex !== undefined ? { subcommandIndex: extra.subcommandIndex } : {}),
      ...(extra.logsFollow !== undefined ? { logsFollow: extra.logsFollow } : {}),
      ...(extra.logsLines !== undefined ? { logsLines: extra.logsLines } : {}),
    };
  }
}

/**
 * Parse the trailing tokens of `logs` (`-f`/`--follow`, `-n <N>`) starting at
 * `start`. Unknown tokens are ignored so `logs` stays forgiving.
 *
 * @throws {CliError} when `-n` is missing or not a positive integer.
 */
function parseLogsFlags(
  argv: readonly string[],
  start: number,
): { readonly logsFollow: boolean; readonly logsLines: number } {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  let i = start;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "-f" || token === "--follow") {
      follow = true;
      i++;
      continue;
    }
    if (token === "-n" || token === "--lines") {
      const raw = argv[i + 1];
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliError(`${token} requires a positive integer (got: ${raw ?? "<none>"})`);
      }
      lines = n;
      i += 2;
      continue;
    }
    i++;
  }
  return { logsFollow: follow, logsLines: lines };
}

// ---------- effective config ---------------------------------------------

type EffectiveConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly credentialsSource: string;
  /** Default working dir for unbound chats; `null` = pure `/bind` mode. */
  readonly defaultCwd: string | null;
  readonly dataDir: string;
  readonly idleTimeoutMs: number;
  readonly maxChats: number;
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
  readonly permissionMode: PermissionMode;
  readonly groupRequireMention: boolean;
  /** Reception-area cwd for unbound chats (default = home dir; null disables). */
  readonly unboundCwd: string | null;
};

/**
 * Merge file config, env vars, and CLI flags into a single resolved
 * config. Order of precedence is documented at the top of this file.
 *
 * @throws {CliError} when required fields (credentials, valid cwd) are
 *         missing or invalid.
 */
function resolveConfig(
  args: ParsedArgs,
  configPath: string,
  homeDir: string,
  file: FileConfig,
): EffectiveConfig {
  // ----- credentials: env > file -----
  const envId = process.env[ENV_APP_ID];
  const envSecret = process.env[ENV_APP_SECRET];
  const appId = envId ?? file.credentials.appId;
  const appSecret = envSecret ?? file.credentials.appSecret;
  if (!appId || !appSecret) {
    const lines = [
      "Lark credentials missing.",
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

  // ----- default cwd: flag > file (optional — unset = pure /bind mode) -----
  // Unlike before, cwd is NOT required: a chat gets its cwd from /bind. A
  // configured default cwd only applies to chats with no explicit binding.
  const rawCwd = args.cwd ?? file.runtime.cwd ?? null;
  let defaultCwd: string | null = null;
  if (rawCwd !== null) {
    const resolved = path.resolve(rawCwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CliError(`cwd "${resolved}" is not a directory`);
    }
    defaultCwd = resolved;
  }

  // ----- dataDir: flag > env > file > XDG default -----
  // ----- dataDir: the home dir IS the data dir now. `--data-dir` and the
  //       legacy $LARK_ACP_DATA_DIR are honoured as home-dir overrides for
  //       backward compatibility; otherwise everything lives under homeDir. -----
  const legacyDataOverride = process.env[ENV_DATA_DIR];
  const rawDataDir =
    args.dataDir ??
    (legacyDataOverride && legacyDataOverride.length > 0 ? legacyDataOverride : undefined) ??
    file.dataDir ??
    homeDir;
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
  const groupRequireMention = args.groupRequireMention ?? file.runtime.groupRequireMention ?? false;

  // Reception area: default ON, cwd = home dir. Precedence: --unbound-cwd flag
  // > runtime.unboundCwd > home dir. An explicit empty string disables it
  // (restores the old "please /bind" notice for unbound chats).
  const rawUnbound = args.unboundCwd ?? file.runtime.unboundCwd;
  const expandTilde = (p: string): string =>
    p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const unboundCwd =
    rawUnbound === undefined
      ? homeDir
      : rawUnbound === ""
        ? null
        : path.resolve(expandTilde(rawUnbound));

  const envPermissionMode = process.env[ENV_PERMISSION_MODE];
  if (envPermissionMode !== undefined && !isPermissionMode(envPermissionMode)) {
    throw new CliError(
      `${ENV_PERMISSION_MODE} must be one of: ${PERMISSION_MODES.join(" | ")} (got: ${envPermissionMode})`,
    );
  }
  const permissionMode =
    args.permissionMode ??
    (envPermissionMode as PermissionMode | undefined) ??
    file.runtime.permissionMode ??
    DEFAULT_PERMISSION_MODE;

  return {
    appId,
    appSecret,
    credentialsSource,
    defaultCwd,
    dataDir,
    idleTimeoutMs: idleTimeoutMinutes * 60_000,
    maxChats,
    showThoughts: !hideThoughts,
    showTools: !hideTools,
    showCancelButton: !hideCancelButton,
    permissionMode,
    groupRequireMention,
    unboundCwd,
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
  const presetIds = Array.from(buildRegistry().keys()).join(" | ");
  const lines = [
    `${APP_NAME} v${VERSION} — bridge Lark to any ACP-compatible AI agent`,
    ``,
    `Usage:`,
    `  ${APP_NAME} [global-options] proxy [--agent <preset>] [-- <extra-args>...]`,
    `  ${APP_NAME} [global-options] proxy -- <agent-cmd> [agent-args]...`,
    `  ${APP_NAME} [global-options] start [--agent <preset>]   (run proxy in background)`,
    `  ${APP_NAME} [global-options] stop | restart | status`,
    `  ${APP_NAME} logs [-f] [-n <lines>]`,
    `  ${APP_NAME} agents`,
    `  ${APP_NAME} help`,
    `  ${APP_NAME} version`,
    ``,
    `Global options (must appear BEFORE the proxy subcommand):`,
    `  --cwd <dir>            DEFAULT working directory for chats with no`,
    `                         explicit /bind. Optional — when omitted, each`,
    `                         chat must bind its own repo via /bind first.`,
    `  --unbound-cwd <dir>    Reception-area dir for unbound chats — the agent`,
    `                         runs here so you can bind by natural language`,
    `                         ("bind me to X using codex"). Default: the home`,
    `                         dir. Pass "" to disable (reply a /bind notice).`,
    `  --home <dir>           lark-acp home directory holding settings.json,`,
    `                         sessions, logs. (default: $LARK_ACP_HOME, else`,
    `                         ~/.lark-acp). Created on startup if missing.`,
    `  --config <path>        Override the settings file path`,
    `                         (default: <home>/${SETTINGS_FILE})`,
    `  --data-dir <dir>       Deprecated alias — overrides the home/state dir`,
    `                         (kept for backward compatibility with old installs)`,
    `  --idle-timeout <min>   Evict idle chats after N minutes (0 = never; default ${DEFAULT_IDLE_TIMEOUT_MINUTES})`,
    `  --max-chats <n>        Maximum concurrent chats (default ${DEFAULT_MAX_CHATS})`,
    `  --hide-thoughts        Skip agent_thought_chunk events in output posts`,
    `  --hide-tools           Skip tool_call events in output posts`,
    `  --hide-cancel-button   Compatibility flag for legacy card output`,
    `  --permission-mode <m>  How to handle agent permission requests:`,
    `                         ${PERMISSION_MODES.join(" | ")} (default ${DEFAULT_PERMISSION_MODE})`,
    `  -h, --help             Show this help and exit`,
    `  -v, --version          Show version and exit`,
    ``,
    `Subcommands:`,
    `  proxy                  Spawn an ACP agent subprocess and bridge it to Lark.`,
    `    --agent <preset>     Use a built-in preset: ${presetIds}`,
    `                         Optional — defaults to settings.json runtime.agent,`,
    `                         else the built-in \`${DEFAULT_AGENT}\`. So a bare`,
    `                         \`${APP_NAME} proxy\` / \`${APP_NAME} start\` just works.`,
    `    -- <cmd> [args...]   Or pass a raw command. Tokens after \`--\` are forwarded`,
    `                         verbatim, so the agent's own flags are never re-parsed.`,
    `                         Combined with --agent, extra tokens are appended to the`,
    `                         preset's args.`,
    `  agents                 List built-in agent presets and exit.`,
    ``,
    `Process management (run the bridge in the background; cross-platform):`,
    `  start                  Launch \`proxy\` (same options) in the background.`,
    `                         On Linux/WSL uses systemd user service when`,
    `                         available, so closing the terminal does not stop it.`,
    `                         Records PID under home and logs to <home>/bridge.log.`,
    `  stop                   Stop the background bridge (SIGTERM, then SIGKILL).`,
    `  restart                Stop, then start again with the same options.`,
    `  status                 Show whether the bridge is running (PID + uptime).`,
    `  logs [-f] [-n <lines>] Print the tail of bridge.log; -f follows output,`,
    `                         -n sets how many trailing lines (default ${DEFAULT_LOG_LINES}).`,
    ``,
    `Settings file (${SETTINGS_FILE}, under the home dir):`,
    `  {`,
    `    "credentials": { "appId": "cli_...", "appSecret": "..." },`,
    `    "dataDir": "./var/lark-acp",`,
    `    "runtime": {`,
    `      "cwd": "/work/project",`,
    `      "agent": "claude",`,
    `      "idleTimeoutMinutes": ${DEFAULT_IDLE_TIMEOUT_MINUTES},`,
    `      "maxChats": ${DEFAULT_MAX_CHATS},`,
    `      "hideThoughts": false,`,
    `      "hideTools": false,`,
    `      "hideCancelButton": false,`,
    `      "permissionMode": "${DEFAULT_PERMISSION_MODE}"`,
    `    },`,
    `    "agents": {`,
    `      "my-claude": {`,
    `        "label": "Claude (custom)",`,
    `        "command": "npx",`,
    `        "args": ["-y", "@zed-industries/claude-code-acp"],`,
    `        "env": { "ANTHROPIC_API_KEY": "..." }`,
    `      },`,
    `      "claude": { "env": { "ANTHROPIC_BASE_URL": "https://..." } }`,
    `    }`,
    `  }`,
    ``,
    `  All fields are optional. CLI flags override file values; env vars`,
    `  ${ENV_APP_ID} / ${ENV_APP_SECRET} override the credentials block;`,
    `  ${ENV_PERMISSION_MODE} overrides runtime.permissionMode.`,
    `  Entries under "agents" with a built-in id patch that preset; new ids`,
    `  add user presets and must define both \`label\` and \`command\`.`,
    ``,
    `Examples:`,
    `  ${APP_NAME} proxy --agent claude`,
    `  ${APP_NAME} start --agent claude          # run in the background`,
    `  ${APP_NAME} status                        # is it up? which PID?`,
    `  ${APP_NAME} logs -f                        # follow the log`,
    `  ${APP_NAME} restart --agent claude        # pick up a new build`,
    `  ${APP_NAME} stop`,
    `  ${APP_NAME} --cwd /work/project proxy --agent opencode`,
    `  ${APP_NAME} --hide-thoughts proxy --agent copilot`,
    `  ${APP_NAME} --permission-mode alwaysAllow proxy --agent claude`,
    `  ${APP_NAME} proxy -- node ./my-acp-server.js`,
    ``,
    `In-chat commands (one Lark bot → many repos):`,
    `  /bind <path> [agent]   Bind THIS chat to a repo dir + agent (agent`,
    `                         defaults to the one passed via --agent).`,
    `                         e.g. /bind ~/workspace/copilot-intellij claude`,
    `  /where                 Show this chat's current binding.`,
    `  /unbind                Remove this chat's binding.`,
    `  /new                   Start a fresh agent session for this chat.`,
    `  /cancel                Cancel the in-flight agent turn.`,
    ``,
  ];
  process.stdout.write(lines.join("\n"));
}

const SOURCE_TAG: Record<"built-in" | "user" | "overridden", string> = {
  "built-in": "[built-in]",
  user: "[user]",
  overridden: "[overridden]",
};

function printAgents(registry: Registry): void {
  const lines = [`ACP agent presets:`, ``];
  const idColWidth = Math.max(...Array.from(registry.keys(), (id) => id.length));
  for (const [id, entry] of registry) {
    const { preset, source } = entry;
    const fullCmd = [preset.command, ...preset.args].join(" ");
    lines.push(`  ${id.padEnd(idColWidth)}  ${preset.label} ${SOURCE_TAG[source]}`);
    if (preset.description) lines.push(`  ${" ".repeat(idColWidth)}  ${preset.description}`);
    lines.push(`  ${" ".repeat(idColWidth)}  $ ${fullCmd}`);
    lines.push("");
  }
  lines.push(`Use any of these with \`${APP_NAME} proxy --agent <id>\`.`);
  lines.push(`Add or override entries via the \`agents\` field of ${CONFIG_FILE}.`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

// ---------- main ---------------------------------------------------------

/**
 * Build the {@link AgentResolver} the bridge uses to turn a `/bind` agent
 * selection (preset id or raw command) into a concrete invocation.
 */
function makeAgentResolver(registry: Registry): AgentResolver {
  return (selection: string): ResolvedAgentInvocation => {
    // resolveAgent throws on an empty/blank selection — that surfaces to the
    // user as a "bind failed" card, which is the right feedback.
    const resolved = resolveAgent(selection, registry);
    const label = resolved.id ?? `${resolved.command} ${resolved.args.join(" ")}`.trim();
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.env ? { env: { ...resolved.env } } : {}),
      label,
    };
  };
}

/**
 * Resolve the default agent invocation — the agent used for chats with no
 * explicit `/bind`, and the fallback when `/bind <path>` names no agent.
 *
 * Precedence:
 *   1. CLI `--agent <preset>` (with any extra args after it)
 *   2. CLI raw command (`proxy -- <cmd> [args]`)
 *   3. settings.json `runtime.agent` (a preset id or a raw command string)
 *   4. built-in {@link DEFAULT_AGENT} (`claude`)
 *
 * Steps 3–4 let a bare `lark-acp start` / `lark-acp proxy` work out-of-the-box
 * — no `--agent` required — which is what a fresh-machine install expects.
 *
 * @throws {CliError} when `--agent` names an unknown preset, or when the
 *         settings.json `runtime.agent` string cannot be resolved.
 */
function resolveDefaultAgent(
  args: ParsedArgs,
  registry: Registry,
  fallbackAgent: string | undefined,
): ResolvedAgentInvocation {
  if (args.agentPreset !== undefined) {
    const entry = registry.get(args.agentPreset);
    if (!entry) {
      throw new CliError(
        `unknown agent preset: ${args.agentPreset} (run \`lark-acp agents\` to list presets)`,
      );
    }
    const combinedArgs = [...entry.preset.args, ...args.agentExtraArgs];
    return {
      command: entry.preset.command,
      args: combinedArgs,
      ...(entry.preset.env ? { env: { ...entry.preset.env } } : {}),
      label: args.agentPreset,
    };
  }
  if (args.agentRawCommand !== undefined) {
    const command = args.agentRawCommand;
    const cmdArgs = [...args.agentExtraArgs];
    return {
      command,
      args: cmdArgs,
      label: `${command} ${cmdArgs.join(" ")}`.trimEnd(),
    };
  }
  // No agent on the CLI — fall back to settings.json `runtime.agent`, then to
  // the built-in default. Resolve the selection string (preset id or raw
  // command) the same way `/bind` does.
  const selection = fallbackAgent ?? DEFAULT_AGENT;
  let resolved: ResolvedAgent;
  try {
    resolved = resolveAgent(selection, registry);
  } catch (err) {
    throw new CliError(
      `settings.json runtime.agent "${selection}" is invalid: ${formatError(err)}`,
      { cause: err },
    );
  }
  const label = resolved.id ?? `${resolved.command} ${resolved.args.join(" ")}`.trim();
  return {
    command: resolved.command,
    args: resolved.args,
    ...(resolved.env ? { env: { ...resolved.env } } : {}),
    label,
  };
}

async function runProxy(args: ParsedArgs): Promise<void> {
  const homeDir = resolveHomeDir(args.home);
  fs.mkdirSync(homeDir, { recursive: true });

  const rootLogger = createPinoLogger();
  const cliLogger: LarkLogger = rootLogger.child({ name: "cli" });

  const configPath = resolveSettingsPath(args.configPath, homeDir);
  // Migrate a pre-~/.lark-acp install into settings.json before reading it.
  migrateLegacyIfNeeded(homeDir, configPath, cliLogger);

  const file = readConfigFile(configPath);
  const registry = buildRegistry(file.agents);
  const resolver = makeAgentResolver(registry);
  const defaultAgent = resolveDefaultAgent(args, registry, file.runtime.agent);

  const cfg = resolveConfig(args, configPath, homeDir, file);
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

  const sessionStore = new FileSessionStore(cfg.dataDir);
  // Bindings live in settings.json's `bindings` block (one file for all
  // state). Resolve each binding's agent selection via the registry, falling
  // back to the CLI default agent when a binding names none.
  const bindingStore = new SettingsBindingStore(configPath, (agentSelection) => {
    const inv = agentSelection ? resolver(agentSelection) : defaultAgent;
    return {
      agentLabel: inv.label,
      agentCommand: inv.command,
      agentArgs: inv.args,
      ...(inv.env ? { agentEnv: inv.env } : {}),
    };
  });

  const bridge = new LarkBridge({
    lark: { appId: cfg.appId, appSecret: cfg.appSecret },
    agent: {
      resolver,
      defaultAgent,
      defaultCwd: cfg.defaultCwd,
      showThoughts: cfg.showThoughts,
      showTools: cfg.showTools,
      showCancelButton: cfg.showCancelButton,
      permissionMode: cfg.permissionMode,
    },
    session: {
      idleTimeoutMs: cfg.idleTimeoutMs,
      maxConcurrentChats: cfg.maxChats,
    },
    groupRequireMention: cfg.groupRequireMention,
    unboundCwd: cfg.unboundCwd,
    settingsPath: configPath,
    sessionStore,
    bindingStore,
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

/**
 * The `start` handler: re-launch this CLI's own `proxy` command in the
 * background. `args.rawArgv` + `args.subcommandIndex` are set by the parser;
 * we swap the `start` token to `proxy` so every option the user passed is
 * forwarded verbatim to the backgrounded process.
 *
 * @throws {ProcessControlError} on an already-running or failed start.
 * @throws {CliError} when parser invariants are somehow violated.
 */
async function runStart(args: ParsedArgs): Promise<void> {
  const spawnArgv = buildProxyArgv(args);
  await startBridge({
    homeDir: resolveHomeDir(args.home),
    selfPath: fileURLToPath(import.meta.url),
    spawnArgv,
    workingDirectory: process.cwd(),
  });
}

/** The `restart` handler: stop any running bridge, then start with the same argv. */
async function runRestart(args: ParsedArgs): Promise<void> {
  const spawnArgv = buildProxyArgv(args);
  const homeDir = resolveHomeDir(args.home);
  await stopBridge({ homeDir });
  await startBridge({
    homeDir,
    selfPath: fileURLToPath(import.meta.url),
    spawnArgv,
    workingDirectory: process.cwd(),
  });
}

/**
 * Turn a `start`/`restart` invocation into the `proxy` argv to background.
 *
 * @throws {CliError} when the parser did not record the raw argv + index
 *         (should be unreachable — both are set together for start/restart).
 */
function buildProxyArgv(args: ParsedArgs): string[] {
  if (args.rawArgv === undefined || args.subcommandIndex === undefined) {
    throw new CliError(`internal: ${args.command} is missing captured argv`);
  }
  return rewriteSubcommand(args.rawArgv, args.subcommandIndex, "proxy");
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
    case "agents": {
      const homeDir = resolveHomeDir(args.home);
      const configPath = resolveSettingsPath(args.configPath, homeDir);
      const file = readConfigFile(configPath);
      printAgents(buildRegistry(file.agents));
      return;
    }
    case "proxy":
      await runProxy(args);
      return;
    case "start":
      await runStart(args);
      return;
    case "stop":
      await stopBridge({ homeDir: resolveHomeDir(args.home) });
      return;
    case "restart":
      await runRestart(args);
      return;
    case "status":
      statusBridge({ homeDir: resolveHomeDir(args.home) });
      return;
    case "logs":
      await tailLog({
        homeDir: resolveHomeDir(args.home),
        follow: args.logsFollow ?? false,
        lines: args.logsLines ?? DEFAULT_LOG_LINES,
      });
      return;
    default:
      assertNever(args.command);
  }
}

function assertNever(x: never): never {
  throw new Error(`unexpected command: ${String(x)}`);
}

/**
 * True when this module is the process entry point (run as `lark-acp …`),
 * false when it's imported (e.g. by a vitest unit test). Lets the file export
 * its pure helpers for testing without auto-running {@link main}. Symlinks are
 * resolved on both sides so a global-bin install (which runs through a symlink)
 * still matches.
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
  main().catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof ProcessControlError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`fatal: ${formatError(err)}\n`);
    process.exit(1);
  });
}

// Exported for unit tests (bin/lark-acp.test.ts). Not part of any public API —
// the package's only entry points are the `bin` scripts and `src/index.ts`.
export {
  parseArgs,
  resolveDefaultAgent,
  readConfigFile,
  migrateLegacyIfNeeded,
  resolveHomeDir,
  DEFAULT_AGENT,
};
export type { ParsedArgs };
