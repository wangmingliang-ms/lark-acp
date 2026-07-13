#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchDescriptor } from "./process-control.js";
import {
  bridgeControlSocketPath,
  bridgePidPath,
  clearBridgeRestartMarker,
  isAlive,
  startBridge,
} from "./process-control.js";
import { sendControlRequest } from "../src/bridge/control-server.js";
import {
  sendLifecycleNotice,
  type LifecycleNoticeDelivery,
} from "../src/lark/lifecycle-notifier.js";
import { LarkHttpClient } from "../src/lark/lark-http.js";
import type { LarkLogger } from "../src/logger/logger.js";

export type LifecycleIntent = "stop" | "restart";

export interface LifecycleDeadlines {
  readonly readyToExitAt: number;
  readonly oldPidExitAt: number;
  readonly restartReadyAt: number;
}

export interface LifecycleTransaction {
  readonly id: string;
  readonly intent: LifecycleIntent;
  readonly home: string;
  readonly oldPid: number;
  readonly launch: LaunchDescriptor;
  readonly deadlines: LifecycleDeadlines;
  readonly statePath: string;
}

export class LifecycleTransactionError extends Error {
  override readonly name = "LifecycleTransactionError";
}

export interface LifecycleCoordinatorCapabilities {
  readonly platform: NodeJS.Platform;
  readonly systemdAvailable: boolean;
  readonly nodePath: string;
  readonly coordinatorPath: string;
}

export interface LifecycleCoordinatorLaunch {
  readonly strategy: "systemd" | "detached";
  readonly command: string;
  readonly args: readonly string[];
}

interface CoordinatorProcess {
  readonly pid?: number;
  unref(): void;
}

export interface LifecycleCoordinatorProcesses {
  spawn(
    command: string,
    args: readonly string[],
    options: { readonly detached: true; readonly stdio: "ignore"; readonly windowsHide: true },
  ): CoordinatorProcess;
  spawnSync(
    command: string,
    args: readonly string[],
    options: { readonly encoding: "utf-8" },
  ): { readonly status: number | null; readonly error?: Error; readonly stderr?: string | null };
}

export interface LifecycleTransactionBuildOptions {
  readonly id: string;
  readonly intent: LifecycleIntent;
  readonly home: string;
  readonly oldPid: number;
  readonly launch: LaunchDescriptor;
  readonly now: number;
  readonly readyToExitMs: number;
  readonly oldPidExitMs: number;
  readonly restartReadyMs: number;
}

export function buildLifecycleTransaction(
  options: LifecycleTransactionBuildOptions,
): LifecycleTransaction {
  const statePath = path.join(options.home, `lifecycle-${options.id}.json`);
  const transaction: LifecycleTransaction = {
    id: options.id,
    intent: options.intent,
    home: options.home,
    oldPid: options.oldPid,
    launch: options.launch,
    deadlines: {
      readyToExitAt: options.now + options.readyToExitMs,
      oldPidExitAt: options.now + options.oldPidExitMs,
      restartReadyAt: options.now + options.restartReadyMs,
    },
    statePath,
  };
  assertLifecycleTransaction(transaction);
  return transaction;
}

export function writeLifecycleTransaction(transaction: LifecycleTransaction): void {
  assertLifecycleTransaction(transaction);
  fs.mkdirSync(path.dirname(transaction.statePath), { recursive: true });
  const temporaryPath = `${transaction.statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(transaction, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, transaction.statePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function readLifecycleTransaction(statePath: string): LifecycleTransaction {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (error) {
    throw new LifecycleTransactionError(`failed to read lifecycle transaction ${statePath}`, {
      cause: error,
    });
  }
  assertLifecycleTransaction(value);
  if (value.statePath !== statePath) {
    throw new LifecycleTransactionError("lifecycle transaction statePath does not match its file");
  }
  return value;
}

export function isLifecycleTransaction(value: unknown): value is LifecycleTransaction {
  if (!isRecord(value)) return false;
  const launch = value["launch"];
  const deadlines = value["deadlines"];
  return (
    isNonEmptyString(value["id"]) &&
    (value["intent"] === "stop" || value["intent"] === "restart") &&
    isNonEmptyString(value["home"]) &&
    isPositiveInteger(value["oldPid"]) &&
    isLaunchDescriptor(launch) &&
    isRecord(deadlines) &&
    isPositiveNumber(deadlines["readyToExitAt"]) &&
    isPositiveNumber(deadlines["oldPidExitAt"]) &&
    isPositiveNumber(deadlines["restartReadyAt"]) &&
    deadlines["readyToExitAt"] <= deadlines["oldPidExitAt"] &&
    deadlines["oldPidExitAt"] <= deadlines["restartReadyAt"] &&
    isNonEmptyString(value["statePath"])
  );
}

export function buildLifecycleCoordinatorLaunch(
  transaction: LifecycleTransaction,
  capabilities: LifecycleCoordinatorCapabilities,
): LifecycleCoordinatorLaunch {
  const coordinatorArgs = [
    capabilities.nodePath,
    capabilities.coordinatorPath,
    transaction.statePath,
  ];
  if (capabilities.platform === "linux" && capabilities.systemdAvailable) {
    return {
      strategy: "systemd",
      command: "systemd-run",
      args: [
        "--user",
        "--unit",
        `humming-lifecycle-${systemdUnitComponent(transaction.id)}`,
        "--collect",
        "--property",
        "Type=exec",
        "--property",
        "StandardInput=null",
        ...lifecycleCoordinatorSystemdEnvArgs(),
        ...coordinatorArgs,
      ],
    };
  }
  return {
    strategy: "detached",
    command: capabilities.nodePath,
    args: coordinatorArgs.slice(1),
  };
}

function lifecycleCoordinatorSystemdEnvArgs(): readonly string[] {
  const prefixes = [
    "ANTHROPIC_",
    "CLAUDE_",
    "CODEX_",
    "COPILOT_",
    "GEMINI_",
    "GITHUB_",
    "GOOGLE_",
    "HUMMING_",
    "NODE_",
    "NPM_",
  ];
  const exact = new Set([
    "HOME",
    "LANG",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
  return Object.entries(process.env).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!exact.has(key) && !prefixes.some((prefix) => key.startsWith(prefix))) return [];
    return ["--setenv", `${key}=${value}`];
  });
}

export function armLifecycleCoordinator(
  transaction: LifecycleTransaction,
  capabilities: LifecycleCoordinatorCapabilities,
  processes: LifecycleCoordinatorProcesses = { spawn, spawnSync },
): { readonly strategy: "systemd" } | { readonly strategy: "detached"; readonly pid: number } {
  writeLifecycleTransaction(transaction);
  const launch = buildLifecycleCoordinatorLaunch(transaction, capabilities);
  if (launch.strategy === "systemd") {
    const result = processes.spawnSync(launch.command, launch.args, { encoding: "utf-8" });
    if (result.error !== undefined || result.status !== 0) {
      throw new LifecycleTransactionError(
        `failed to arm lifecycle coordinator with systemd: ${result.error?.message ?? result.stderr ?? "unknown error"}`,
      );
    }
    return { strategy: "systemd" };
  }
  const child = processes.spawn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (child.pid === undefined) {
    throw new LifecycleTransactionError("failed to arm lifecycle coordinator: no PID assigned");
  }
  child.unref();
  return { strategy: "detached", pid: child.pid };
}

export type LifecycleCoordinatorOutcome = "stopped" | "restarted" | "restartFailed";

export interface LifecycleCoordinatorResult {
  readonly outcome: LifecycleCoordinatorOutcome;
  readonly transaction: LifecycleTransaction;
  readonly error?: string;
}

export interface LifecycleCoordinatorRuntime {
  arm(): Promise<void>;
  beginLifecycle(transaction: LifecycleTransaction): Promise<{
    readonly accepted: true;
    readonly transactionId: string;
    readonly readyToExit: true;
  }>;
  isAlive(pid: number): boolean;
  delay(ms: number): Promise<void>;
  startBridge(transaction: LifecycleTransaction): Promise<void>;
  isReady(transaction: LifecycleTransaction): Promise<boolean>;
  forceTerminate(pid: number): Promise<void>;
  complete(result: LifecycleCoordinatorResult): Promise<void>;
  now(): number;
}

const COORDINATOR_POLL_MS = 100;

export async function runLifecycleCoordinator(
  transaction: LifecycleTransaction,
  runtime: LifecycleCoordinatorRuntime,
): Promise<LifecycleCoordinatorResult> {
  assertLifecycleTransaction(transaction);
  try {
    await runtime.arm();
    const ready = await runtime.beginLifecycle(transaction);
    if (ready.transactionId !== transaction.id || !ready.readyToExit) {
      throw new LifecycleTransactionError("Bridge returned an invalid lifecycle acknowledgement");
    }

    if (
      !(await waitForCondition(
        () => !runtime.isAlive(transaction.oldPid),
        transaction.deadlines.oldPidExitAt,
        runtime,
      ))
    ) {
      await runtime.forceTerminate(transaction.oldPid);
      if (
        !(await waitForCondition(
          () => !runtime.isAlive(transaction.oldPid),
          transaction.deadlines.restartReadyAt,
          runtime,
        ))
      ) {
        throw new LifecycleTransactionError(`old Bridge PID ${transaction.oldPid} did not exit`);
      }
    }

    if (transaction.intent === "stop") {
      const result = { outcome: "stopped", transaction } as const;
      await runtime.complete(result);
      return result;
    }

    await runtime.startBridge(transaction);
    if (
      !(await waitForCondition(
        () => runtime.isReady(transaction),
        transaction.deadlines.restartReadyAt,
        runtime,
      ))
    ) {
      throw new LifecycleTransactionError("new Bridge did not become ready before its deadline");
    }
    const result = { outcome: "restarted", transaction } as const;
    await runtime.complete(result);
    return result;
  } catch (error) {
    if (transaction.intent === "restart") {
      const result = {
        outcome: "restartFailed",
        transaction,
        error: error instanceof Error ? error.message : String(error),
      } as const;
      await runtime.complete(result);
    }
    throw error;
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  deadline: number,
  runtime: Pick<LifecycleCoordinatorRuntime, "delay" | "now">,
): Promise<boolean> {
  for (;;) {
    if (await predicate()) return true;
    if (runtime.now() >= deadline) return false;
    await runtime.delay(COORDINATOR_POLL_MS);
  }
}

function assertLifecycleTransaction(value: unknown): asserts value is LifecycleTransaction {
  if (!isLifecycleTransaction(value)) {
    throw new LifecycleTransactionError("invalid lifecycle transaction");
  }
}

function isLaunchDescriptor(value: unknown): value is LaunchDescriptor {
  return (
    isRecord(value) &&
    Array.isArray(value["spawnArgv"]) &&
    value["spawnArgv"].every((arg) => typeof arg === "string") &&
    isNonEmptyString(value["workingDirectory"]) &&
    isNonEmptyString(value["savedAt"]) &&
    !Number.isNaN(Date.parse(value["savedAt"]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function systemdUnitComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function coordinatorLogger(): LarkLogger {
  const logger: LarkLogger = {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    child(): LarkLogger {
      return logger;
    },
  };
  return logger;
}

function readRestartDeliveries(home: string): readonly LifecycleNoticeDelivery[] {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(home, "bridge.restart"), "utf-8")) as {
      deliveries?: unknown;
    };
    if (!Array.isArray(marker.deliveries)) return [];
    return marker.deliveries.filter(
      (item): item is LifecycleNoticeDelivery =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as { chatId?: unknown }).chatId === "string" &&
        typeof (item as { messageId?: unknown }).messageId === "string",
    );
  } catch {
    return [];
  }
}

async function notifyRestartFailed(home: string): Promise<void> {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf-8")) as {
      credentials?: { appId?: unknown; appSecret?: unknown };
      runtime?: { lifecycleNotifyChatIds?: unknown };
    };
    const appId = settings.credentials?.appId;
    const appSecret = settings.credentials?.appSecret;
    const chatIds = settings.runtime?.lifecycleNotifyChatIds;
    if (typeof appId !== "string" || typeof appSecret !== "string" || !Array.isArray(chatIds))
      return;
    const validChatIds = chatIds.filter((item): item is string => typeof item === "string");
    const logger = coordinatorLogger();
    const http = new LarkHttpClient({ appId, appSecret, logger });
    await sendLifecycleNotice({
      http,
      chatIds: validChatIds,
      kind: "restartFailed",
      replace: readRestartDeliveries(home),
      logger,
    });
  } catch {
    // notification failure must not hide the lifecycle failure record
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCoordinatorCli(argv: readonly string[]): Promise<void> {
  const statePath = argv[0];
  if (statePath === undefined || argv.length !== 1) {
    throw new LifecycleTransactionError("usage: lifecycle-coordinator <transaction-state-path>");
  }
  const transaction = readLifecycleTransaction(statePath);
  await runLifecycleCoordinator(transaction, {
    arm: async () => {
      await delay(50);
    },
    beginLifecycle: async (current) => {
      if (current.intent === "restart") {
        fs.mkdirSync(current.home, { recursive: true });
        fs.writeFileSync(
          path.join(current.home, "bridge.restart"),
          JSON.stringify({ requestedAt: Date.now(), deliveries: [] }),
          "utf-8",
        );
      }
      const response = await sendControlRequest(bridgeControlSocketPath(current.home), {
        method: "beginLifecycle",
        params: { transaction: current },
      });
      if (!response.ok) throw new LifecycleTransactionError(response.error);
      const ready = response.result as {
        readonly accepted: true;
        readonly transactionId: string;
        readonly readyToExit: true;
      };
      const exit = await sendControlRequest(bridgeControlSocketPath(current.home), {
        method: "shutdown",
        params: {},
      });
      if (!exit.ok) throw new LifecycleTransactionError(exit.error);
      return ready;
    },
    isAlive,
    delay,
    startBridge: async (current) => {
      try {
        fs.rmSync(bridgePidPath(current.home), { force: true });
      } catch {
        // stale PID cleanup is best effort
      }
      await startBridge({
        homeDir: current.home,
        selfPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "humming.js"),
        spawnArgv: current.launch.spawnArgv,
        workingDirectory: current.launch.workingDirectory,
      });
    },
    isReady: async (current) => {
      const pidText = fs.existsSync(bridgePidPath(current.home))
        ? fs.readFileSync(bridgePidPath(current.home), "utf-8").trim()
        : "";
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false;
      try {
        const response = await sendControlRequest(bridgeControlSocketPath(current.home), {
          method: "ping",
          params: {},
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    forceTerminate: async (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    },
    complete: async (result) => {
      if (result.outcome === "restartFailed") {
        await notifyRestartFailed(result.transaction.home);
        clearBridgeRestartMarker(result.transaction.home);
      }
      if (result.outcome === "stopped") {
        try {
          fs.rmSync(bridgePidPath(result.transaction.home), { force: true });
        } catch {
          // best effort
        }
      }
      fs.writeFileSync(
        result.transaction.statePath,
        `${JSON.stringify({ ...result.transaction, outcome: result.outcome, error: result.error }, null, 2)}\n`,
        "utf-8",
      );
    },
    now: Date.now,
  });
}

export function isCoordinatorMainModule(
  entryPath: string | undefined,
  modulePath = fileURLToPath(import.meta.url),
): boolean {
  if (entryPath === undefined) return false;
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isCoordinatorMainModule(process.argv[1])) {
  void runCoordinatorCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
