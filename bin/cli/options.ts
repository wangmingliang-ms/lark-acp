/**
 * Reusable Commander option declarations for the common flag vocabulary
 * (docs/cli-command-model-SPEC.md §5) and the exactly-one Message input
 * source used by `session configure`/`session send`.
 */
import fs from "node:fs";
import { Command, Option } from "commander";
import { PERMISSION_MODES } from "../../src/index.js";
import type { PermissionMode, SessionConfigControlValue } from "../../src/index.js";
import { parseConfigAssignmentValue } from "./config/schema.js";
import { expandTilde } from "./config/load.js";
import { CliError, formatError } from "./errors.js";
import { messageContentSchema } from "./config/schema.js";

export function addAgentOption(cmd: Command, opts: { readonly required: boolean }): Command {
  const flags = "-a, --agent <id>";
  const description = "Agent preset id or raw command";
  return opts.required ? cmd.requiredOption(flags, description) : cmd.option(flags, description);
}

export function addCwdOption(cmd: Command): Command {
  return cmd.option("-C, --cwd <path>", "working directory for the Agent invocation");
}

export function addChatIdOption(cmd: Command): Command {
  return cmd.option(
    "--chat-id <id>",
    "Lark chat id (defaults to $HUMMING_CHAT_ID inside a Humming-spawned agent)",
  );
}

export function addThreadIdOption(cmd: Command): Command {
  return cmd.option(
    "--thread-id <id>",
    "Lark topic/thread id (defaults to $HUMMING_THREAD_ID, or the chat's main conversation)",
  );
}

export function addSessionIdOption(cmd: Command): Command {
  return cmd.requiredOption("--session-id <id>", "ACP session id reported by the Agent");
}

export function addJsonOption(cmd: Command): Command {
  return cmd.option("--json", "print machine-readable JSON instead of a formatted summary");
}

export function addModelOption(cmd: Command): Command {
  return cmd.option(
    "-m, --model <id>",
    "desired Model id; use `auto` to clear an explicit override",
  );
}

export function addModeOption(cmd: Command): Command {
  return cmd.option("--mode <id>", "desired Mode id");
}

export function addPermissionOption(cmd: Command): Command {
  return cmd.option(
    "-p, --permission <mode>",
    `desired Humming approval-card policy (${PERMISSION_MODES.join("|")})`,
  );
}

export function addConfigOption(cmd: Command): Command {
  return cmd.option(
    "-c, --config <id=value>",
    "desired Agent config value, repeatable (value `true`/`false` becomes a boolean control)",
    collect,
    [] as string[],
  );
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/** Parse `--permission <mode>` against the fixed set of Humming permission modes. */
export function parsePermissionOption(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (!isPermissionMode(value)) {
    throw new CliError(
      `--permission must be one of: ${PERMISSION_MODES.join(" | ")} (got: ${value})`,
    );
  }
  return value;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Parse repeatable `--config <id=value>` assignments into a config control map. */
export function parseConfigAssignments(
  assignments: readonly string[],
): Record<string, SessionConfigControlValue> {
  const out: Record<string, SessionConfigControlValue> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq <= 0 || eq === assignment.length - 1) {
      throw new CliError(`--config requires <configId=value> (got: ${assignment})`);
    }
    const configId = assignment.slice(0, eq);
    const value = assignment.slice(eq + 1);
    out[configId] = parseConfigAssignmentValue(value);
  }
  return out;
}

export function addMessageOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option("--message <text>", "message text").conflicts(["messageFile", "messageStdin"]),
    )
    .addOption(
      new Option("--message-file <path>", "read the message from a file").conflicts([
        "message",
        "messageStdin",
      ]),
    )
    .addOption(
      new Option("--message-stdin", "read the message from stdin").conflicts([
        "message",
        "messageFile",
      ]),
    );
}

export interface MessageInputOptions {
  readonly message?: string;
  readonly messageFile?: string;
  readonly messageStdin?: boolean;
}

/** Number of message input sources actually supplied (0, 1, or conflicting >1). */
export function countMessageInputs(opts: MessageInputOptions): number {
  return [
    opts.message !== undefined,
    opts.messageFile !== undefined,
    opts.messageStdin === true,
  ].filter(Boolean).length;
}

/**
 * Read and validate the one supplied message source. Callers must first
 * assert exactly one source is present via {@link countMessageInputs}.
 *
 * @throws {CliError} when the resolved content is empty once trimmed, or a
 *         file/stdin read fails.
 */
export function readMessageInput(opts: MessageInputOptions): string {
  const raw = readRawMessageInput(opts);
  const result = messageContentSchema.safeParse(raw);
  if (!result.success) {
    throw new CliError(result.error.issues[0]?.message ?? "message must not be empty");
  }
  return result.data;
}

function readRawMessageInput(opts: MessageInputOptions): string {
  if (typeof opts.message === "string") return opts.message;
  if (opts.messageFile !== undefined) {
    const filePath = expandTilde(opts.messageFile);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new CliError(`failed to read --message-file ${filePath}: ${formatError(err)}`);
    }
  }
  if (opts.messageStdin === true) {
    try {
      return fs.readFileSync(0, "utf-8");
    } catch (err) {
      throw new CliError(`failed to read --message-stdin: ${formatError(err)}`);
    }
  }
  throw new CliError(
    "a message input source is required: --message, --message-file, or --message-stdin",
  );
}
