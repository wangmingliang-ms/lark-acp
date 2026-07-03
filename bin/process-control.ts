/**
 * Cross-platform process management for the bridge: background start, stop,
 * restart, status, and log tailing — driven by a PID file under the lark-acp
 * home dir.
 *
 * CLI-only: the library (`src/`) never consumes these. The design goal is a
 * single implementation that works on both Windows and Linux, so it leans on
 * Node primitives that behave the same on both — `process.kill(pid, 0)` for a
 * liveness probe, a detached `child_process.spawn` for backgrounding, and
 * `path`/`fs` for state files — rather than a Linux-only supervisor.
 *
 * Graceful stop (SIGTERM → the bridge's own shutdown hook) is POSIX-only; on
 * Windows `process.kill` hard-terminates. Crash-restart / boot-autostart are
 * intentionally out of scope here (a later platform layer — systemd unit /
 * Task Scheduler — would call `start`).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";

/** Used only in user-facing hint text; kept local to avoid coupling to the CLI. */
const APP_NAME = "lark-acp";

const PID_FILE = "bridge.pid";
const LOG_FILE = "bridge.log";

/** Default number of trailing log lines shown by `logs` (without `-n`). */
export const DEFAULT_LOG_LINES = 40;

/** Grace window after spawn before we trust a "started" (catches fast crashes). */
const POST_SPAWN_CHECK_MS = 600;
/** Log lines surfaced when a freshly-started bridge dies immediately. */
const FAILURE_TAIL_LINES = 15;
/** How long SIGTERM is given to shut the bridge down before SIGKILL. */
const GRACEFUL_STOP_TIMEOUT_MS = 5_000;
/** How long we wait for the process to vanish after SIGKILL. */
const SIGKILL_TIMEOUT_MS = 2_000;
/** Poll cadence while waiting for a process to exit. */
const EXIT_POLL_INTERVAL_MS = 150;
/** Poll cadence for `logs --follow`. */
const LOG_POLL_INTERVAL_MS = 500;

/**
 * A user-facing process-management failure (already running, spawn failed,
 * missing log, …). The CLI prints its message as `error: …` and exits non-zero.
 */
export class ProcessControlError extends Error {
  override readonly name = "ProcessControlError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// ---------- path helpers --------------------------------------------------

/** Absolute path of the bridge PID file under a home dir. */
export function bridgePidPath(homeDir: string): string {
  return path.join(homeDir, PID_FILE);
}

/** Absolute path of the bridge log file under a home dir. */
export function bridgeLogPath(homeDir: string): string {
  return path.join(homeDir, LOG_FILE);
}

// ---------- pure, testable cores ------------------------------------------

/**
 * Read a PID from a PID file. Returns `null` when the file is absent, empty,
 * or does not contain a positive integer (a corrupt/legacy file is treated as
 * "no PID" rather than an error).
 *
 * @throws {ProcessControlError} on an unexpected read error (not ENOENT).
 */
export function readPid(pidPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, "utf-8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw new ProcessControlError(`failed to read PID file ${pidPath}: ${formatErr(err)}`, {
      cause: err,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Whether a process with the given PID currently exists, using the signal-0
 * probe. `EPERM` (exists but owned by another user) counts as alive; `ESRCH`
 * (no such process) counts as dead.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

/**
 * Clone `rawArgv` with the token at `index` replaced by `replacement`. Used to
 * turn a `start`/`restart` invocation into the `proxy` invocation that runs in
 * the background — preserving every global option, proxy flag, and `--`
 * passthrough exactly as the user typed them.
 *
 * @throws {ProcessControlError} when `index` is out of range.
 */
export function rewriteSubcommand(
  rawArgv: readonly string[],
  index: number,
  replacement: string,
): string[] {
  if (index < 0 || index >= rawArgv.length) {
    throw new ProcessControlError(
      `subcommand index ${index} out of range for argv of length ${rawArgv.length}`,
    );
  }
  const out = [...rawArgv];
  out[index] = replacement;
  return out;
}

// ---------- actions -------------------------------------------------------

export interface StartOptions {
  readonly homeDir: string;
  /** Absolute path of this CLI's entry file (from `fileURLToPath(import.meta.url)`). */
  readonly selfPath: string;
  /** Argv to run in the background — a `proxy …` invocation (see {@link rewriteSubcommand}). */
  readonly spawnArgv: readonly string[];
}

/**
 * Start the bridge as a detached background process, recording its PID and
 * redirecting its output to the log file. Refuses to start a second instance.
 * After spawning, waits briefly and verifies the child is still alive, so a
 * process that dies during startup is reported instead of a false "started".
 *
 * The check is a cheap safety net, not a health check: the bridge is hard to
 * crash at boot. It only catches failures that kill the process *synchronously*
 * within the grace window (e.g. an unparseable settings.json, a log-file
 * permission error). It does NOT catch bad credentials (the Lark SDK retries),
 * a bad `--agent` (the agent spawns lazily on the first message → surfaces as
 * an in-chat error card), or network issues (retried). Use `logs` / `status`
 * to confirm the bridge actually connected.
 *
 * @throws {ProcessControlError} when a bridge is already running, the spawn
 *         fails, or the child dies within the post-spawn grace window.
 */
export async function startBridge(opts: StartOptions): Promise<void> {
  const pidPath = bridgePidPath(opts.homeDir);
  const logPath = bridgeLogPath(opts.homeDir);

  const existing = readPid(pidPath);
  if (existing !== null && isAlive(existing)) {
    throw new ProcessControlError(
      `bridge already running (PID ${existing}). Use \`${APP_NAME} restart\` or \`${APP_NAME} stop\` first.`,
    );
  }
  if (existing !== null) removeQuietly(pidPath); // stale file — process is gone

  fs.mkdirSync(opts.homeDir, { recursive: true });

  // Open the log in append mode and hand the fd to the child as stdout+stderr;
  // append keeps history across restarts. The parent closes its copy right
  // after spawn — the child keeps its own.
  const logFd = fs.openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [opts.selfPath, ...opts.spawnArgv], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(logFd);
  }

  const pid = child.pid;
  if (pid === undefined) {
    throw new ProcessControlError("failed to spawn bridge process (no PID assigned)");
  }

  fs.writeFileSync(pidPath, `${pid}\n`, "utf-8");
  child.unref();

  await delay(POST_SPAWN_CHECK_MS);
  if (!isAlive(pid)) {
    removeQuietly(pidPath);
    const tail = readLastLines(logPath, FAILURE_TAIL_LINES);
    const detail = tail.length > 0 ? `\n--- log tail ---\n${tail}` : "";
    throw new ProcessControlError(`bridge exited immediately after start; see ${logPath}${detail}`);
  }

  process.stdout.write(`bridge started (PID ${pid})\n`);
  process.stdout.write(`  logs: ${logPath}\n`);
}

export interface StopOptions {
  readonly homeDir: string;
}

/**
 * Stop a running bridge: SIGTERM (POSIX → the bridge's graceful shutdown),
 * poll for exit, then SIGKILL as a fallback. Clears the PID file. Returns
 * `true` if a live process was stopped, `false` if nothing was running.
 *
 * @throws {ProcessControlError} when signalling fails for a reason other than
 *         the process already being gone.
 */
export async function stopBridge(opts: StopOptions): Promise<boolean> {
  const pidPath = bridgePidPath(opts.homeDir);
  const pid = readPid(pidPath);
  if (pid === null || !isAlive(pid)) {
    removeQuietly(pidPath);
    process.stdout.write("bridge not running\n");
    return false;
  }

  process.stdout.write(`stopping bridge (PID ${pid})...\n`);
  signalQuietly(pid, "SIGTERM");

  const exited = await waitForExit(pid, GRACEFUL_STOP_TIMEOUT_MS);
  if (!exited) {
    process.stderr.write("  graceful stop timed out; sending SIGKILL\n");
    signalQuietly(pid, "SIGKILL");
    await waitForExit(pid, SIGKILL_TIMEOUT_MS);
  }

  removeQuietly(pidPath);
  process.stdout.write("bridge stopped\n");
  return true;
}

export interface StatusOptions {
  readonly homeDir: string;
}

/**
 * Print whether the bridge is running, with PID and approximate uptime (from
 * the PID file's mtime). Clears a stale PID file as a side effect.
 */
export function statusBridge(opts: StatusOptions): void {
  const pidPath = bridgePidPath(opts.homeDir);
  const pid = readPid(pidPath);
  if (pid === null || !isAlive(pid)) {
    if (pid !== null) removeQuietly(pidPath);
    process.stdout.write("bridge: not running\n");
    return;
  }
  const uptime = formatUptime(pidFileAgeMs(pidPath));
  const suffix = uptime.length > 0 ? `, up ${uptime}` : "";
  process.stdout.write(`bridge: running (PID ${pid}${suffix})\n`);
  process.stdout.write(`  logs: ${bridgeLogPath(opts.homeDir)}\n`);
}

export interface LogsOptions {
  readonly homeDir: string;
  /** Keep streaming appended lines until interrupted (Ctrl-C). */
  readonly follow: boolean;
  /** Number of trailing lines to print first. */
  readonly lines: number;
}

/**
 * Print the tail of the bridge log, optionally following appended output.
 * Following is a size-poll tailer (no dependency on the Unix `tail` binary),
 * so it works identically on Windows and Linux; it runs until the user
 * interrupts the process.
 *
 * @throws {ProcessControlError} when no log file exists yet.
 */
export async function tailLog(opts: LogsOptions): Promise<void> {
  const logPath = bridgeLogPath(opts.homeDir);
  if (!fs.existsSync(logPath)) {
    throw new ProcessControlError(
      `no log file at ${logPath} (has the bridge been started with \`${APP_NAME} start\`?)`,
    );
  }

  const initial = readLastLines(logPath, opts.lines);
  if (initial.length > 0) {
    process.stdout.write(initial.endsWith("\n") ? initial : `${initial}\n`);
  }

  if (!opts.follow) return;
  await followFile(logPath);
}

// ---------- internals -----------------------------------------------------

/** Extract a string `errno` code (`"ENOENT"`, `"ESRCH"`, …) from an unknown throw. */
function errnoCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  if (!("code" in err)) return null;
  const { code } = err;
  return typeof code === "string" ? code : null;
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Send a signal, treating "already gone" (ESRCH) as success. */
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (errnoCode(err) === "ESRCH") return;
    throw new ProcessControlError(`failed to signal PID ${pid} with ${signal}: ${formatErr(err)}`, {
      cause: err,
    });
  }
}

/** Best-effort file removal; never throws (missing file is fine). */
function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // best-effort cleanup — a leftover file is harmless
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `pid` is no longer alive or the timeout elapses. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}

/** Age of the PID file in ms (≈ process start time), or `null` if unreadable. */
function pidFileAgeMs(pidPath: string): number | null {
  try {
    return Date.now() - fs.statSync(pidPath).mtimeMs;
  } catch {
    return null;
  }
}

function formatUptime(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** Read the last `n` lines of a file, tolerating a trailing newline. Empty on error. */
function readLastLines(filePath: string, n: number): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * Follow a file by polling its size and printing newly-appended bytes. Runs
 * until the process is interrupted. Handles truncation/rotation by restarting
 * from offset 0 when the file shrinks.
 */
async function followFile(logPath: string): Promise<void> {
  let position = safeFileSize(logPath);
  for (;;) {
    await delay(LOG_POLL_INTERVAL_MS);
    const size = safeFileSize(logPath);
    if (size < position) position = 0; // truncated / rotated
    if (size === position) continue;
    printRange(logPath, position, size - position);
    position = size;
  }
}

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Print `length` bytes of a file starting at `offset`, as UTF-8. */
function printRange(filePath: string, offset: number, length: number): void {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    process.stdout.write(buf.subarray(0, read).toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
}
