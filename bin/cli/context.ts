/**
 * Shared CLI context: home/config/registry resolution, Agent-selection
 * resolution (probe target vs. bound-repo target), chat/thread scope
 * derivation, and the control-socket request helper used by every
 * `session`/`agent` command. See docs/cli-command-model-SPEC.md §5, §7, §8.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  AgentProbeFailureTarget,
  ControlRequest,
  ControlResponse,
} from "../../src/bridge/control-server.js";
import { sendControlRequest } from "../../src/bridge/control-server.js";
import type { LarkLogger, ResolvedAgentInvocation } from "../../src/index.js";
import { buildRegistry, resolveAgent, type Registry } from "../agents.js";
import { bridgeControlSocketPath } from "../process-control.js";
import {
  DEFAULT_AGENT,
  ENV_CHAT_ID,
  ENV_THREAD_ID,
  expandTilde,
  nonEmptyEnv,
  normalizeOptionalThreadId,
  readConfigFile,
  resolveHomeDir,
  resolveSettingsPath,
  resolveStateDir,
  type FileConfig,
} from "./config/load.js";
import { CliError, formatError } from "./errors.js";

/** Logger that discards everything — used for CLI-side probes that must stay quiet on stdout. */
export const SILENT_LOGGER: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return SILENT_LOGGER;
  },
};

/** Root-level options declared on the Commander program, inherited by every command. */
export interface GlobalOptions {
  readonly home?: string;
  readonly settingsPath?: string;
  readonly dataDir?: string;
}

export interface CliBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly dataDir: string;
  readonly file: FileConfig;
  readonly registry: Registry;
}

/** Resolve home dir, settings path, parsed settings, agent registry, and data dir. */
export function loadCliBase(globals: GlobalOptions): CliBase {
  const homeDir = resolveHomeDir(globals.home);
  const configPath = resolveSettingsPath(globals.settingsPath, homeDir);
  const file = readConfigFile(configPath);
  const dataDir = resolveStateDir(globals.dataDir, file, homeDir);
  const registry = buildRegistry(file.agents);
  return { homeDir, configPath, file, registry, dataDir };
}

// ---------- chat/thread scope ----------------------------------------------

export interface ChatScopeOptions {
  readonly chatId?: string;
  readonly threadId?: string;
}

/**
 * Resolve `--chat-id`/`--thread-id`, falling back to `HUMMING_CHAT_ID` /
 * `HUMMING_THREAD_ID` (set by Humming for Agent subprocesses it spawns).
 *
 * @throws {CliError} when no chat id is available from either source.
 */
export function resolveRequiredChatScope(
  opts: ChatScopeOptions,
  commandLabel: string,
): { readonly chatId: string; readonly threadId: string | null } {
  const chatId = opts.chatId ?? nonEmptyEnv(ENV_CHAT_ID);
  if (chatId === undefined) {
    throw new CliError(
      `${commandLabel} requires --chat-id <id> (or run inside a Humming-spawned agent, where ${ENV_CHAT_ID} is set)`,
    );
  }
  return { chatId, threadId: resolveThreadId(opts.threadId) };
}

/** Same resolution as {@link resolveRequiredChatScope}, but chat id may be absent. */
export function resolveOptionalChatScope(opts: ChatScopeOptions): {
  readonly chatId?: string;
  readonly threadId: string | null;
} {
  const chatId = opts.chatId ?? nonEmptyEnv(ENV_CHAT_ID);
  return { ...(chatId !== undefined ? { chatId } : {}), threadId: resolveThreadId(opts.threadId) };
}

function resolveThreadId(explicit: string | undefined): string | null {
  if (explicit !== undefined) return normalizeOptionalThreadId(explicit);
  const fromEnv = process.env[ENV_THREAD_ID];
  return fromEnv !== undefined ? normalizeOptionalThreadId(fromEnv) : null;
}

// ---------- agent invocation resolution ------------------------------------

/**
 * Build the {@link AgentResolver} the bridge uses to turn a `/bind` agent
 * selection (preset id or raw command) into a concrete invocation.
 */
export function makeAgentResolver(registry: Registry) {
  return (selection: string): ResolvedAgentInvocation => {
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

/** Resolve an `--agent <preset-or-raw-command>` selection into an invocation. */
export function resolveAgentInvocation(
  registry: Registry,
  selection: string,
): ResolvedAgentInvocation {
  return makeAgentResolver(registry)(selection);
}

export interface AgentProbeTargetOptions {
  readonly agent: string;
  readonly cwd?: string;
  readonly chatId?: string;
  readonly threadId?: string | null;
}

export interface AgentProbeTarget {
  readonly homeDir: string;
  readonly dataDir: string;
  readonly chatId: string | undefined;
  readonly threadId: string | null;
  readonly cwd: string;
  readonly invocation: ResolvedAgentInvocation;
}

/**
 * Resolve the raw (unvalidated) target cwd shared by both Agent-target
 * resolvers. Precedence: `--cwd` > the chat's bound repo (when `--chat-id`
 * is known) > that chat/thread's latest session cwd > `runtime.cwd` >
 * `runtime.unboundCwd`. Returns `undefined` when none apply — callers decide
 * whether that's a hard error or falls back to `process.cwd()`.
 */
function resolveRawTargetCwd(
  base: CliBase,
  opts: { readonly cwd?: string; readonly chatId?: string },
  threadId: string | null,
): string | undefined {
  const binding = opts.chatId ? base.file.bindings[opts.chatId] : undefined;
  const sessionCwd = opts.chatId
    ? readLatestSessionCwd(base.dataDir, opts.chatId, threadId)
    : undefined;
  return (
    opts.cwd ??
    binding?.cwd ??
    sessionCwd ??
    base.file.runtime.cwd ??
    normalizeOptionalCwd(base.file.runtime.unboundCwd)
  );
}

/**
 * @throws {CliError} when `cwd` does not resolve to an existing directory.
 */
function resolveExistingDirectory(cwd: string): string {
  const resolved = path.resolve(expandTilde(cwd));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new CliError(`cwd "${resolved}" is not a directory`);
  }
  return resolved;
}

/**
 * Resolve the cwd + Agent invocation for a short-lived Agent probe (`agent
 * capabilities`/`models`/`modes`/`permissions`, and `session configure
 * --agent`). Cwd precedence: see {@link resolveRawTargetCwd}, falling back to
 * the process's own cwd (so ad-hoc probing works without any chat context).
 */
export function resolveAgentProbeTarget(
  base: CliBase,
  opts: AgentProbeTargetOptions,
): AgentProbeTarget {
  const threadId = opts.threadId ?? null;
  const rawCwd = resolveRawTargetCwd(base, opts, threadId) ?? process.cwd();
  const cwd = resolveExistingDirectory(rawCwd);
  const invocation = resolveAgentInvocation(base.registry, opts.agent);
  return {
    homeDir: base.homeDir,
    dataDir: base.dataDir,
    chatId: opts.chatId,
    threadId,
    cwd,
    invocation,
  };
}

export interface SessionRepoTargetOptions {
  readonly agent?: string;
  readonly cwd?: string;
  readonly chatId?: string;
  readonly threadId?: string | null;
}

/**
 * Resolve the cwd + Agent invocation for `session list`/`session bind`,
 * where an unresolved cwd is a hard error (these commands only make sense
 * against a real repo, not an ad-hoc default). Cwd precedence: see
 * {@link resolveRawTargetCwd}.
 *
 * @throws {CliError} when no cwd can be resolved.
 */
export function resolveSessionRepoTarget(
  base: CliBase,
  opts: SessionRepoTargetOptions,
): AgentProbeTarget {
  const threadId = opts.threadId ?? null;
  const rawCwd = resolveRawTargetCwd(base, opts, threadId);
  if (!rawCwd) {
    throw new CliError(
      "no cwd available; pass --cwd, bind the current chat to a repo, or configure runtime.unboundCwd for reception chats",
    );
  }
  const cwd = resolveExistingDirectory(rawCwd);
  const selection = opts.agent ?? base.file.runtime.agent ?? DEFAULT_AGENT;
  const invocation = resolveAgentInvocation(base.registry, selection);
  return {
    homeDir: base.homeDir,
    dataDir: base.dataDir,
    chatId: opts.chatId,
    threadId,
    cwd,
    invocation,
  };
}

function normalizeOptionalCwd(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function readLatestSessionCwd(
  dataDir: string,
  chatId: string,
  threadId: string | null,
): string | undefined {
  const sessionsPath = path.join(dataDir, "sessions.json");
  if (!fs.existsSync(sessionsPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const records = parsed[chatId];
  if (!Array.isArray(records)) return undefined;
  const latest = records
    .filter((record): record is Record<string, unknown> => isRecord(record))
    .filter((record) => (record["threadId"] ?? null) === threadId)
    .sort((a, b) => numberField(b["updatedAt"]) - numberField(a["updatedAt"]))[0];
  const cwd = latest?.["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------- control socket ---------------------------------------------------

/**
 * Send a request to the running bridge's control socket and unwrap the
 * response, or throw a {@link CliError} carrying the bridge's own error text.
 *
 * @throws {CliError} when the bridge rejects the request or the socket is
 *         unreachable (bridge not running).
 */
export async function callBridgeControl(
  homeDir: string,
  request: ControlRequest,
): Promise<unknown> {
  let response: ControlResponse;
  try {
    response = await sendControlRequest(bridgeControlSocketPath(homeDir), request);
  } catch (err) {
    throw new CliError(
      `could not reach the bridge control socket: ${formatError(err)} (is \`humming bridge start\` running?)`,
    );
  }
  if (!response.ok) throw new CliError(response.error);
  return response.result;
}

/**
 * Best-effort notice to the chat that a target Agent probe failed. Never
 * throws — a failed notification must not mask the original probe error.
 */
export async function notifyAgentProbeFailure(
  target: Pick<AgentProbeTarget, "homeDir" | "chatId" | "threadId" | "invocation" | "cwd">,
  err: unknown,
): Promise<void> {
  const chatId = target.chatId;
  if (!chatId) return;
  const agent: AgentProbeFailureTarget = {
    ...(target.invocation.label !== undefined ? { label: target.invocation.label } : {}),
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
  };
  try {
    await sendControlRequest(bridgeControlSocketPath(target.homeDir), {
      method: "agentProbeFailed",
      params: { chatId, threadId: target.threadId, agent, error: formatError(err) },
    });
  } catch (notifyErr) {
    SILENT_LOGGER.debug({ err: notifyErr }, "agent probe failure notice could not be delivered");
  }
}
