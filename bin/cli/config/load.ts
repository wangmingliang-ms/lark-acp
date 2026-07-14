/**
 * Home directory resolution, `settings.json` loading (Zod-validated), and
 * the merge of file + env + CLI flags into one {@link EffectiveConfig} used
 * by `humming bridge run`/`start`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { z } from "zod";
import { installHomeTemplates, PERMISSION_MODES } from "../../../src/index.js";
import type { PermissionMode, SessionControls } from "../../../src/index.js";
import {
  readSettingsFileObject,
  SettingsFileFormatError,
} from "../../../src/settings-file/settings-file.js";
import { bridgeControlSocketPath } from "../../process-control.js";
import { CliError } from "../errors.js";
import { fileConfigSchema, type FileConfig } from "./schema.js";

export type { FileConfig } from "./schema.js";

export const SETTINGS_FILE = "settings.json";
const HOME_DIR_NAME = ".humming";

export const ENV_APP_ID = "HUMMING_APP_ID";
export const ENV_APP_SECRET = "HUMMING_APP_SECRET";
export const ENV_HOME = "HUMMING_HOME";
export const ENV_PERMISSION_MODE = "HUMMING_PERMISSION_MODE";
export const ENV_CHAT_ID = "HUMMING_CHAT_ID";
export const ENV_THREAD_ID = "HUMMING_THREAD_ID";

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 1440;
export const DEFAULT_MAX_CHATS = 10;
export const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
export const DEFAULT_IDLE_STATUS_CARD_MS = 15_000;
/**
 * Agent used when neither `--agent` nor settings.json `runtime.agent` names one.
 * Makes a bare `humming bridge run` / `start` work out-of-the-box on a fresh
 * machine (claude authenticates via the local `claude` CLI, no API key).
 */
export const DEFAULT_AGENT = "claude";

export function defaultHomeDir(): string {
  return path.join(os.homedir(), HOME_DIR_NAME);
}

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve the unified humming home directory. Precedence:
 *   1. --home <dir>   (CLI, resolved by caller and passed in)
 *   2. $HUMMING_HOME
 *   3. ~/.humming
 */
export function resolveHomeDir(override: string | undefined): string {
  if (override && override.length > 0) return path.resolve(expandTilde(override));
  const fromEnv = process.env[ENV_HOME];
  if (fromEnv && fromEnv.length > 0) return path.resolve(expandTilde(fromEnv));
  return defaultHomeDir();
}

/**
 * Resolve the settings file path. Precedence:
 *   1. --settings-path <path> (override)
 *   2. <home>/settings.json
 */
export function resolveSettingsPath(override: string | undefined, homeDir: string): string {
  if (override) return path.resolve(expandTilde(override));
  return path.join(homeDir, SETTINGS_FILE);
}

export interface HomeBootstrap {
  readonly homeDir: string;
  readonly configPath: string;
}

/**
 * Resolve home dir + settings path and seed `~/.humming` with guide/example
 * files (AGENTS.md, CLAUDE.md, settings.back.json, sessions.back.json).
 * Shared by the three CLI entry points that bootstrap a home directory from
 * scratch: `bridge run`/`start`, `setup`, and `init`.
 */
export function installHomeBootstrap(
  globals: { readonly home?: string; readonly settingsPath?: string },
  overwriteDocs = false,
): HomeBootstrap {
  const homeDir = resolveHomeDir(globals.home);
  const configPath = resolveSettingsPath(globals.settingsPath, homeDir);
  installHomeTemplates({
    homeDir,
    settingsPath: configPath,
    sessionsPath: path.join(homeDir, "sessions.json"),
    controlSocketPath: bridgeControlSocketPath(homeDir),
    overwriteDocs,
  });
  return { homeDir, configPath };
}

/**
 * Read and Zod-validate `settings.json`, defaulting to an empty
 * {@link FileConfig} when the file does not exist.
 *
 * @throws {CliError} when the file exists but is malformed or fails schema
 *         validation.
 */
export function readConfigFile(filePath: string): FileConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = readSettingsFileObject(filePath);
  } catch (err) {
    if (!(err instanceof SettingsFileFormatError)) throw err;
    throw new CliError(err.message.replace("settings file", "config file"));
  }

  const result = fileConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(`config file ${filePath} is invalid:\n${formatZodError(result.error)}`);
  }
  return result.data;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    )
    .join("\n");
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

// ---------- effective config -----------------------------------------------

export interface EffectiveConfig {
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
  readonly defaultControls: SessionControls | undefined;
  readonly idleStatusCardMs: number;
  readonly groupRequireMention: boolean;
  readonly lifecycleNotifyChatIds: readonly string[];
  readonly globalControlChatIds: readonly string[];
  /** Reception-area cwd for unbound chats (default = home dir; null disables). */
  readonly unboundCwd: string | null;
}

/** Flags accepted by `humming bridge run` / `bridge start`, already Commander-typed. */
export interface BridgeRunFlags {
  readonly cwd?: string;
  readonly dataDir?: string;
  readonly unboundCwd?: string;
  readonly idleTimeout?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permission?: PermissionMode;
  readonly requireMention?: boolean;
}

/**
 * Merge file config, env vars, and CLI flags into a single resolved config.
 * Precedence (highest first): CLI flags, environment variables, config file,
 * built-in defaults.
 *
 * @throws {CliError} when required fields (credentials, valid cwd) are
 *         missing or invalid.
 */
export function resolveConfig(
  flags: BridgeRunFlags,
  configPath: string,
  homeDir: string,
  file: FileConfig,
): EffectiveConfig {
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

  // Unlike a required cwd of old, a chat gets its cwd from /bind. A
  // configured default cwd only applies to chats with no explicit binding.
  const rawCwd = flags.cwd ?? file.runtime.cwd ?? null;
  let defaultCwd: string | null = null;
  if (rawCwd !== null) {
    const resolved = path.resolve(expandTilde(rawCwd));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CliError(`cwd "${resolved}" is not a directory`);
    }
    defaultCwd = resolved;
  }

  // The home dir IS the data dir now; `--data-dir` / settings.json `dataDir`
  // override it, otherwise everything lives under homeDir.
  const rawDataDir = flags.dataDir ?? file.dataDir ?? homeDir;
  const dataDir = path.resolve(expandTilde(rawDataDir));

  const idleTimeoutMinutes =
    flags.idleTimeout ?? file.runtime.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
  const maxChats = flags.maxChats ?? file.runtime.maxChats ?? DEFAULT_MAX_CHATS;

  const hideThoughts = flags.hideThoughts ?? file.runtime.hideThoughts ?? false;
  const hideTools = flags.hideTools ?? file.runtime.hideTools ?? false;
  const hideCancelButton = flags.hideCancelButton ?? file.runtime.hideCancelButton ?? false;
  const groupRequireMention = flags.requireMention ?? file.runtime.groupRequireMention ?? false;
  const lifecycleNotifyChatIds = file.runtime.lifecycleNotifyChatIds ?? [];
  const globalControlChatIds = file.runtime.globalControlChatIds ?? lifecycleNotifyChatIds;
  const idleStatusCardMs = file.runtime.idleStatusCardMs ?? DEFAULT_IDLE_STATUS_CARD_MS;

  // Reception area: default ON, cwd = home dir. Precedence: --unbound-cwd
  // flag > runtime.unboundCwd > home dir. An explicit empty string disables
  // it (restores the "please /bind" notice for unbound chats).
  const rawUnbound = flags.unboundCwd ?? file.runtime.unboundCwd;
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
    flags.permission ??
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
    defaultControls: file.runtime.defaultControls,
    idleStatusCardMs,
    groupRequireMention,
    lifecycleNotifyChatIds,
    globalControlChatIds,
    unboundCwd,
  };
}

/**
 * Resolve the state/data directory without requiring full credential
 * resolution — used by `agent`/`session` commands that only need
 * `sessions.json` + bindings, not a live bridge.
 */
export function resolveStateDir(
  dataDirFlag: string | undefined,
  file: FileConfig,
  homeDir: string,
): string {
  const rawDataDir = dataDirFlag ?? file.dataDir ?? homeDir;
  return path.resolve(expandTilde(rawDataDir));
}

export function normalizeOptionalThreadId(value: string): string | null {
  return value === "" || value === "null" || value === "<main>" ? null : value;
}

export function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}
