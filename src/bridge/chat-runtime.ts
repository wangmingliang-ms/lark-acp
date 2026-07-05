import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { AgentStatus, LarkPresenter, SessionCardMeta } from "../presenter/presenter.js";
import { LarkAcpClient, PERMISSION_MODES, type PermissionMode } from "../acp/lark-acp-client.js";
import {
  spawnAgent,
  spawnAndResumeAgent,
  killAgent,
  AgentDisconnectedError,
  type AgentProcess,
  type SpawnAgentOptions,
} from "../acp/agent-process.js";
import type {
  SessionCapabilitiesSnapshot,
  SessionControls,
  SessionStore,
} from "../session-store/session-store.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  /** Message used as reply/card anchor for this prompt. */
  messageId: string;
  chatId: string;
}

export interface ChatRuntimeOptions {
  chatId: string;
  /**
   * Feishu topic (话题) this runtime serves, or `null` for the chat's "main"
   * (non-topic) conversation. Each `(chatId, threadId)` pair gets its own
   * runtime, agent subprocess, and ACP session.
   */
  threadId: string | null;
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  showThoughts: boolean;
  showTools: boolean;
  showCancelButton: boolean;
  permissionTimeoutMs: number;
  permissionMode: PermissionMode;
  agentLabel?: string;
  presenter: LarkPresenter;
  sessionStore: SessionStore;
  logger: LarkLogger;
}

interface ChatRuntimeState {
  client: LarkAcpClient;
  agent: AgentProcess;
  sessionCapabilities: SessionCapabilitiesSnapshot;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  /** Last messageId we processed — used to attach exit notices to a thread. */
  lastMessageId: string | null;
}

/**
 * Per-chat ACP runtime: owns one agent subprocess, one `LarkAcpClient`,
 * and a FIFO queue of pending Lark messages.
 *
 * Constructed lazily by {@link LarkBridge} on the first message for a
 * chat. Subsequent messages are enqueued via {@link enqueue}; the runtime
 * processes them serially.
 */
export class ChatRuntime {
  private readonly opts: ChatRuntimeOptions;
  private readonly logger: LarkLogger;
  private state: ChatRuntimeState | null = null;
  private aborted = false;
  /** True after the user pressed Stop or sent /cancel for the in-flight prompt. */
  private cancelRequested = false;
  /** Set while a prompt is in-flight — exit handler defers to handlePromptError then. */
  private promptInFlight = false;
  /**
   * Set while the first message is bootstrapping the agent (spawn +
   * initialize + newSession/resume), a window that can take many seconds.
   * During it `state` is still null, so without this flag the idle-eviction
   * getters below would report the runtime as idle-since-epoch and evict it
   * mid-spawn. See {@link processing} / {@link lastActivity}.
   */
  private booting = false;
  /** Wall-clock construction time — the `lastActivity` floor before `state` exists. */
  private readonly createdAt = Date.now();

  constructor(opts: ChatRuntimeOptions) {
    this.opts = opts;
    this.logger = opts.logger.child({ name: "chat", chatId: opts.chatId, threadId: opts.threadId });
  }

  get chatId(): string {
    return this.opts.chatId;
  }

  get threadId(): string | null {
    return this.opts.threadId;
  }

  get processing(): boolean {
    // A booting runtime is busy even though `state` is still null — it must
    // not be evicted while its agent subprocess is spawning.
    return this.booting || (this.state?.processing ?? false);
  }

  get lastActivity(): number {
    // Fall back to construction time (not 0) so a freshly-created or still-
    // booting runtime looks recently active, never "idle since the epoch".
    return this.state?.lastActivity ?? this.createdAt;
  }

  /**
   * Enqueue a Lark message; spawns the agent on first call.
   *
   * @throws if bootstrap (spawn / initialize / newSession / resume) fails.
   *         The runtime is left in an unusable state — caller must drop it.
   */
  async enqueue(message: PendingMessage): Promise<void> {
    if (!this.state) {
      // A previous agent crash / idle exit tears down `state`; the next user
      // message should spawn a fresh agent, not inherit the old aborted flag.
      this.aborted = false;
      this.cancelRequested = false;
      this.booting = true;
      try {
        this.state = await this.bootstrap(message);
      } catch (err) {
        this.aborted = true;
        throw err;
      } finally {
        this.booting = false;
      }
    }

    this.state.lastActivity = Date.now();
    this.state.queue.push(message);

    if (!this.state.processing) {
      this.state.processing = true;
      this.processQueue().catch((err) => this.logger.error({ err }, "queue processor crashed"));
    }
  }

  /**
   * Cancel the current prompt (if any) and clear the queue. Keeps the
   * agent process alive so the next message can resume the same session.
   */
  async cancel(): Promise<void> {
    if (!this.state) return;
    this.logger.info("cancelling current task");
    this.cancelRequested = true;
    this.state.client.cancelPendingPermission();
    try {
      await this.state.agent.connection.cancel({ sessionId: this.state.agent.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "cancel notification rejected");
    }
    this.state.queue.length = 0;
  }

  /** Tear down the agent process so the next message starts fresh. */
  shutdown(): void {
    if (!this.state) return;
    this.logger.info("shutting down chat runtime");
    this.state.client.cancelPendingPermission();
    killAgent(this.state.agent.process);
    this.state = null;
    this.aborted = true;
  }

  /** Forward a card-action event to the underlying ACP client. */
  handleCardAction(requestId: string, optionId: string): boolean {
    return this.state?.client.handleCardAction(requestId, optionId) ?? false;
  }

  capabilities(): SessionCapabilitiesSnapshot {
    const state = this.state;
    if (!state) throw new Error("session runtime is not started yet");
    return {
      ...state.sessionCapabilities,
      bridgePermissionMode: state.client.getPermissionMode(),
    };
  }

  async applyControls(controls: SessionControls): Promise<void> {
    const state = this.state;
    if (!state) throw new Error("session runtime is not started yet");
    await this.applyControlsToState(state, controls);
    await this.persistSession(state.agent.sessionId, controls);
  }

  private async bootstrap(firstMessage: PendingMessage): Promise<ChatRuntimeState> {
    this.logger.info("creating chat runtime");

    const latest = await this.opts.sessionStore.getLatest(this.opts.chatId, this.opts.threadId);
    let stateRef: ChatRuntimeState | null = null;
    let currentClient: LarkAcpClient;
    const metaProvider = (): SessionCardMeta =>
      stateRef
        ? sessionMetaFromSnapshot({
            ...stateRef.sessionCapabilities,
            bridgePermissionMode: stateRef.client.getPermissionMode(),
          })
        : {
            agent: displayAgent({
              ...(this.opts.agentLabel !== undefined ? { label: this.opts.agentLabel } : {}),
              command: this.opts.agentCommand,
              args: this.opts.agentArgs,
              cwd: this.opts.agentCwd,
            }),
            mode: "—",
            model: "—",
            permission: bridgePermissionLabel(currentClient.getPermissionMode()),
          };
    const client = new LarkAcpClient({
      presenter: this.opts.presenter,
      logger: this.logger,
      showThoughts: this.opts.showThoughts,
      showTools: this.opts.showTools,
      showCancelButton: this.opts.showCancelButton,
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
      permissionMode: latest?.controls?.bridgePermissionMode ?? this.opts.permissionMode,
      metaProvider,
    });
    currentClient = client;

    const spawnOpts: SpawnAgentOptions = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      logger: this.logger,
    };

    let agent: AgentProcess;
    if (latest) {
      this.logger.info({ previousSessionId: latest.sessionId }, "attempting resume");
      const result = await spawnAndResumeAgent(spawnOpts, latest.sessionId);
      agent = result.agent;
    } else {
      agent = await spawnAgent(spawnOpts);
    }

    await this.persistSession(agent.sessionId);

    const state: ChatRuntimeState = {
      client,
      agent,
      sessionCapabilities: this.buildCapabilitiesSnapshot(agent, client),
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      lastMessageId: firstMessage.messageId,
    };
    stateRef = state;

    agent.process.on("exit", (code, signal) => {
      this.handleUnexpectedExit(code, signal);
    });

    if (latest?.controls) await this.applyControlsToState(state, latest.controls);

    return state;
  }

  private buildCapabilitiesSnapshot(
    agent: AgentProcess,
    client: LarkAcpClient,
  ): SessionCapabilitiesSnapshot {
    return {
      session: {
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId: agent.sessionId,
      },
      agent: {
        ...(this.opts.agentLabel !== undefined ? { label: this.opts.agentLabel } : {}),
        command: this.opts.agentCommand,
        args: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
      },
      ...agent.sessionCapabilities,
      bridgePermissionModes: PERMISSION_MODES,
      bridgePermissionMode: client.getPermissionMode(),
    };
  }

  private async applyControlsToState(
    state: ChatRuntimeState,
    controls: SessionControls,
  ): Promise<void> {
    if (controls.modelId !== undefined) {
      await state.agent.connection.unstable_setSessionModel({
        sessionId: state.agent.sessionId,
        modelId: controls.modelId,
      });
      if (state.sessionCapabilities.models) {
        state.sessionCapabilities = {
          ...state.sessionCapabilities,
          models: { ...state.sessionCapabilities.models, currentModelId: controls.modelId },
        };
      }
    }
    if (controls.modeId !== undefined) {
      await state.agent.connection.setSessionMode({
        sessionId: state.agent.sessionId,
        modeId: controls.modeId,
      });
      if (state.sessionCapabilities.modes) {
        state.sessionCapabilities = {
          ...state.sessionCapabilities,
          modes: { ...state.sessionCapabilities.modes, currentModeId: controls.modeId },
        };
      }
    }
    for (const [configId, value] of Object.entries(controls.config ?? {})) {
      const response = await state.agent.connection.setSessionConfigOption({
        sessionId: state.agent.sessionId,
        configId,
        ...value,
      });
      state.sessionCapabilities = {
        ...state.sessionCapabilities,
        configOptions: response.configOptions,
      };
    }
    if (controls.bridgePermissionMode !== undefined) {
      state.client.setPermissionMode(controls.bridgePermissionMode);
      state.sessionCapabilities = {
        ...state.sessionCapabilities,
        bridgePermissionMode: controls.bridgePermissionMode,
      };
    }
  }

  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    // If a prompt is in-flight or we've torn down deliberately, the prompt
    // error path / shutdown already covers user-facing notification.
    if (this.promptInFlight || this.aborted || !this.state) return;

    const exitedNormally = code === 0 && signal === null;
    if (exitedNormally) {
      this.logger.info({ code, signal }, "agent exited while idle");
    } else {
      this.logger.error({ code, signal }, "agent exited unexpectedly while idle");
    }

    const messageId = this.state.lastMessageId;
    const tail = this.state.agent.getRecentStderr();
    this.state = null;
    this.aborted = true;

    if (!messageId || exitedNormally) return;

    const body = formatExitBody(`Agent 进程意外退出 (${formatExitCode(code, signal)})`, tail);
    this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "⚠️ Agent 异常退出",
        body,
        template: "red",
      })
      .catch((err) => this.logger.warn({ err }, "exit notice reply failed"));
  }

  private async processQueue(): Promise<void> {
    const state = this.state;
    if (!state) return;

    try {
      while (state.queue.length > 0 && !this.aborted) {
        const pending = state.queue.shift()!;
        state.lastMessageId = pending.messageId;

        state.client.setContext(pending.messageId, pending.chatId, this.opts.threadId);

        this.promptInFlight = true;
        try {
          await this.runPrompt(state, pending);
        } catch (err) {
          await this.handlePromptError(state, pending, err);
          if (!this.state) return; // shut down by error handler
        } finally {
          this.promptInFlight = false;
          this.cancelRequested = false;
        }
      }
    } finally {
      if (this.state) this.state.processing = false;
    }
  }

  private async runPrompt(state: ChatRuntimeState, pending: PendingMessage): Promise<void> {
    this.logger.info("sending prompt to agent");

    const result = await this.promptOrDisconnect(state, pending);

    this.logger.info({ stopReason: result.stopReason }, "prompt done");
    await state.client.finalize(stopReasonToStatus(result.stopReason));
    await this.persistSession(state.agent.sessionId);
  }

  /**
   * Await the agent's prompt, but reject if the ACP connection closes first.
   *
   * The SDK never rejects a pending `prompt()` when the agent's stdio stream
   * ends (it only aborts its close signal), so a bare `await prompt()` hangs
   * forever if the agent dies mid-turn — leaving the unified card stuck in its
   * "in progress" state with the cancel button showing. Racing
   * `connection.closed` surfaces the death as an {@link AgentDisconnectedError}
   * that {@link handlePromptError} turns into a finalised card + user notice.
   *
   * @throws {AgentDisconnectedError} when the connection closes before the
   *         prompt resolves.
   */
  private async promptOrDisconnect(
    state: ChatRuntimeState,
    pending: PendingMessage,
  ): Promise<Awaited<ReturnType<typeof state.agent.connection.prompt>>> {
    const disconnected = state.agent.connection.closed.then(() => {
      throw new AgentDisconnectedError();
    });
    return Promise.race([
      state.agent.connection.prompt({
        sessionId: state.agent.sessionId,
        prompt: pending.prompt,
      }),
      disconnected,
    ]);
  }

  private async handlePromptError(
    state: ChatRuntimeState,
    pending: PendingMessage,
    err: unknown,
  ): Promise<void> {
    const errMsg = formatAgentError(err);
    const isAuthError = isAuthenticationError(err);
    const disconnected = err instanceof AgentDisconnectedError;
    const procDead = state.agent.process.killed || state.agent.process.exitCode !== null;
    const cancelRequested = this.cancelRequested;
    const exitCode = state.agent.process.exitCode;
    const signal = state.agent.process.signalCode;
    const stderrTail = procDead ? state.agent.getRecentStderr() : [];
    const terminalStatus: AgentStatus = cancelRequested && !isAuthError ? "cancelled" : "failed";

    // Always finalize the unified card so the in-progress state doesn't get
    // stuck. Best-effort — if presenter rejects we still surface the error via
    // a notice card below.
    await state.client
      .finalize(terminalStatus)
      .catch((finalErr) => this.logger.debug({ err: finalErr }, "finalize after error rejected"));

    // A closed connection means the agent is gone even if the OS hasn't
    // surfaced an exit code yet — tear it down so the next message respawns.
    if (isAuthError || procDead || disconnected) {
      this.shutdown();
      const title = isAuthError
        ? "⚠️ Agent 认证失败"
        : cancelRequested
          ? "⛔ Agent 已中断"
          : "⚠️ Agent 异常退出";
      const body = isAuthError
        ? formatExitBody(`Agent authentication failed: ${errMsg}`, stderrTail)
        : cancelRequested
          ? formatExitBody(
              `已请求中断，agent 连接已关闭。${formatExitCode(exitCode, signal)}`,
              stderrTail,
            )
          : formatExitBody(
              `Agent crashed: ${errMsg}. ${formatExitCode(exitCode, signal)}`,
              stderrTail,
            );
      this.logger.error({ err, isAuthError, disconnected, cancelRequested }, "agent died");
      await this.opts.presenter
        .replyNoticeCard(pending.messageId, {
          title,
          body,
          template: cancelRequested && !isAuthError ? "grey" : "red",
        })
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
      return;
    }

    this.logger.warn({ err }, "agent error");
    await this.opts.presenter
      .replyNoticeCard(pending.messageId, {
        title: "⚠️ Agent 错误",
        body: `Agent error: ${errMsg}`,
        template: "red",
      })
      .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
  }

  private async persistSession(sessionId: string, controls?: SessionControls): Promise<void> {
    const now = Date.now();
    try {
      const latest = await this.opts.sessionStore.getLatest(this.opts.chatId, this.opts.threadId);
      const previous = latest?.sessionId === sessionId ? latest : null;
      await this.opts.sessionStore.save({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId,
        ...(this.opts.agentLabel !== undefined ? { agentLabel: this.opts.agentLabel } : {}),
        agentCommand: this.opts.agentCommand,
        agentArgs: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
        ...(previous?.controls !== undefined || controls !== undefined
          ? { controls: mergeSessionControls(previous?.controls, controls) }
          : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      this.logger.warn({ err }, "session store save failed");
    }
  }
}

function sessionMetaFromSnapshot(snapshot: SessionCapabilitiesSnapshot): SessionCardMeta {
  return {
    agent: displayAgent(snapshot.agent),
    mode: displayMode(snapshot),
    model: displayModel(snapshot),
    permission: displayPermission(snapshot),
  };
}

function displayAgent(agent: SessionCapabilitiesSnapshot["agent"]): string {
  if (agent.label) return agent.label;
  const base = agent.command.split(/[\\/]/).pop() || agent.command;
  return base || "unknown";
}

function displayMode(snapshot: SessionCapabilitiesSnapshot): string {
  const modeId = snapshot.modes?.currentModeId;
  if (!modeId) return "—";
  const mode = snapshot.modes?.availableModes.find((m) => m.id === modeId);
  return mode?.name ?? modeId;
}

function displayModel(snapshot: SessionCapabilitiesSnapshot): string {
  const modelId = snapshot.models?.currentModelId;
  if (!modelId) return "—";
  const model = snapshot.models?.availableModels.find((m) => m.modelId === modelId);
  return model?.name ?? modelId;
}

function displayPermission(snapshot: SessionCapabilitiesSnapshot): string {
  const explicit = permissionLikeConfigOptions(snapshot);
  if (explicit.length > 0) return explicit.join(" · ");
  return bridgePermissionLabel(snapshot.bridgePermissionMode);
}

function permissionLikeConfigOptions(snapshot: SessionCapabilitiesSnapshot): string[] {
  const options = snapshot.configOptions ?? [];
  return options
    .filter((option) => isPermissionLikeConfig(option))
    .map((option) => `${option.name}: ${displayConfigCurrentValue(option)}`);
}

function isPermissionLikeConfig(
  option: NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
): boolean {
  const haystack =
    `${option.id} ${option.name} ${option.description ?? ""} ${option.category ?? ""}`.toLowerCase();
  return (
    haystack.includes("permission") ||
    haystack.includes("approval") ||
    haystack.includes("approve") ||
    haystack.includes("bypass") ||
    haystack.includes("edit automatically") ||
    haystack.includes("auto edit") ||
    haystack.includes("auto-edit")
  );
}

function displayConfigCurrentValue(
  option: NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
): string {
  if (option.type === "boolean") return option.currentValue ? "on" : "off";
  const value = option.currentValue;
  const selectOption = findSelectOptionName(option.options, value);
  return selectOption ?? value;
}

function findSelectOptionName(
  options: Extract<
    NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
    { type: "select" }
  >["options"],
  value: string,
): string | undefined {
  for (const option of options) {
    if ("value" in option) {
      if (option.value === value) return option.name;
      continue;
    }
    const nested = option.options.find((child) => child.value === value);
    if (nested) return nested.name;
  }
  return undefined;
}

function bridgePermissionLabel(mode: SessionCapabilitiesSnapshot["bridgePermissionMode"]): string {
  switch (mode) {
    case "alwaysAsk":
      return "Ask approvals";
    case "alwaysAllow":
      return "Auto approve";
    case "alwaysDeny":
      return "Auto deny";
    default:
      return mode;
  }
}

function mergeSessionControls(
  existing: SessionControls | undefined,
  patch: SessionControls | undefined,
): SessionControls {
  return {
    ...(existing ?? {}),
    ...(patch ?? {}),
    config: {
      ...(existing?.config ?? {}),
      ...(patch?.config ?? {}),
    },
  };
}

function formatExitCode(code: number | null, signal: NodeJS.Signals | null | undefined): string {
  return `code=${code ?? "null"}, signal=${signal ?? "null"}`;
}

function formatExitBody(reason: string, stderrTail: readonly string[]): string {
  const stderrSuffix =
    stderrTail.length > 0
      ? `\n\nstderr (最后 ${stderrTail.length} 行):\n${stderrTail.join("\n")}`
      : "";
  return `${reason}${stderrSuffix}`;
}

function stopReasonToStatus(reason: acp.StopReason): AgentStatus {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "failed";
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return "complete";
    default:
      return "complete";
  }
}

function formatAgentError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj["message"] === "string") return obj["message"];
    return JSON.stringify(err);
  }
  return String(err);
}

const ACP_AUTH_REQUIRED_CODE = -32_000;
const AUTH_REQUIRED_PATTERN = /auth(entication)? required/i;

function isAuthenticationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as Record<string, unknown>;
  if (typeof obj["code"] === "number" && obj["code"] === ACP_AUTH_REQUIRED_CODE) return true;
  if (typeof obj["message"] === "string" && AUTH_REQUIRED_PATTERN.test(obj["message"])) return true;
  return false;
}
