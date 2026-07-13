#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchDescriptor } from "./process-control.js";

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

function runCoordinatorCli(argv: readonly string[]): void {
  const statePath = argv[0];
  if (statePath === undefined || argv.length !== 1) {
    throw new LifecycleTransactionError("usage: lifecycle-coordinator <transaction-state-path>");
  }
  readLifecycleTransaction(statePath);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCoordinatorCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
