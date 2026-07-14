/**
 * `humming session list|bind|capabilities|models|modes|permissions|configure|send`
 * (docs/cli-command-model-SPEC.md §8–§11).
 */
import { Command } from "commander";
import path from "node:path";
import { FileSessionStore, hasSessionControls, listAgentSessions } from "../../../src/index.js";
import type {
  PendingSessionMessage,
  PendingTargetAgent,
  PermissionMode,
  SessionCapabilitiesSnapshot,
  SessionConfigControlValue,
  SessionControlPatch,
  SessionRecord,
} from "../../../src/index.js";
import {
  callBridgeControl,
  loadCliBase,
  resolveAgentProbeTarget,
  resolveOptionalChatScope,
  resolveRequiredChatScope,
  resolveSessionRepoTarget,
  SILENT_LOGGER,
  type GlobalOptions,
} from "../context.js";
import {
  addAgentOption,
  addChatIdOption,
  addConfigOption,
  addCwdOption,
  addJsonOption,
  addMessageOptions,
  addModeOption,
  addModelOption,
  addPermissionOption,
  addSessionIdOption,
  addThreadIdOption,
  countMessageInputs,
  parseConfigAssignments,
  parsePermissionOption,
  readMessageInput,
} from "../options.js";
import {
  printCapabilities,
  printJson,
  printModels,
  printModes,
  printPermissions,
  registerCapabilityProjection,
  type CapabilityProjection,
} from "../output.js";
import { sessionCapabilitiesSnapshotSchema } from "../config/schema.js";
import { CliError } from "../errors.js";

interface ChatScopeCliOptions {
  readonly chatId?: string;
  readonly threadId?: string;
}

interface SessionListCliOptions extends ChatScopeCliOptions {
  readonly agent?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

interface SessionBindCliOptions extends ChatScopeCliOptions {
  readonly agent?: string;
  readonly sessionId: string;
}

interface SessionConfigureCliOptions extends ChatScopeCliOptions {
  readonly agent?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly permission?: string;
  readonly config: readonly string[];
  readonly message?: string;
  readonly messageFile?: string;
  readonly messageStdin?: boolean;
}

interface SessionSendCliOptions extends ChatScopeCliOptions {
  readonly message?: string;
  readonly messageFile?: string;
  readonly messageStdin?: boolean;
}

const SESSION_LIVE_PROJECTIONS: readonly CapabilityProjection[] = [
  {
    name: "capabilities",
    description: "print the full live Session capability snapshot",
    project: printCapabilities,
  },
  {
    name: "models",
    description: "print the current Session's available Models",
    project: printModels,
  },
  {
    name: "modes",
    description: "print the current Session's available Modes",
    project: printModes,
  },
  {
    name: "permissions",
    description: "print the current Session's Humming approval-card policy",
    project: printPermissions,
  },
];

export function registerSessionCommand(program: Command): void {
  const session = program
    .command("session")
    .description("inspect and configure the current Topic Session");

  const list = session.command("list").description("list the Agent's own sessions for a repo");
  addAgentOption(list, { required: false });
  addCwdOption(list);
  addChatIdOption(list);
  addThreadIdOption(list);
  addJsonOption(list);
  list.action(async function (this: Command) {
    await runSessionList(this.optsWithGlobals<GlobalOptions & SessionListCliOptions>());
  });

  const bind = session
    .command("bind")
    .description("bind the current Topic Session to an existing Agent session");
  addAgentOption(bind, { required: false });
  addChatIdOption(bind);
  addThreadIdOption(bind);
  addSessionIdOption(bind);
  bind.action(async function (this: Command) {
    await runSessionBind(this.optsWithGlobals<GlobalOptions & SessionBindCliOptions>());
  });

  for (const projection of SESSION_LIVE_PROJECTIONS) {
    registerCapabilityProjection<GlobalOptions & ChatScopeCliOptions & { json?: boolean }>(
      session,
      projection,
      (cmd) => {
        addChatIdOption(cmd);
        addThreadIdOption(cmd);
      },
      fetchLiveCapabilities,
    );
  }

  const configure = session
    .command("configure")
    .description(
      "set the desired Agent/Model/Mode/Permission/Config for the current Topic Session",
    );
  addAgentOption(configure, { required: false });
  addCwdOption(configure);
  addModelOption(configure);
  addModeOption(configure);
  addPermissionOption(configure);
  addConfigOption(configure);
  addChatIdOption(configure);
  addThreadIdOption(configure);
  addMessageOptions(configure);
  configure.action(async function (this: Command) {
    await runSessionConfigure(this.optsWithGlobals<GlobalOptions & SessionConfigureCliOptions>());
  });

  const send = session.command("send").description("send a Message to the current Topic Session");
  addChatIdOption(send);
  addThreadIdOption(send);
  addMessageOptions(send);
  send.action(async function (this: Command) {
    await runSessionSend(this.optsWithGlobals<GlobalOptions & SessionSendCliOptions>());
  });
}

async function fetchLiveCapabilities(
  globals: GlobalOptions & ChatScopeCliOptions,
): Promise<SessionCapabilitiesSnapshot> {
  const { homeDir } = loadCliBase(globals);
  const { chatId, threadId } = resolveRequiredChatScope(globals, "session capabilities");
  const result = await callBridgeControl(homeDir, {
    method: "capabilities",
    params: { chatId, threadId },
  });
  return parseCapabilitiesSnapshot(result);
}

/**
 * @throws {CliError} when the response does not match the expected envelope.
 */
function parseCapabilitiesSnapshot(value: unknown): SessionCapabilitiesSnapshot {
  const result = sessionCapabilitiesSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(`invalid capabilities response from bridge: ${result.error.message}`);
  }
  return result.data;
}

async function runSessionList(globals: GlobalOptions & SessionListCliOptions): Promise<void> {
  const base = loadCliBase(globals);
  const scope = resolveOptionalChatScope(globals);
  const target = resolveSessionRepoTarget(base, {
    ...(globals.agent !== undefined ? { agent: globals.agent } : {}),
    ...(globals.cwd !== undefined ? { cwd: globals.cwd } : {}),
    ...(scope.chatId !== undefined ? { chatId: scope.chatId } : {}),
    threadId: scope.threadId,
  });
  const result = await listAgentSessions({
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
    ...(target.invocation.env ? { env: { ...target.invocation.env } } : {}),
    logger: SILENT_LOGGER,
  });
  if (globals.json === true) {
    printJson({
      agent: target.invocation.label,
      cwd: target.cwd,
      supportsResume: result.supportsResume,
      supportsLoad: result.supportsLoad,
      sessions: result.sessions,
    });
    return;
  }
  const lines = [`Agent sessions for ${target.invocation.label} in ${target.cwd}:`, ""];
  if (result.sessions.length === 0) lines.push("  (none)");
  for (const s of result.sessions) {
    lines.push(`  • ${s.title ?? "Untitled session"}`);
    lines.push(`    sessionId: ${s.sessionId}`);
    if (s.updatedAt) lines.push(`    updatedAt: ${s.updatedAt}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runSessionBind(globals: GlobalOptions & SessionBindCliOptions): Promise<void> {
  const base = loadCliBase(globals);
  const { chatId, threadId } = resolveRequiredChatScope(globals, "session bind");
  const target = resolveSessionRepoTarget(base, {
    ...(globals.agent !== undefined ? { agent: globals.agent } : {}),
    chatId,
    threadId,
  });
  const result = await listAgentSessions({
    command: target.invocation.command,
    args: [...target.invocation.args],
    cwd: target.cwd,
    ...(target.invocation.env ? { env: { ...target.invocation.env } } : {}),
    logger: SILENT_LOGGER,
  });
  if (!result.supportsResume && !result.supportsLoad) {
    throw new CliError(
      "agent can list sessions but does not support ACP session/resume or session/load",
    );
  }
  const found = result.sessions.find((s) => s.sessionId === globals.sessionId);
  if (!found)
    throw new CliError("session-id was not found in the current chat repo for this agent");
  if (path.resolve(found.cwd) !== path.resolve(target.cwd)) {
    throw new CliError(
      `refusing to bind a session outside the current chat repo: session cwd=${found.cwd}, current repo=${target.cwd}`,
    );
  }

  const now = Date.now();
  const record: SessionRecord = {
    chatId,
    threadId,
    sessionId: found.sessionId,
    ...(found.title !== undefined ? { title: found.title } : {}),
    ...(found.updatedAt !== undefined ? { sessionUpdatedAt: found.updatedAt } : {}),
    agentCommand: target.invocation.command,
    agentArgs: [...target.invocation.args],
    ...(target.invocation.env ? { agentEnv: { ...target.invocation.env } } : {}),
    ...(target.invocation.label !== undefined ? { agentLabel: target.invocation.label } : {}),
    cwd: target.cwd,
    createdAt: now,
    updatedAt: now,
  };

  let result2: unknown;
  try {
    result2 = await callBridgeControl(base.homeDir, { method: "bindSession", params: { record } });
  } catch {
    const store = new FileSessionStore(base.dataDir);
    await store.init();
    try {
      await store.bindThreadSession(record);
    } finally {
      await store.close();
    }
    result2 = { bound: true, sessionId: record.sessionId };
  }
  printJson(result2);
}

async function runSessionConfigure(
  globals: GlobalOptions & SessionConfigureCliOptions,
): Promise<void> {
  const permission = parsePermissionOption(globals.permission);
  const config = parseConfigAssignments(globals.config ?? []);
  const controls = buildControlPatch({
    ...(globals.model !== undefined ? { model: globals.model } : {}),
    ...(globals.mode !== undefined ? { mode: globals.mode } : {}),
    ...(permission !== undefined ? { permission } : {}),
    config,
  });
  const messageCount = countMessageInputs(globals);
  if (globals.agent === undefined && controls === undefined) {
    throw new CliError(
      messageCount > 0
        ? "session configure requires at least one profile field (--agent/--model/--mode/--permission/--config); use `session send` to send a message without changing the profile"
        : "session configure requires at least one profile field: --agent, --model, --mode, --permission, or --config",
    );
  }
  if (globals.cwd !== undefined && globals.agent === undefined) {
    throw new CliError("--cwd is only valid with --agent for `session configure`");
  }

  const base = loadCliBase(globals);
  const { chatId, threadId } = resolveRequiredChatScope(globals, "session configure");

  let targetAgent: PendingTargetAgent | undefined;
  if (globals.agent !== undefined) {
    const target = resolveAgentProbeTarget(base, {
      agent: globals.agent,
      ...(globals.cwd !== undefined ? { cwd: globals.cwd } : {}),
      chatId,
      threadId,
    });
    const now = Date.now();
    targetAgent = {
      sessionId: `profile:${now}`,
      profileOnly: true,
      agentCommand: target.invocation.command,
      agentArgs: [...target.invocation.args],
      ...(target.invocation.env ? { agentEnv: { ...target.invocation.env } } : {}),
      ...(target.invocation.label !== undefined ? { agentLabel: target.invocation.label } : {}),
      cwd: target.cwd,
    };
  }

  const message: PendingSessionMessage | undefined =
    messageCount > 0 ? { prompt: readMessageInput(globals), createdAt: Date.now() } : undefined;

  const result = await callBridgeControl(base.homeDir, {
    method: "configureSession",
    params: {
      chatId,
      threadId,
      ...(targetAgent ? { targetAgent } : {}),
      ...(controls ? { controls } : {}),
      ...(message ? { message } : {}),
    },
  });
  printJson(result);
}

async function runSessionSend(globals: GlobalOptions & SessionSendCliOptions): Promise<void> {
  const { homeDir } = loadCliBase(globals);
  const { chatId, threadId } = resolveRequiredChatScope(globals, "session send");
  const messageCount = countMessageInputs(globals);
  if (messageCount !== 1) {
    throw new CliError(
      "session send requires exactly one message source: --message, --message-file, or --message-stdin",
    );
  }
  const message: PendingSessionMessage = {
    prompt: readMessageInput(globals),
    createdAt: Date.now(),
  };
  const result = await callBridgeControl(homeDir, {
    method: "sendMessage",
    params: { chatId, threadId, message },
  });
  printJson(result);
}

interface ControlPatchInput {
  readonly model?: string;
  readonly mode?: string;
  readonly permission?: PermissionMode;
  readonly config: Record<string, SessionConfigControlValue>;
}

function buildControlPatch(input: ControlPatchInput): SessionControlPatch | undefined {
  const patch: SessionControlPatch = {};
  if (input.model === "auto") patch.clearModelId = true;
  else if (input.model !== undefined) patch.modelId = input.model;
  if (input.mode !== undefined) patch.modeId = input.mode;
  if (input.permission !== undefined) patch.bridgePermissionMode = input.permission;
  if (Object.keys(input.config).length > 0) patch.config = input.config;
  return hasSessionControls(patch) ? patch : undefined;
}
