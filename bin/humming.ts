#!/usr/bin/env node
/**
 * `humming` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Synopsis:
 *
 *     humming [global-options] proxy -- <agent-cmd> [agent-args...]
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
 *   2. Environment variables (HUMMING_*)
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
  listAgentSessions,
  probeAgentSessionCapabilities,
} from "../src/index.js";
import { installHomeTemplates } from "../src/home-templates.js";
import type {
  LarkLogger,
  PermissionMode,
  SessionControls,
  AgentResolver,
  ResolvedAgentInvocation,
  SessionRecord,
} from "../src/index.js";
import { sendControlRequest } from "../src/bridge/control-server.js";
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
  bridgeControlSocketPath,
  bridgeRestartMarkerPath,
  markBridgeRestart,
  clearBridgeRestartMarker,
  rewriteSubcommand,
  ProcessControlError,
  DEFAULT_LOG_LINES,
} from "./process-control.js";

/**
 * Package version for `--version` / help text. Resolved lazily and tolerantly:
 * the built CLI lives at `dist/bin/humming.js` (package.json two levels up),
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

const APP_NAME = "humming";
const CONFIG_FILE = "config.json";
const SETTINGS_FILE = "settings.json";
const HOME_DIR_NAME = ".humming";
const PREVIOUS_HOME_DIR_NAME = ".lark-acp";
const PREVIOUS_APP_NAME = "lark-acp";

const ENV_APP_ID = "HUMMING_APP_ID";
const ENV_APP_SECRET = "HUMMING_APP_SECRET";
const ENV_CONFIG = "HUMMING_CONFIG";
const ENV_DATA_DIR = "HUMMING_DATA_DIR";
const ENV_HOME = "HUMMING_HOME";
const ENV_PERMISSION_MODE = "HUMMING_PERMISSION_MODE";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 1440;
const DEFAULT_MAX_CHATS = 10;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
/**
 * Agent used when neither `--agent` nor settings.json `runtime.agent` names one.
 * Makes a bare `humming start` / `humming proxy` work out-of-the-box on a
 * fresh machine (claude authenticates via the local `claude` CLI, no API key).
 */
const DEFAULT_AGENT = "claude";

// ---------- paths ---------------------------------------------------------

/**
 * The unified humming home directory. Precedence:
 *   1. --home <dir>       (CLI, resolved by caller and passed in)
 *   2. $HUMMING_HOME
 *   3. ~/.humming
 *
 * Everything humming owns — settings.json, sessions.json, logs, inbox —
 * lives under here.
 */
function defaultHomeDir(): string {
  return path.join(os.homedir(), HOME_DIR_NAME);
}

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveHomeDir(override: string | undefined): string {
  if (override && override.length > 0) return path.resolve(override);
  const fromEnv = process.env[ENV_HOME];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return defaultHomeDir();
}

/** Legacy $XDG_CONFIG_HOME/humming, falling back to ~/.config/humming. */
function legacyConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".config", APP_NAME);
}

/** Legacy $XDG_DATA_HOME/humming, falling back to ~/.local/share/humming. */
function legacyDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".local", "share", APP_NAME);
}

/** Previous-brand unified home, used only for one-time state migration. */
function previousHomeDir(): string {
  return path.join(os.homedir(), PREVIOUS_HOME_DIR_NAME);
}

/** Previous-brand XDG config dir, used only for one-time state migration. */
function previousConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, PREVIOUS_APP_NAME);
  return path.join(os.homedir(), ".config", PREVIOUS_APP_NAME);
}

/** Previous-brand XDG data dir, used only for one-time state migration. */
function previousDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, PREVIOUS_APP_NAME);
  return path.join(os.homedir(), ".local", "share", PREVIOUS_APP_NAME);
}

/**
 * Resolve the settings file path. Precedence:
 *   1. --config <path> (override)
 *   2. $HUMMING_CONFIG
 *   3. <home>/settings.json
 */
function resolveSettingsPath(override: string | undefined, homeDir: string): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env[ENV_CONFIG];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(homeDir, SETTINGS_FILE);
}

/**
 * One-time migration of pre-`~/.humming` installs. Only the real default home
 * (`~/.humming`) is eligible for legacy migration; an explicit `--home` /
 * `$HUMMING_HOME` is treated as an isolated home and must not silently import
 * credentials/bindings from legacy paths.
 *
 * When `<home>/settings.json` is absent, import the previous-brand unified
 * home if present, else import pre-unified XDG config/data. Non-destructive:
 * legacy files are left in place. Idempotent: skipped once settings.json exists.
 *
 * @throws {CliError} when legacy files exist but cannot be read/parsed.
 */
function migrateLegacyIfNeeded(homeDir: string, settingsPath: string, logger: LarkLogger): void {
  if (fs.existsSync(settingsPath)) return;
  if (path.resolve(homeDir) !== path.resolve(defaultHomeDir())) return;

  if (migratePreviousHomeIfNeeded(homeDir, settingsPath, logger)) return;

  const legacyConfig = firstExistingPath(
    path.join(legacyConfigDir(), CONFIG_FILE),
    path.join(previousConfigDir(), CONFIG_FILE),
  );
  const legacyBindings = firstExistingPath(
    path.join(legacyDataDir(), "bindings.json"),
    path.join(previousDataDir(), "bindings.json"),
  );
  const legacySessions = firstExistingPath(
    path.join(legacyDataDir(), "sessions.json"),
    path.join(previousDataDir(), "sessions.json"),
  );
  if (!fs.existsSync(legacyConfig)) return; // nothing to migrate

  let configObj: Record<string, unknown>;
  try {
    configObj = JSON.parse(fs.readFileSync(legacyConfig, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(`failed to migrate legacy config ${legacyConfig}: ${formatError(err)}`);
  }

  // Fold legacy bindings.json into a `bindings` block in settings.json,
  // normalising each entry to the compact { cwd } shape the new
  // SettingsBindingStore reads (old FileBindingStore stored a fat record).
  let bindings: Record<string, { cwd: string }> = {};
  if (fs.existsSync(legacyBindings)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyBindings, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [chatId, raw] of Object.entries(parsed as Record<string, unknown>)) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const rec = raw as Record<string, unknown>;
          const cwd = rec["cwd"];
          if (typeof cwd !== "string") continue;
          bindings[chatId] = { cwd };
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

function migratePreviousHomeIfNeeded(
  homeDir: string,
  settingsPath: string,
  logger: LarkLogger,
): boolean {
  const oldHome = previousHomeDir();
  const oldSettings = path.join(oldHome, SETTINGS_FILE);
  if (!fs.existsSync(oldSettings)) return false;

  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(oldSettings, settingsPath);

  const oldSessions = path.join(oldHome, "sessions.json");
  const newSessions = path.join(homeDir, "sessions.json");
  if (fs.existsSync(oldSessions) && !fs.existsSync(newSessions)) {
    fs.copyFileSync(oldSessions, newSessions);
  }

  logger.info(`migrated previous home into ${homeDir} (old files left in place)`);
  return true;
}

function firstExistingPath(...paths: readonly string[]): string {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? paths[0]!;
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
  readonly lifecycleNotifyChatIds?: readonly string[];
};

type FileConfig = {
  readonly credentials: FileCredentials;
  readonly dataDir?: string;
  readonly runtime: FileRuntime;
  readonly agents: Readonly<Record<string, UserPresetPatch>>;
  /** chatId -> { cwd } bindings, persisted in settings.json. */
  readonly bindings: Readonly<Record<string, StoredBinding>>;
};

/** One chat's persisted binding as stored in settings.json's `bindings` block. */
type StoredBinding = {
  readonly cwd: string;
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
    ...optStringArrayField("runtime.lifecycleNotifyChatIds", runtimeObj["lifecycleNotifyChatIds"]),
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

/** Parse the `bindings` block: chatId -> { cwd }. Invalid entries throw. */
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
    out[chatId] = { cwd };
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

function optStringArrayField(label: string, value: unknown): Record<string, readonly string[]> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new CliError(`config: ${label} must be an array of strings`);
  const parsed: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") throw new CliError(`config: ${label}[${index}] must be a string`);
    parsed.push(item);
  });
  const key = label.split(".").pop() ?? label;
  return { [key]: parsed };
}

// ---------- argv parsing --------------------------------------------------

type ParsedArgs = {
  readonly command:
    | "proxy"
    | "agents"
    | "help"
    | "version"
    | "start"
    | "stop"
    | "restart"
    | "status"
    | "logs"
    | "control"
    | "sessions"
    | "init";
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
  readonly controlAction?: "capabilities" | "agent-capabilities";
  readonly sessionsAction?: "set-control" | "list" | "bind" | "set-agent";
  readonly targetChatId?: string;
  readonly targetThreadId?: string | null;
  readonly targetCwd?: string;
  readonly targetAgent?: string;
  readonly targetSessionId?: string;
  readonly controlJson?: string | boolean;
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
    if (token === "init") return finalize("init");
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
    if (token === "control")
      return finalize("control", undefined, [], parseControlFlags(argv, i + 1));
    if (token === "sessions")
      return finalize("sessions", undefined, [], parseSessionsFlags(argv, i + 1));

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
      readonly controlAction?: "capabilities" | "agent-capabilities";
      readonly sessionsAction?: "set-control" | "list" | "bind" | "set-agent";
      readonly targetChatId?: string;
      readonly targetThreadId?: string | null;
      readonly targetCwd?: string;
      readonly targetAgent?: string;
      readonly targetSessionId?: string;
      readonly controlJson?: string | boolean;
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
      ...(extra.controlAction !== undefined ? { controlAction: extra.controlAction } : {}),
      ...(extra.sessionsAction !== undefined ? { sessionsAction: extra.sessionsAction } : {}),
      ...(extra.targetChatId !== undefined ? { targetChatId: extra.targetChatId } : {}),
      ...(extra.targetThreadId !== undefined ? { targetThreadId: extra.targetThreadId } : {}),
      ...(extra.targetCwd !== undefined ? { targetCwd: extra.targetCwd } : {}),
      ...(extra.targetAgent !== undefined ? { targetAgent: extra.targetAgent } : {}),
      ...(extra.targetSessionId !== undefined ? { targetSessionId: extra.targetSessionId } : {}),
      ...(extra.controlJson !== undefined ? { controlJson: extra.controlJson } : {}),
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

function parseControlFlags(
  argv: readonly string[],
  start: number,
): {
  readonly controlAction: "capabilities" | "agent-capabilities";
  readonly targetChatId?: string;
  readonly targetThreadId?: string | null;
  readonly targetCwd?: string;
  readonly targetAgent?: string;
  readonly controlJson?: string | boolean;
} {
  const action = argv[start];
  if (action !== "capabilities" && action !== "agent-capabilities") {
    throw new CliError("control requires subcommand: capabilities | agent-capabilities");
  }
  const parsed = parseTargetFlags(argv, start + 1);
  if (action === "capabilities") {
    const chatId = parsed.chatId;
    if (!chatId) throw new CliError("control capabilities requires --chat-id <id>");
    return {
      controlAction: "capabilities",
      targetChatId: chatId,
      ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
      ...(parsed.json !== undefined ? { controlJson: parsed.json } : {}),
    };
  }
  return {
    controlAction: "agent-capabilities",
    ...(parsed.chatId !== undefined ? { targetChatId: parsed.chatId } : {}),
    ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
    ...(parsed.cwd !== undefined ? { targetCwd: parsed.cwd } : {}),
    ...(parsed.agent !== undefined ? { targetAgent: parsed.agent } : {}),
    ...(parsed.json !== undefined ? { controlJson: parsed.json } : {}),
  };
}

function parseSessionsFlags(
  argv: readonly string[],
  start: number,
): {
  readonly sessionsAction: "set-control" | "list" | "bind" | "set-agent";
  readonly targetChatId?: string;
  readonly targetThreadId?: string | null;
  readonly targetCwd?: string;
  readonly targetAgent?: string;
  readonly targetSessionId?: string;
  readonly controlJson?: string | boolean;
} {
  const action = argv[start];
  if (
    action !== "set-control" &&
    action !== "list" &&
    action !== "bind" &&
    action !== "set-agent"
  ) {
    throw new CliError("sessions requires subcommand: set-control | set-agent | list | bind");
  }
  const parsed = parseTargetFlags(argv, start + 1);
  if (action === "set-agent") {
    if (!parsed.chatId) throw new CliError("sessions set-agent requires --chat-id <id>");
    if (!parsed.agent) throw new CliError("sessions set-agent requires --agent <preset>");
    if (parsed.cwd !== undefined) {
      throw new CliError(
        "sessions set-agent does not accept --cwd; it only switches the current chat repo",
      );
    }
    if (parsed.json !== undefined) {
      throw new CliError(
        "sessions set-agent does not accept --json; switch the Agent first, then use sessions set-control with ids from the new agent's capabilities",
      );
    }
    return {
      sessionsAction: "set-agent",
      targetChatId: parsed.chatId,
      ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
      targetAgent: parsed.agent,
    };
  }
  if (action === "set-control") {
    if (!parsed.chatId) throw new CliError("sessions set-control requires --chat-id <id>");
    if (typeof parsed.json !== "string")
      throw new CliError("sessions set-control requires --json <json>");
    return {
      sessionsAction: "set-control",
      targetChatId: parsed.chatId,
      ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
      controlJson: parsed.json,
    };
  }
  if (action === "list") {
    return {
      sessionsAction: "list",
      ...(parsed.chatId !== undefined ? { targetChatId: parsed.chatId } : {}),
      ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
      ...(parsed.cwd !== undefined ? { targetCwd: parsed.cwd } : {}),
      ...(parsed.agent !== undefined ? { targetAgent: parsed.agent } : {}),
      ...(parsed.json !== undefined ? { controlJson: parsed.json } : {}),
    };
  }

  if (!parsed.chatId) throw new CliError("sessions bind requires --chat-id <id>");
  if (!parsed.sessionId) throw new CliError("sessions bind requires --session-id <id>");
  if (parsed.cwd !== undefined) {
    throw new CliError(
      "sessions bind does not accept --cwd; it only binds sessions from the current chat repo",
    );
  }
  return {
    sessionsAction: "bind",
    targetChatId: parsed.chatId,
    ...(parsed.threadId !== undefined ? { targetThreadId: parsed.threadId } : {}),
    ...(parsed.agent !== undefined ? { targetAgent: parsed.agent } : {}),
    targetSessionId: parsed.sessionId,
    ...(parsed.json !== undefined && typeof parsed.json === "string"
      ? { controlJson: parsed.json }
      : {}),
  };
}

function parseTargetFlags(
  argv: readonly string[],
  start: number,
): {
  readonly chatId?: string;
  readonly threadId?: string | null;
  readonly cwd?: string;
  readonly agent?: string;
  readonly sessionId?: string;
  readonly json?: string | boolean;
} {
  let chatId: string | undefined;
  let threadId: string | null | undefined;
  let cwd: string | undefined;
  let agent: string | undefined;
  let sessionId: string | undefined;
  let json: string | boolean | undefined;
  let i = start;
  while (i < argv.length) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--chat-id") {
      if (value === undefined) throw new CliError("--chat-id requires a value");
      chatId = value;
      i += 2;
      continue;
    }
    if (token === "--thread-id") {
      if (value === undefined) throw new CliError("--thread-id requires a value");
      threadId = value === "" || value === "null" || value === "<main>" ? null : value;
      i += 2;
      continue;
    }
    if (token === "--cwd") {
      if (value === undefined) throw new CliError("--cwd requires a value");
      cwd = value;
      i += 2;
      continue;
    }
    if (token === "--agent") {
      if (value === undefined) throw new CliError("--agent requires a value");
      agent = value;
      i += 2;
      continue;
    }
    if (token === "--session-id") {
      if (value === undefined) throw new CliError("--session-id requires a value");
      sessionId = value;
      i += 2;
      continue;
    }
    if (token === "--json") {
      if (value === undefined || value.startsWith("--")) {
        json = true;
        i += 1;
      } else {
        json = value;
        i += 2;
      }
      continue;
    }
    throw new CliError(`unknown control option: ${token ?? "<none>"}`);
  }
  return {
    ...(chatId !== undefined ? { chatId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(json !== undefined ? { json } : {}),
  };
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
  readonly lifecycleNotifyChatIds: readonly string[];
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
  //       legacy $HUMMING_DATA_DIR are honoured as home-dir overrides for
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
  const lifecycleNotifyChatIds = file.runtime.lifecycleNotifyChatIds ?? [];

  // Reception area: default ON, cwd = home dir. Precedence: --unbound-cwd flag
  // > runtime.unboundCwd > home dir. An explicit empty string disables it
  // (restores the old "please /bind" notice for unbound chats).
  const rawUnbound = args.unboundCwd ?? file.runtime.unboundCwd;
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
    lifecycleNotifyChatIds,
    unboundCwd,
  };
}

// ---------- output helpers -----------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const SILENT_LOGGER: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return SILENT_LOGGER;
  },
};

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
    `  ${APP_NAME} [global-options] init                       (seed home templates)`,
    `  ${APP_NAME} [global-options] stop | restart | status`,
    `  ${APP_NAME} logs [-f] [-n <lines>]`,
    `  ${APP_NAME} control capabilities --chat-id <id> [--thread-id <id>] [--json]`,
    `  ${APP_NAME} control agent-capabilities [--chat-id <id>] [--thread-id <id>] [--agent <preset>] [--cwd <dir>] [--json]`,
    `  ${APP_NAME} sessions list [--chat-id <id>] [--thread-id <id>] [--agent <preset>] [--cwd <dir>] [--json]`,
    `  ${APP_NAME} sessions bind --chat-id <id> [--thread-id <id>] [--agent <preset>] --session-id <id>`,
    `  ${APP_NAME} sessions set-agent --chat-id <id> [--thread-id <id>] --agent <preset>`,
    `  ${APP_NAME} sessions set-control --chat-id <id> [--thread-id <id>] --json '<controls>'`,
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
    `  --home <dir>           humming home directory holding settings.json,`,
    `                         sessions, logs. (default: $HUMMING_HOME, else`,
    `                         ~/.humming). Created on startup if missing.`,
    `  --config <path>        Override the settings file path`,
    `                         (default: <home>/${SETTINGS_FILE})`,
    `  --data-dir <dir>       Deprecated alias — overrides the home/state dir`,
    `                         (kept for backward compatibility with old installs)`,
    `  --idle-timeout <min>   Evict idle chats after N minutes (0 = never; default ${DEFAULT_IDLE_TIMEOUT_MINUTES})`,
    `  --max-chats <n>        Maximum concurrent chats (default ${DEFAULT_MAX_CHATS})`,
    `  --hide-thoughts        Skip agent_thought_chunk events in the unified card`,
    `  --hide-tools           Skip tool_call events in the unified card`,
    `  --hide-cancel-button   Don't render the in-card "interrupt" button`,
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
    `  init                   Create/update humming home templates and examples:`,
    `                         AGENTS.md, CLAUDE.md, settings.back.json, sessions.back.json.`,
    `                         Does NOT create live settings.json or sessions.json.`,
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
    `Session controls (live bridge required):`,
    `  control capabilities --chat-id <id> [--thread-id <id>] [--json]`,
    `                         Print live ACP session capabilities: models, modes,`,
    `                         configOptions, plus bridgePermissionModes.`,
    `  control agent-capabilities [--chat-id <id>] [--thread-id <id>] [--agent <preset>] [--cwd <dir>] [--json]`,
    `                         Start a short-lived probe session for the selected`,
    `                         agent and print its model/mode/config capabilities`,
    `                         without changing the current topic session.`,
    `  sessions set-control --chat-id <id> [--thread-id <id>] --json '<controls>'`,
    `                         Persist controls to sessions.json and apply them to`,
    `                         the live runtime when present. The controls JSON uses`,
    `                         ACP-shaped fields: modelId, modeId, config, plus`,
    `                         humming bridgePermissionMode.`,
    `  sessions set-agent --chat-id <id> [--thread-id <id>] --agent <preset>`,
    `                         Switch the current topic's Agent profile. This drops`,
    `                         the old topic session binding; the next message starts`,
    `                         a fresh ACP session with the selected agent.`,
    `  sessions list [--chat-id <id>] [--thread-id <id>] [--agent <preset>] [--cwd <dir>] [--json]`,
    `                         List existing ACP agent sessions. --cwd is allowed`,
    `                         for host/reception queries; otherwise cwd defaults`,
    `                         to the current chat binding, then runtime.cwd.`,
    `  sessions bind --chat-id <id> [--thread-id <id>] [--agent <preset>] --session-id <id>`,
    `                         Bind the current topic to an existing session in`,
    `                         the current chat repo. --cwd is intentionally not`,
    `                         accepted; bind never changes chat binding or crosses repos.`,
    ``,
    `Settings file (${SETTINGS_FILE}, under the home dir):`,
    `  {`,
    `    "credentials": { "appId": "cli_...", "appSecret": "..." },`,
    `    "dataDir": "./var/humming",`,
    `    "runtime": {`,
    `      "cwd": "/work/project",`,
    `      "agent": "claude",`,
    `      "idleTimeoutMinutes": ${DEFAULT_IDLE_TIMEOUT_MINUTES},`,
    `      "maxChats": ${DEFAULT_MAX_CHATS},`,
    `      "hideThoughts": false,`,
    `      "hideTools": false,`,
    `      "hideCancelButton": false,`,
    `      "permissionMode": "${DEFAULT_PERMISSION_MODE}",`,
    `      "lifecycleNotifyChatIds": ["oc_..."]`,
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
    `  ${APP_NAME} init                          # seed home guide + example JSON`,
    `  ${APP_NAME} proxy --agent claude`,
    `  ${APP_NAME} start --agent claude          # run in the background`,
    `  ${APP_NAME} status                        # is it up? which PID?`,
    `  ${APP_NAME} logs -f                        # follow the log`,
    `  ${APP_NAME} restart --agent claude        # pick up a new build`,
    `  ${APP_NAME} stop`,
    `  ${APP_NAME} --cwd /work/project proxy --agent opencode`,
    `  ${APP_NAME} --hide-thoughts proxy --agent copilot`,
    `  ${APP_NAME} --permission-mode alwaysAllow proxy --agent claude`,
    `  ${APP_NAME} control agent-capabilities --chat-id "$HUMMING_CHAT_ID" --agent copilot --json`,
    `  ${APP_NAME} sessions set-agent --chat-id "$HUMMING_CHAT_ID" --thread-id "$HUMMING_THREAD_ID" --agent copilot`,
    `  ${APP_NAME} sessions list --chat-id "$HUMMING_CHAT_ID" --agent claude --json`,
    `  ${APP_NAME} sessions list --agent codex --cwd /work/project --json`,
    `  ${APP_NAME} sessions bind --chat-id "$HUMMING_CHAT_ID" --thread-id "$HUMMING_THREAD_ID" --agent claude --session-id <id>`,
    `  ${APP_NAME} proxy -- node ./my-acp-server.js`,
    ``,
    `In-chat commands (one Lark bot → many repos):`,
    `  /bind <path>           Bind THIS chat to a repo dir. Agent belongs to`,
    `                         the topic/session profile, not the chat binding.`,
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

function parseControlJson(raw: string): SessionControls {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`invalid --json controls: ${formatError(err)}`);
  }
  return validateSessionControls(parsed);
}

function validateSessionControls(value: unknown): SessionControls {
  if (!isRecord(value)) throw new CliError("controls JSON must be an object");
  const out: {
    modelId?: string;
    modeId?: string;
    bridgePermissionMode?: PermissionMode;
    config?: Record<
      string,
      { readonly type: "boolean"; readonly value: boolean } | { readonly value: string }
    >;
  } = {};

  const modelId = value["modelId"];
  if (modelId !== undefined) {
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new CliError("controls.modelId must be a non-empty string");
    }
    out.modelId = modelId;
  }

  const modeId = value["modeId"];
  if (modeId !== undefined) {
    if (typeof modeId !== "string" || modeId.length === 0) {
      throw new CliError("controls.modeId must be a non-empty string");
    }
    out.modeId = modeId;
  }

  const bridgePermissionMode = value["bridgePermissionMode"];
  if (bridgePermissionMode !== undefined) {
    if (typeof bridgePermissionMode !== "string" || !isPermissionMode(bridgePermissionMode)) {
      throw new CliError(
        `controls.bridgePermissionMode must be one of: ${PERMISSION_MODES.join(" | ")}`,
      );
    }
    out.bridgePermissionMode = bridgePermissionMode;
  }

  const config = value["config"];
  if (config !== undefined) {
    if (!isRecord(config))
      throw new CliError("controls.config must be an object keyed by configId");
    const parsedConfig: Record<
      string,
      { readonly type: "boolean"; readonly value: boolean } | { readonly value: string }
    > = {};
    for (const [configId, rawValue] of Object.entries(config)) {
      if (!isRecord(rawValue)) throw new CliError(`controls.config.${configId} must be an object`);
      const type = rawValue["type"];
      const optionValue = rawValue["value"];
      if (type === "boolean") {
        if (typeof optionValue !== "boolean") {
          throw new CliError(`controls.config.${configId}.value must be a boolean`);
        }
        parsedConfig[configId] = { type: "boolean", value: optionValue };
        continue;
      }
      // ACP select config requests are `{ configId, sessionId, value: <valueId> }`
      // with no `type` field. For convenience, tolerate `type: "select"` in CLI
      // input but do not persist it.
      if (type !== undefined && type !== "select") {
        throw new CliError(`controls.config.${configId}.type must be "boolean" or "select"`);
      }
      if (typeof optionValue !== "string" || optionValue.length === 0) {
        throw new CliError(`controls.config.${configId}.value must be a non-empty string`);
      }
      parsedConfig[configId] = { value: optionValue };
    }
    out.config = parsedConfig;
  }

  if (
    out.modelId === undefined &&
    out.modeId === undefined &&
    out.bridgePermissionMode === undefined &&
    out.config === undefined
  ) {
    throw new CliError("controls JSON must contain at least one control field");
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runControl(args: ParsedArgs): Promise<void> {
  if (args.controlAction === "agent-capabilities") {
    await runAgentCapabilities(args);
    return;
  }
  if (args.controlAction !== "capabilities") {
    throw new CliError("control requires subcommand: capabilities | agent-capabilities");
  }
  const chatId = args.targetChatId;
  if (!chatId) throw new CliError("control capabilities requires --chat-id <id>");
  const homeDir = resolveHomeDir(args.home);
  const response = await sendControlRequest(bridgeControlSocketPath(homeDir), {
    method: "capabilities",
    params: { chatId, threadId: args.targetThreadId ?? null },
  });
  if (!response.ok) throw new CliError(response.error);
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
}

async function runAgentCapabilities(args: ParsedArgs): Promise<void> {
  const target = resolveSessionTargetContext(args);
  const result = await probeAgentSessionCapabilities({
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
    env: target.invocation.env ? { ...target.invocation.env } : undefined,
    logger: SILENT_LOGGER,
  });
  const payload = {
    session: {
      ...(target.chatId !== undefined ? { chatId: target.chatId } : {}),
      threadId: target.threadId,
      sessionId: result.sessionId,
    },
    agent: {
      label: target.invocation.label,
      command: target.invocation.command,
      args: target.invocation.args,
      cwd: target.cwd,
    },
    ...result.capabilities,
    bridgePermissionModes: PERMISSION_MODES,
    bridgePermissionMode:
      args.permissionMode ?? target.file.runtime.permissionMode ?? DEFAULT_PERMISSION_MODE,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveStateDir(args: ParsedArgs, file: FileConfig, homeDir: string): string {
  const legacyDataOverride = process.env[ENV_DATA_DIR];
  const rawDataDir =
    args.dataDir ??
    (legacyDataOverride && legacyDataOverride.length > 0 ? legacyDataOverride : undefined) ??
    file.dataDir ??
    homeDir;
  return path.resolve(rawDataDir);
}

function resolveSessionTargetContext(args: ParsedArgs): {
  readonly homeDir: string;
  readonly dataDir: string;
  readonly configPath: string;
  readonly file: FileConfig;
  readonly registry: Registry;
  readonly chatId: string | undefined;
  readonly threadId: string | null;
  readonly cwd: string;
  readonly invocation: ResolvedAgentInvocation;
} {
  const homeDir = resolveHomeDir(args.home);
  const configPath = resolveSettingsPath(args.configPath, homeDir);
  const file = readConfigFile(configPath);
  const dataDir = resolveStateDir(args, file, homeDir);
  const registry = buildRegistry(file.agents);
  const chatId = args.targetChatId;
  const threadId = args.targetThreadId ?? null;
  const binding = chatId ? file.bindings[chatId] : undefined;
  const rawCwd = args.targetCwd ?? args.cwd ?? binding?.cwd ?? file.runtime.cwd;
  if (!rawCwd) {
    throw new CliError(
      "no cwd available; pass --cwd for sessions list, or bind the current chat to a repo first",
    );
  }
  const cwd = path.resolve(expandTilde(rawCwd));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CliError(`cwd "${cwd}" is not a directory`);
  }
  const selection = args.targetAgent ?? file.runtime.agent ?? DEFAULT_AGENT;
  const invocation = makeAgentResolver(registry)(selection);
  return { homeDir, dataDir, configPath, file, registry, chatId, threadId, cwd, invocation };
}

async function runSessionList(args: ParsedArgs): Promise<void> {
  const target = resolveSessionTargetContext(args);
  const result = await listAgentSessions({
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
    env: target.invocation.env ? { ...target.invocation.env } : undefined,
    logger: SILENT_LOGGER,
  });
  const payload = {
    agent: target.invocation.label,
    cwd: target.cwd,
    supportsResume: result.supportsResume,
    supportsLoad: result.supportsLoad,
    sessions: result.sessions,
  };
  if (args.controlJson !== undefined) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const lines = [`Agent sessions for ${target.invocation.label} in ${target.cwd}:`, ""];
  if (result.sessions.length === 0) lines.push("  (none)");
  for (const s of result.sessions) {
    lines.push(`  • ${s.title ?? "Untitled session"}`);
    lines.push(`    sessionId: ${s.sessionId}`);
    if (s.updatedAt) lines.push(`    updatedAt: ${s.updatedAt}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

async function runSessionBind(args: ParsedArgs): Promise<void> {
  if (!args.targetChatId) throw new CliError("sessions bind requires --chat-id <id>");
  if (!args.targetSessionId) throw new CliError("sessions bind requires --session-id <id>");
  const target = resolveSessionTargetContext(args);
  if (!target.chatId) throw new CliError("sessions bind requires --chat-id <id>");
  const result = await listAgentSessions({
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
    env: target.invocation.env ? { ...target.invocation.env } : undefined,
    logger: SILENT_LOGGER,
  });
  if (!result.supportsResume && !result.supportsLoad) {
    throw new CliError(
      "agent can list sessions but does not support ACP session/resume or session/load",
    );
  }
  const session = result.sessions.find((s) => s.sessionId === args.targetSessionId);
  if (!session) {
    throw new CliError("session-id was not found in the current chat repo for this agent");
  }
  if (path.resolve(session.cwd) !== path.resolve(target.cwd)) {
    throw new CliError(
      `refusing to bind a session outside the current chat repo: session cwd=${session.cwd}, current repo=${target.cwd}`,
    );
  }
  const now = Date.now();
  const record: SessionRecord = {
    chatId: target.chatId,
    threadId: target.threadId,
    sessionId: session.sessionId,
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.updatedAt !== undefined ? { sessionUpdatedAt: session.updatedAt } : {}),
    agentCommand: target.invocation.command,
    agentArgs: [...target.invocation.args],
    ...(target.invocation.env ? { agentEnv: { ...target.invocation.env } } : {}),
    agentLabel: target.invocation.label,
    cwd: target.cwd,
    createdAt: now,
    updatedAt: now,
  };

  let response;
  try {
    response = await sendControlRequest(bridgeControlSocketPath(target.homeDir), {
      method: "bindSession",
      params: { record },
    });
  } catch {
    const store = new FileSessionStore(target.dataDir);
    await store.init();
    try {
      await store.bindThreadSession(record);
    } finally {
      await store.close();
    }
    response = { ok: true as const, result: { bound: true, sessionId: record.sessionId } };
  }
  if (!response.ok) throw new CliError(response.error);
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
}

async function runSessionSetAgent(args: ParsedArgs): Promise<void> {
  if (!args.targetChatId) throw new CliError("sessions set-agent requires --chat-id <id>");
  if (!args.targetAgent) throw new CliError("sessions set-agent requires --agent <preset>");
  const target = resolveSessionTargetContext(args);
  if (!target.chatId) throw new CliError("sessions set-agent requires --chat-id <id>");
  const now = Date.now();
  const record: SessionRecord = {
    chatId: target.chatId,
    threadId: target.threadId,
    sessionId: `profile:${now}`,
    profileOnly: true,
    agentCommand: target.invocation.command,
    agentArgs: [...target.invocation.args],
    ...(target.invocation.env ? { agentEnv: { ...target.invocation.env } } : {}),
    agentLabel: target.invocation.label,
    cwd: target.cwd,
    createdAt: now,
    updatedAt: now,
  };

  let response;
  try {
    response = await sendControlRequest(bridgeControlSocketPath(target.homeDir), {
      method: "setAgent",
      params: { record },
    });
  } catch {
    const store = new FileSessionStore(target.dataDir);
    await store.init();
    try {
      await store.clearThread(record.chatId, record.threadId);
      await store.save(record);
    } finally {
      await store.close();
    }
    response = { ok: true as const, result: { switched: true, agent: record.agentLabel } };
  }
  if (!response.ok) throw new CliError(response.error);
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
}

async function runSessions(args: ParsedArgs): Promise<void> {
  if (args.sessionsAction === "list") {
    await runSessionList(args);
    return;
  }
  if (args.sessionsAction === "bind") {
    await runSessionBind(args);
    return;
  }
  if (args.sessionsAction === "set-agent") {
    await runSessionSetAgent(args);
    return;
  }
  if (args.sessionsAction !== "set-control") {
    throw new CliError("sessions requires subcommand: set-control | set-agent | list | bind");
  }
  const chatId = args.targetChatId;
  if (!chatId) throw new CliError("sessions set-control requires --chat-id <id>");
  if (typeof args.controlJson !== "string") {
    throw new CliError("sessions set-control requires --json <controls>");
  }

  const controls = parseControlJson(args.controlJson);
  const homeDir = resolveHomeDir(args.home);
  const response = await sendControlRequest(bridgeControlSocketPath(homeDir), {
    method: "setControls",
    params: { chatId, threadId: args.targetThreadId ?? null, controls },
  });
  if (!response.ok) throw new CliError(response.error);
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
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
 * Steps 3–4 let a bare `humming start` / `humming proxy` work out-of-the-box
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
        `unknown agent preset: ${args.agentPreset} (run \`humming agents\` to list presets)`,
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
  installHomeTemplates({
    homeDir,
    settingsPath: configPath,
    sessionsPath: path.join(homeDir, "sessions.json"),
    controlSocketPath: bridgeControlSocketPath(homeDir),
  });
  // Migrate a pre-~/.humming install into settings.json before reading it.
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
  cliLogger.info(
    `lifecycle:   ${cfg.lifecycleNotifyChatIds.length > 0 ? `notify ${cfg.lifecycleNotifyChatIds.length} chat(s)` : "off"}`,
  );

  const sessionStore = new FileSessionStore(cfg.dataDir);
  const bindingStore = new SettingsBindingStore(configPath);

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
    controlSocketPath: bridgeControlSocketPath(homeDir),
    lifecycle: {
      notificationChatIds: cfg.lifecycleNotifyChatIds,
      restartMarkerPath: bridgeRestartMarkerPath(homeDir),
    },
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
  markBridgeRestart(homeDir);
  try {
    await stopBridge({ homeDir });
    await startBridge({
      homeDir,
      selfPath: fileURLToPath(import.meta.url),
      spawnArgv,
      workingDirectory: process.cwd(),
    });
  } catch (err) {
    clearBridgeRestartMarker(homeDir);
    throw err;
  }
}

async function runInit(args: ParsedArgs): Promise<void> {
  const homeDir = resolveHomeDir(args.home);
  const configPath = resolveSettingsPath(args.configPath, homeDir);
  installHomeTemplates({
    homeDir,
    settingsPath: configPath,
    sessionsPath: path.join(homeDir, "sessions.json"),
    controlSocketPath: bridgeControlSocketPath(homeDir),
    overwriteDocs: true,
  });
  process.stdout.write(
    [
      `initialized humming home templates in ${homeDir}:`,
      `  AGENTS.md`,
      `  CLAUDE.md`,
      `  settings.back.json`,
      `  sessions.back.json`,
      ``,
      `Note: settings.json and sessions.json were not created. Copy/edit the .back.json files if you want to configure them manually.`,
      ``,
    ].join("\n"),
  );
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
    case "init":
      await runInit(args);
      return;
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
    case "control":
      await runControl(args);
      return;
    case "sessions":
      await runSessions(args);
      return;
    default:
      assertNever(args.command);
  }
}

function assertNever(x: never): never {
  throw new Error(`unexpected command: ${String(x)}`);
}

/**
 * True when this module is the process entry point (run as `humming …`),
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

// Exported for unit tests (bin/humming.test.ts). Not part of any public API —
// the package's only entry points are the `bin` scripts and `src/index.ts`.
export {
  parseArgs,
  resolveDefaultAgent,
  readConfigFile,
  migrateLegacyIfNeeded,
  resolveHomeDir,
  parseControlJson,
  runProxy,
  runInit,
  DEFAULT_AGENT,
};
export type { ParsedArgs };
