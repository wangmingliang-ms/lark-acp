/**
 * `humming setup` — one-shot Feishu/Lark bot registration
 * (docs/cli-command-model-SPEC.md §4, §6 command tree).
 */
import { Command } from "commander";
import {
  LarkHttpClient,
  runFeishuLinkRegistration,
  type FeishuLinkRegistrationProgress,
  type FeishuRegistrationDomain,
} from "../../../src/index.js";
import {
  readSettingsFileObject,
  readSettingsObjectField,
  SettingsFileFormatError,
  writeSettingsFileObject,
} from "../../../src/settings-file/settings-file.js";
import { installHomeBootstrap, readConfigFile, type FileConfig } from "../config/load.js";
import { SILENT_LOGGER, type GlobalOptions } from "../context.js";
import { CliError } from "../errors.js";

interface SetupCliOptions {
  readonly domain: string;
  readonly force?: boolean;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("register a Feishu/Lark bot and save its credentials")
    .option("--domain <domain>", "registration domain: feishu or lark", "feishu")
    .option("--force", "re-run registration even if credentials already exist")
    .action(async function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOptions & SetupCliOptions>();
      if (globals.domain !== "feishu" && globals.domain !== "lark") {
        throw new CliError(`--domain must be feishu or lark (got: ${globals.domain})`);
      }
      await runSetup(globals, globals.domain, globals.force === true);
    });
}

type SetupCredentials = {
  readonly appId: string;
  readonly appSecret: string;
};

type SetupSummary = SetupCredentials & {
  readonly settingsPath: string;
  readonly domain: FeishuRegistrationDomain;
  readonly botName?: string;
};

type SetupLifecycleRegistration = SetupCredentials & {
  readonly domain: FeishuRegistrationDomain;
  readonly ownerOpenId?: string;
  readonly botName?: string;
};

type SetupLifecycleNotificationRequest = SetupCredentials & {
  readonly domain: FeishuRegistrationDomain;
  readonly ownerOpenId: string;
  readonly botName?: string;
};

type SetupLifecycleNotificationSender = (
  setup: SetupLifecycleNotificationRequest,
) => Promise<string | null>;

type SetupLifecycleEnrollmentResult =
  | { readonly enrolled: true; readonly chatId: string }
  | {
      readonly enrolled: false;
      readonly reason: "missing-owner-open-id" | "no-chat-id" | "failed";
    };

type SetupCredentialResult = {
  readonly credentials: SetupLifecycleRegistration;
  readonly created: boolean;
};

type SetupCredentialRegistration = (
  target: FeishuRegistrationDomain,
) => Promise<SetupLifecycleRegistration | null>;

export function maskCredentialId(value: string): string {
  if (value.length <= 8) return "[saved]";
  const prefix = value.startsWith("cli_") ? "cli_" : value.slice(0, 4);
  return `${prefix}…${value.slice(-4)}`;
}

export function formatSetupSummary(summary: SetupSummary): string {
  return [
    "Feishu / Lark bot configured.",
    `Settings: ${summary.settingsPath}`,
    `App ID: ${maskCredentialId(summary.appId)}`,
    `App Secret: [saved]`,
    `Domain: ${summary.domain}`,
    ...(summary.botName !== undefined ? [`Bot: ${summary.botName}`] : []),
    "",
    `Next: humming bridge start`,
    "",
  ].join("\n");
}

/**
 * Merge scan-created credentials into settings.json while preserving unrelated settings.
 *
 * @throws {CliError} when the existing settings file cannot be parsed as a JSON object.
 */
export function writeSetupCredentials(settingsPath: string, credentials: SetupCredentials): void {
  const existing = readSettingsRootOrCliError(settingsPath);
  const next = {
    ...existing,
    credentials: { appId: credentials.appId, appSecret: credentials.appSecret },
  };
  writeSettingsFileObject(settingsPath, next);
}

function writeSetupMetadata(settingsPath: string, setup: SetupLifecycleRegistration): void {
  const existing = readSettingsRootOrCliError(settingsPath);
  const currentSetup = readSettingsObjectField(existing, "setup");
  const nextSetup = {
    ...currentSetup,
    domain: setup.domain,
    ...(setup.ownerOpenId !== undefined ? { ownerOpenId: setup.ownerOpenId } : {}),
    ...(setup.botName !== undefined ? { botName: setup.botName } : {}),
  };
  writeSettingsFileObject(settingsPath, { ...existing, setup: nextSetup });
}

export async function ensureSetupCredentials(
  existing: FileConfig,
  settingsPath: string,
  target: FeishuRegistrationDomain,
  force: boolean,
  register: SetupCredentialRegistration = registerSetupCredentials,
): Promise<SetupCredentialResult> {
  const appId = existing.credentials.appId;
  const appSecret = existing.credentials.appSecret;
  if (!force && appId !== undefined && appSecret !== undefined) {
    return {
      credentials: {
        appId,
        appSecret,
        domain: existing.setup.domain ?? target,
        ...(existing.setup.ownerOpenId !== undefined
          ? { ownerOpenId: existing.setup.ownerOpenId }
          : {}),
        ...(existing.setup.botName !== undefined ? { botName: existing.setup.botName } : {}),
      },
      created: false,
    };
  }

  const result = await register(target);
  if (result === null) {
    throw new CliError("Feishu / Lark setup did not complete. No credentials were changed.");
  }
  writeSetupCredentials(settingsPath, { appId: result.appId, appSecret: result.appSecret });
  writeSetupMetadata(settingsPath, result);
  return { credentials: result, created: true };
}

async function registerSetupCredentials(
  target: FeishuRegistrationDomain,
): Promise<SetupLifecycleRegistration | null> {
  return runFeishuLinkRegistration({ domain: target, onProgress: printSetupProgress });
}

function appendLifecycleNotifyChatId(settingsPath: string, chatId: string): void {
  const existing = readSettingsRootOrCliError(settingsPath);
  const runtime = readSettingsObjectField(existing, "runtime");
  const current = readStringArrayForWrite(runtime["lifecycleNotifyChatIds"]);
  const nextRuntime = {
    ...runtime,
    lifecycleNotifyChatIds: current.includes(chatId) ? current : [...current, chatId],
  };
  writeSettingsFileObject(settingsPath, { ...existing, runtime: nextRuntime });
}

export async function enrollSetupLifecycleNotification(
  settingsPath: string,
  setup: SetupLifecycleRegistration,
  sendNotification: SetupLifecycleNotificationSender = sendSetupLifecycleNotification,
): Promise<SetupLifecycleEnrollmentResult> {
  const ownerOpenId = setup.ownerOpenId;
  if (ownerOpenId === undefined) return { enrolled: false, reason: "missing-owner-open-id" };
  try {
    const chatId = await sendNotification({
      appId: setup.appId,
      appSecret: setup.appSecret,
      domain: setup.domain,
      ownerOpenId,
      ...(setup.botName !== undefined ? { botName: setup.botName } : {}),
    });
    if (chatId === null || chatId.length === 0) return { enrolled: false, reason: "no-chat-id" };
    appendLifecycleNotifyChatId(settingsPath, chatId);
    return { enrolled: true, chatId };
  } catch {
    return { enrolled: false, reason: "failed" };
  }
}

async function sendSetupLifecycleNotification(
  setup: SetupLifecycleNotificationRequest,
): Promise<string | null> {
  const http = new LarkHttpClient({
    appId: setup.appId,
    appSecret: setup.appSecret,
    logger: SILENT_LOGGER,
  });
  const result = await http.sendCardToOpenId(
    setup.ownerOpenId,
    buildSetupLifecycleEnrollmentCard(setup),
  );
  return result.chatId;
}

function buildSetupLifecycleEnrollmentCard(setup: SetupLifecycleNotificationRequest): object {
  const title = "✅ Humming 已配置";
  const botLine = setup.botName !== undefined ? `\n• Bot：${setup.botName}` : "";
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text" as const, content: title }, template: "green" as const },
    body: {
      elements: [
        {
          tag: "markdown" as const,
          content: `这台机器已完成 Humming 配置。后续 bridge start / stop / restart / crash 生命周期通知会发送到这个单聊。${botLine}`,
        },
      ],
    },
  };
}

function readStringArrayForWrite(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CliError("settings file runtime.lifecycleNotifyChatIds must be an array");
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      throw new CliError(`settings file runtime.lifecycleNotifyChatIds[${index}] must be a string`);
    }
    if (item.length > 0 && !out.includes(item)) out.push(item);
  });
  return out;
}

/**
 * @throws {CliError} when the settings file cannot be parsed as a JSON object.
 */
function readSettingsRootOrCliError(settingsPath: string): Record<string, unknown> {
  try {
    return readSettingsFileObject(settingsPath);
  } catch (err) {
    if (err instanceof SettingsFileFormatError) throw new CliError(err.message);
    throw err;
  }
}

function printSetupProgress(event: FeishuLinkRegistrationProgress): void {
  process.stdout.write(formatSetupProgress(event));
}

export function formatSetupProgress(event: FeishuLinkRegistrationProgress): string {
  switch (event.kind) {
    case "connecting":
      return "Connecting to Feishu / Lark...\n";
    case "link":
      return [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "ACTION REQUIRED: open this setup link in Feishu / Lark",
        event.url,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        "Then log in if prompted, choose or create the group, search for the bot name, and confirm creation.",
        "",
      ].join("\n");
    case "polling":
      return "Waiting for setup completion...\n";
    case "success":
      return `Configuration received for ${maskCredentialId(event.appId)}.\n\n`;
    case "failed":
      return `Setup failed or was denied: ${event.reason}\n`;
    default:
      return assertNever(event);
  }
}

export function formatSetupCredentialStep(result: SetupCredentialResult): string {
  if (result.created) return "Credentials: created and saved.\n\n";
  return "Credentials: already configured, skipping app registration.\n\n";
}

export function formatSetupLifecycleEnrollment(result: SetupLifecycleEnrollmentResult): string {
  if (result.enrolled) return `Lifecycle notifications enrolled for setup P2P chat.\n\n`;
  return `Lifecycle notification auto-enrollment skipped (${result.reason}). You can set runtime.lifecycleNotifyChatIds manually later.\n\n`;
}

export async function runSetup(
  globals: GlobalOptions,
  target: FeishuRegistrationDomain,
  force: boolean,
): Promise<void> {
  const { homeDir, configPath } = installHomeBootstrap(globals);

  const existing = readConfigFile(configPath);

  process.stdout.write("Feishu / Lark setup\n\n");
  const credentialStep = await ensureSetupCredentials(existing, configPath, target, force);
  process.stdout.write(formatSetupCredentialStep(credentialStep));

  const result = credentialStep.credentials;
  const lifecycleEnrollment = await enrollSetupLifecycleNotification(configPath, result);
  process.stdout.write(formatSetupLifecycleEnrollment(lifecycleEnrollment));
  process.stdout.write(
    formatSetupSummary({
      settingsPath: configPath,
      appId: result.appId,
      appSecret: result.appSecret,
      domain: result.domain,
      ...(result.botName !== undefined ? { botName: result.botName } : {}),
    }),
  );
}

function assertNever(x: never): never {
  throw new Error(`unexpected setup progress event: ${String(x)}`);
}
