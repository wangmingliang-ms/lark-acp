import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import {
  capabilitiesFromSessionResponse,
  type SessionRuntimeCapabilities,
} from "./session-capabilities.js";

const STDIO_PIPED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
const WIN32_PLATFORM = "win32";
const STDERR_BUFFER_LINES = 50;
const DEFAULT_AGENT_INITIALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_SESSION_TIMEOUT_MS = 60_000;

/**
 * Environment variables Claude Code sets for its own child processes. The
 * `claude` CLI refuses to launch nested inside another Claude Code session
 * (it aborts with "Claude Code cannot be launched inside another Claude Code
 * session"), which makes `session/new` fail with "Query closed before response
 * received". When the bridge itself is started from within a Claude Code
 * session, these leak into every spawned agent — so strip them before spawn.
 *
 * `CLAUDECODE` is the exact flag the guard checks; the `CLAUDE_CODE_*` family is
 * stripped too so related nesting/session checks cannot trip. Unrelated
 * `CLAUDE_*` / `ANTHROPIC_*` vars (config dir, API keys) are deliberately kept.
 */
const NESTED_SESSION_ENV_EXACT = "CLAUDECODE";
const NESTED_SESSION_ENV_PREFIX = "CLAUDE_CODE_";

/**
 * Build the environment for a spawned agent: start from `base` (normally
 * `process.env`), drop the Claude Code nested-session markers, then apply
 * `overrides` on top so an explicit caller value always wins. Pure — never
 * mutates its arguments.
 */
export function sanitizeChildEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === NESTED_SESSION_ENV_EXACT || key.startsWith(NESTED_SESSION_ENV_PREFIX)) continue;
    result[key] = value;
  }
  return { ...result, ...overrides };
}

export interface AgentProcess {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: Record<string, unknown>;
  sessionCapabilities: SessionRuntimeCapabilities;
  /** Most recent stderr lines (up to {@link STDERR_BUFFER_LINES}). */
  getRecentStderr: () => readonly string[];
}

export interface ListedAgentSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export interface ListAgentSessionsOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger: LarkLogger;
}

export interface ListAgentSessionsResult {
  readonly sessions: readonly ListedAgentSession[];
  readonly supportsResume: boolean;
  readonly supportsLoad: boolean;
}

export interface ProbeAgentSessionCapabilitiesResult {
  readonly sessionId: string;
  readonly capabilities: SessionRuntimeCapabilities;
}

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  logger: LarkLogger;
}

export interface BuildAgentSpawnOptionsInput {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface AgentChildProcessOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly shell: boolean;
  readonly windowsHide: boolean;
}

export function buildAgentSpawnOptions(
  opts: BuildAgentSpawnOptionsInput,
): AgentChildProcessOptions {
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === WIN32_PLATFORM;
  return {
    cwd: opts.cwd,
    env: sanitizeChildEnv(opts.baseEnv ?? process.env, opts.env ?? {}),
    stdio: STDIO_PIPED,
    shell: isWindows,
    windowsHide: isWindows,
  };
}

class ListingClient implements acp.Client {
  constructor(private readonly logger: LarkLogger) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.logger.warn(
      { sessionId: params.sessionId, tool: params.toolCall?.title ?? "unknown" },
      "permission requested while listing sessions — cancelling",
    );
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(_params: acp.SessionNotification): Promise<void> {
    // Listing sessions should not produce user-renderable updates. Ignore any
    // stray notifications from over-eager agents.
  }
}

/**
 * Thrown when an agent rejects session creation because it is not
 * authenticated (e.g. Codex without ChatGPT login / OPENAI_API_KEY). Carries
 * the agent label so the bridge can show the user an actionable message
 * instead of an opaque "failed to create session".
 */
export class AgentAuthError extends Error {
  readonly agentLabel: string;
  readonly authHint: string;
  constructor(agentLabel: string, authHint: string, cause?: unknown) {
    super(`${agentLabel} 未认证：${authHint}`, cause !== undefined ? { cause } : undefined);
    this.name = "AgentAuthError";
    this.agentLabel = agentLabel;
    this.authHint = authHint;
  }
}

/**
 * Thrown when the ACP connection to the agent closes while a request is still
 * pending. The SDK leaves such requests (notably `prompt()`) hanging forever
 * when the agent's stdio stream ends — it only aborts its close signal, never
 * rejecting the in-flight promise. The bridge races `connection.closed`
 * against `prompt()` and throws this so the normal prompt-error path can
 * finalise the card and notify the user instead of hanging indefinitely.
 */
export class AgentDisconnectedError extends Error {
  constructor(cause?: unknown) {
    super("Agent connection closed before the prompt completed", {
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "AgentDisconnectedError";
  }
}

/**
 * Detect an ACP "authentication required" rejection. codex-acp returns
 * JSON-RPC error code -32000 with message "Authentication required"; other
 * adapters phrase it differently, so match on both code and message text.
 */
function isAuthError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | undefined;
  const code = e?.code;
  const msg = String(e?.message ?? err ?? "").toLowerCase();
  return (
    code === -32000 ||
    msg.includes("authentication required") ||
    msg.includes("not authenticated") ||
    msg.includes("unauthorized") ||
    msg.includes("login required")
  );
}

/**
 * Per-agent hint on how to authenticate, keyed by the agent command. Best
 * effort — falls back to a generic message.
 */
function authHintFor(command: string, args: readonly string[]): string {
  const joined = `${command} ${args.join(" ")}`.toLowerCase();
  if (joined.includes("codex")) {
    return "请先认证 Codex：设置 OPENAI_API_KEY 或 CODEX_API_KEY 环境变量，或运行 `codex login`（需 ChatGPT 订阅），然后重发消息。";
  }
  if (joined.includes("gemini")) {
    return "请先认证 Gemini：设置 GEMINI_API_KEY 环境变量或完成 gemini 登录，然后重发消息。";
  }
  if (joined.includes("claude")) {
    return "请先认证 Claude：完成 claude 登录或设置对应 API key，然后重发消息。";
  }
  return "该 agent 需要认证。请完成其登录或设置对应 API key 后重发消息。";
}

interface SpawnInternal {
  proc: ChildProcess;
  connection: acp.ClientSideConnection;
  initResult: Awaited<ReturnType<acp.ClientSideConnection["initialize"]>>;
  getRecentStderr: () => readonly string[];
}

/**
 * Spawn an agent subprocess, run the ACP handshake, and create a fresh
 * session.
 *
 * @throws when the agent process cannot be initialized (binary missing,
 *         protocol mismatch, etc.) or when `newSession` rejects.
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<AgentProcess> {
  const { proc, connection, initResult, getRecentStderr } = await spawnAndInit(opts);

  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await withAgentRequest(
      connection.newSession({ cwd: opts.cwd, mcpServers: [] }),
      connection,
      DEFAULT_AGENT_SESSION_TIMEOUT_MS,
      `agent newSession (${formatAgentCommand(opts.command, opts.args)})`,
    );
  } catch (err) {
    if (isAuthError(err)) {
      killAgent(proc);
      throw new AgentAuthError(opts.command, authHintFor(opts.command, opts.args), err);
    }
    killAgent(proc);
    throw new Error("Failed to create agent session", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "agent session created");

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
    capabilities: (initResult.agentCapabilities ?? {}) as Record<string, unknown>,
    sessionCapabilities: capabilitiesFromSessionResponse(sessionResult),
    getRecentStderr,
  };
}

export async function listAgentSessions(
  opts: ListAgentSessionsOptions,
): Promise<ListAgentSessionsResult> {
  const client = new ListingClient(opts.logger.child({ name: "session-list-client" }));
  const { proc, connection, initResult } = await spawnAndInit({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env,
    client,
    logger: opts.logger,
  });
  try {
    const caps = initResult.agentCapabilities;
    if (!caps?.sessionCapabilities?.list) {
      throw new Error("agent does not support ACP session/list");
    }
    const sessions: ListedAgentSession[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await connection.listSessions({
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
      });
      for (const s of response.sessions) {
        sessions.push({
          sessionId: s.sessionId,
          cwd: s.cwd,
          ...(s.title !== undefined && s.title !== null ? { title: s.title } : {}),
          ...(s.updatedAt !== undefined && s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
        });
      }
      cursor = response.nextCursor;
    } while (cursor !== undefined && cursor !== null && cursor.length > 0);

    return {
      sessions,
      supportsResume: !!caps.sessionCapabilities?.resume,
      supportsLoad: !!caps.loadSession,
    };
  } finally {
    killAgent(proc);
  }
}

export async function probeAgentSessionCapabilities(
  opts: ListAgentSessionsOptions,
): Promise<ProbeAgentSessionCapabilitiesResult> {
  const client = new ListingClient(opts.logger.child({ name: "agent-capabilities-client" }));
  const agent = await spawnAgent({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env,
    client,
    logger: opts.logger,
  });
  try {
    return {
      sessionId: agent.sessionId,
      capabilities: agent.sessionCapabilities,
    };
  } finally {
    killAgent(agent.process);
  }
}

/**
 * Spawn an agent and try to resume an existing session. Falls back to
 * `loadSession` if `unstable_resumeSession` is unavailable, then to a
 * fresh session if neither resume mechanism works.
 *
 * @throws on unrecoverable spawn / init failures (same conditions as
 *         {@link spawnAgent}).
 */
export async function spawnAndResumeAgent(
  opts: SpawnAgentOptions,
  previousSessionId: string,
): Promise<{ agent: AgentProcess; resumed: boolean }> {
  const { proc, connection, initResult, getRecentStderr } = await spawnAndInit(opts);
  const agentCaps = initResult.agentCapabilities;
  const caps = (agentCaps ?? {}) as Record<string, unknown>;

  const hasResume = !!agentCaps?.sessionCapabilities?.resume;
  const hasLoad = !!agentCaps?.loadSession;

  opts.logger.debug({ hasResume, hasLoad, previousSessionId }, "agent capabilities for resume");

  if (hasResume || hasLoad) {
    try {
      let sessionCaps: SessionRuntimeCapabilities;
      if (hasResume) {
        const resumeResult = await withAgentRequest(
          connection.unstable_resumeSession({
            sessionId: previousSessionId,
            cwd: opts.cwd,
            mcpServers: [],
          }),
          connection,
          DEFAULT_AGENT_SESSION_TIMEOUT_MS,
          `agent resumeSession (${formatAgentCommand(opts.command, opts.args)})`,
        );
        sessionCaps = capabilitiesFromSessionResponse(resumeResult);
      } else {
        const loadResult = await withAgentRequest(
          connection.loadSession({
            sessionId: previousSessionId,
            cwd: opts.cwd,
            mcpServers: [],
          }),
          connection,
          DEFAULT_AGENT_SESSION_TIMEOUT_MS,
          `agent loadSession (${formatAgentCommand(opts.command, opts.args)})`,
        );
        sessionCaps = capabilitiesFromSessionResponse(loadResult);
      }
      opts.logger.info(
        { sessionId: previousSessionId, mode: hasResume ? "resume" : "load" },
        "session resumed",
      );
      return {
        agent: {
          process: proc,
          connection,
          sessionId: previousSessionId,
          capabilities: caps,
          sessionCapabilities: sessionCaps,
          getRecentStderr,
        },
        resumed: true,
      };
    } catch (err) {
      opts.logger.warn({ err, previousSessionId }, "resume failed, will start fresh");
    }
  }

  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await withAgentRequest(
      connection.newSession({ cwd: opts.cwd, mcpServers: [] }),
      connection,
      DEFAULT_AGENT_SESSION_TIMEOUT_MS,
      `agent newSession (${formatAgentCommand(opts.command, opts.args)})`,
    );
  } catch (err) {
    if (isAuthError(err)) {
      killAgent(proc);
      throw new AgentAuthError(opts.command, authHintFor(opts.command, opts.args), err);
    }
    killAgent(proc);
    throw new Error("Failed to create agent session after resume failure", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "fresh session created");

  return {
    agent: {
      process: proc,
      connection,
      sessionId: sessionResult.sessionId,
      capabilities: caps,
      sessionCapabilities: capabilitiesFromSessionResponse(sessionResult),
      getRecentStderr,
    },
    resumed: false,
  };
}

async function spawnAndInit(opts: SpawnAgentOptions): Promise<SpawnInternal> {
  const { command, args, cwd, env, client, logger } = opts;

  logger.info({ command, args }, "spawning agent");

  const proc = spawn(command, args, {
    ...buildAgentSpawnOptions({ cwd, env }),
  });

  const stderrBuffer: string[] = [];
  let stderrCarry = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrCarry += chunk.toString();
    const parts = stderrCarry.split("\n");
    stderrCarry = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      logger.debug({ stream: "stderr" }, line);
      stderrBuffer.push(line);
      if (stderrBuffer.length > STDERR_BUFFER_LINES) stderrBuffer.shift();
    }
  });

  proc.on("error", (err) => logger.error({ err }, "agent process error"));
  proc.on("exit", (code, signal) => {
    if (code === 0 || code === null) {
      logger.info({ code, signal }, "agent process exited");
    } else {
      logger.error({ code, signal }, "agent process exited unexpectedly");
    }
  });

  const getRecentStderr = (): readonly string[] => [...stderrBuffer];

  // Non-null asserted: stdio: STDIO_PIPED guarantees pipe streams exist.
  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  let initResult: Awaited<ReturnType<typeof connection.initialize>>;
  try {
    initResult = await withAgentRequest(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      }),
      connection,
      DEFAULT_AGENT_INITIALIZE_TIMEOUT_MS,
      `agent initialize (${formatAgentCommand(command, args)})`,
    );
  } catch (err) {
    const tail = getRecentStderr();
    const stderrSuffix = tail.length > 0 ? `\nstderr:\n${tail.join("\n")}` : "";
    killAgent(proc);
    throw new Error(
      `Failed to initialize agent (${command} ${args.join(" ")}). Is the agent installed?${stderrSuffix}`,
      { cause: err },
    );
  }

  if (initResult.authMethods && initResult.authMethods.length > 0) {
    const ids = initResult.authMethods.map((m: { id: string }) => m.id);
    logger.debug({ authMethods: ids }, "agent advertised auth methods (informational only)");
  }

  return { proc, connection, initResult, getRecentStderr };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}

function withAgentRequest<T>(
  promise: Promise<T>,
  connection: acp.ClientSideConnection,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const disconnected = connection.closed.then(
    () => {
      throw new AgentDisconnectedError();
    },
    (cause) => {
      throw new AgentDisconnectedError(cause);
    },
  );
  return Promise.race([promise, disconnected, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatAgentCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}
