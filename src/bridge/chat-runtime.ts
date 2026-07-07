import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { AgentStatus, LarkPresenter, SessionCardMeta } from "../presenter/presenter.js";
import { HummingClient, PERMISSION_MODES, type PermissionMode } from "../acp/humming-client.js";
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
  SessionConfigControlValue,
  SessionControlPatch,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";

const SHUTDOWN_FINALIZE_TIMEOUT_MS = 3_000;

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  /** Message used as reply/card anchor for this prompt. */
  messageId: string;
  chatId: string;
  /** Progress card created by the bridge as soon as it accepted the prompt. */
  progressCardId?: string | null;
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
  idleStatusCardMs: number;
  permissionMode: PermissionMode;
  agentLabel?: string;
  /**
   * Controls copied from the most recent session profile in the same chat +
   * repo. Used only when this runtime creates a brand-new ACP session; existing
   * topic sessions keep their own persisted controls.
   */
  inheritedControls?: SessionControls;
  /**
   * Start a new ACP session even if sessions.json has a saved session for this
   * chat/thread. Used when a repo binding is unavailable and the bridge falls
   * back to the Humming home reception area — the old session belongs to the
   * missing repo and must not be resumed in the fallback cwd.
   */
  ignoreStoredSession?: boolean;
  presenter: LarkPresenter;
  sessionStore: SessionStore;
  logger: LarkLogger;
}

interface ChatRuntimeState {
  client: HummingClient;
  agent: AgentProcess;
  sessionCapabilities: SessionCapabilitiesSnapshot;
  sessionTitle?: string;
  sessionUpdatedAt?: string;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  /** Last messageId we processed — used to attach exit notices to a thread. */
  lastMessageId: string | null;
}

/**
 * Per-chat ACP runtime: owns one agent subprocess, one `HummingClient`,
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
  /** Suppress the prompt-error notice when this runtime is intentionally replaced. */
  private suppressPromptErrorNotice = false;
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

  get lastMessageId(): string | null {
    return this.state?.lastMessageId ?? null;
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
  async shutdown(finalStatus: AgentStatus | null = "cancelled"): Promise<void> {
    this.aborted = true;
    const state = this.state;
    if (!state) return;
    this.logger.info("shutting down chat runtime");
    state.client.cancelPendingPermission();
    if (finalStatus !== null) {
      await withTimeout(
        state.client.finalizeIfRenderable(finalStatus),
        SHUTDOWN_FINALIZE_TIMEOUT_MS,
      ).catch((err) => this.logger.warn({ err }, "shutdown card finalize failed"));
    }
    this.state = null;
    killAgent(state.agent.process);
  }

  /**
   * Replace this runtime for a Humming management command such as set-agent or
   * bind-session. The command itself sends the user-facing success/failure
   * notice, so avoid creating a second empty "已取消" card. If a prompt card is
   * already visible, we still seal it as cancelled to remove the live cancel
   * button; otherwise the single management-command notice is enough.
   */
  async supersede(): Promise<void> {
    this.aborted = true;
    const state = this.state;
    if (!state) return;
    this.logger.info("superseding chat runtime");
    this.suppressPromptErrorNotice = true;
    this.cancelRequested = true;
    state.client.cancelPendingPermission();
    await withTimeout(
      state.client.finalizeIfRenderable("complete"),
      SHUTDOWN_FINALIZE_TIMEOUT_MS,
    ).catch((err) => this.logger.warn({ err }, "supersede card finalize failed"));
    this.state = null;
    killAgent(state.agent.process);
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

  async applyControls(controls: SessionControlPatch, noticeMessageId?: string): Promise<void> {
    const state = this.state;
    if (!state) throw new Error("session runtime is not started yet");
    if (this.promptInFlight || state.processing || state.queue.length > 0) {
      throw new Error(
        "session controls cannot be changed while this topic has an in-flight prompt; wait for the current task to finish or send /cancel first",
      );
    }
    const beforeSnapshot = cloneCapabilitiesSnapshot({
      ...state.sessionCapabilities,
      bridgePermissionMode: state.client.getPermissionMode(),
    });
    try {
      this.validateControls(state.sessionCapabilities, controls);
      const nextCapabilities = await this.applyControlsToState(state, controls);
      if (controls.bridgePermissionMode !== undefined) {
        state.client.setPermissionMode(controls.bridgePermissionMode);
      }
      state.sessionCapabilities = nextCapabilities;
      await this.persistSession(state.agent.sessionId, controls);
      await this.notifyControlSuccess(
        noticeMessageId ?? state.lastMessageId,
        beforeSnapshot,
        {
          ...state.sessionCapabilities,
          bridgePermissionMode: state.client.getPermissionMode(),
        },
        controls,
      );
    } catch (err) {
      await this.notifyControlFailure(noticeMessageId ?? state.lastMessageId, err);
      throw err;
    }
  }

  private async bootstrap(firstMessage: PendingMessage): Promise<ChatRuntimeState> {
    this.logger.info("creating chat runtime");

    const latest = this.opts.ignoreStoredSession
      ? null
      : await this.opts.sessionStore.getLatest(this.opts.chatId, this.opts.threadId);
    let stateRef: ChatRuntimeState | null = null;
    let currentClient: HummingClient;
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
    const client = new HummingClient({
      presenter: this.opts.presenter,
      logger: this.logger,
      showThoughts: this.opts.showThoughts,
      showTools: this.opts.showTools,
      showCancelButton: this.opts.showCancelButton,
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
      idleStatusCardMs: this.opts.idleStatusCardMs,
      permissionMode:
        latest?.controls?.bridgePermissionMode ??
        this.opts.inheritedControls?.bridgePermissionMode ??
        this.opts.permissionMode,
      metaProvider,
      onSessionInfoUpdate: (update) => {
        if (stateRef === null) return;
        if (update.title !== undefined) {
          if (update.title === null) delete stateRef.sessionTitle;
          else {
            const title = sanitizeSessionTitle(update.title);
            if (title === undefined) delete stateRef.sessionTitle;
            else stateRef.sessionTitle = title;
          }
        }
        if (update.updatedAt !== undefined) {
          if (update.updatedAt === null) delete stateRef.sessionUpdatedAt;
          else stateRef.sessionUpdatedAt = update.updatedAt;
        }
      },
    });
    currentClient = client;
    client.setContext(firstMessage.messageId, firstMessage.chatId, this.opts.threadId);
    client.adoptProgressCard(firstMessage.progressCardId);
    await client.showPreparing();

    const spawnOpts: SpawnAgentOptions = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      logger: this.logger,
    };

    let agent: AgentProcess;
    try {
      if (latest && !latest.profileOnly) {
        this.logger.info({ previousSessionId: latest.sessionId }, "attempting resume");
        const result = await spawnAndResumeAgent(spawnOpts, latest.sessionId);
        agent = result.agent;
      } else {
        agent = await spawnAgent(spawnOpts);
      }
    } catch (err) {
      await client
        .finalize("failed")
        .catch((finalErr) => this.logger.warn({ err: finalErr }, "bootstrap card finalize failed"));
      throw err;
    }

    await this.persistSession(agent.sessionId);

    const persistedTitle = sanitizeSessionTitle(latest?.title);
    const state: ChatRuntimeState = {
      client,
      agent,
      sessionCapabilities: this.buildCapabilitiesSnapshot(agent, client),
      ...(persistedTitle !== undefined ? { sessionTitle: persistedTitle } : {}),
      ...(latest?.sessionUpdatedAt !== undefined
        ? { sessionUpdatedAt: latest.sessionUpdatedAt }
        : {}),
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      lastMessageId: firstMessage.messageId,
    };
    stateRef = state;

    agent.process.on("exit", (code, signal) => {
      this.handleUnexpectedExit(code, signal);
    });

    if (latest?.controls) {
      const { controls, ignored } = filterSessionControls(
        state.sessionCapabilities,
        latest.controls,
      );
      if (ignored.length > 0) {
        await this.cleanPersistedControls(latest, controls);
        await this.notifyStoredControlsIgnored(firstMessage.messageId, ignored);
      }
      if (hasControls(controls)) {
        state.sessionCapabilities = await this.applyControlsToState(state, controls);
        if (controls.bridgePermissionMode !== undefined) {
          state.client.setPermissionMode(controls.bridgePermissionMode);
        }
      }
    } else if (this.opts.inheritedControls) {
      const { controls, ignored } = filterSessionControls(
        state.sessionCapabilities,
        this.opts.inheritedControls,
      );
      if (hasControls(controls)) {
        try {
          state.sessionCapabilities = await this.applyControlsToState(state, controls);
          if (controls.bridgePermissionMode !== undefined) {
            state.client.setPermissionMode(controls.bridgePermissionMode);
          }
          await this.persistSession(agent.sessionId, controls);
        } catch (err) {
          ignored.push({
            kind: "Apply",
            target: "inherited controls",
            reason: formatAgentError(err),
          });
        }
      }
      if (ignored.length > 0) {
        await this.notifyInheritedControlsIgnored(firstMessage.messageId, ignored);
      }
    }

    return state;
  }

  private buildCapabilitiesSnapshot(
    agent: AgentProcess,
    client: HummingClient,
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

  private validateControls(
    snapshot: SessionCapabilitiesSnapshot,
    controls: SessionControlPatch,
  ): void {
    validateSessionControls(snapshot, controls);
  }

  private async notifyControlFailure(messageId: string | null, err: unknown): Promise<void> {
    if (!messageId) return;
    const body = [
      "Session control 设置失败，当前 runtime 和 sessions.json 未更新。",
      "",
      formatControlFailure(err),
      "",
      "请让 agent 重新查询 capabilities 后，使用有效的 modelId / modeId / config 值再试。",
    ].join("\n");
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "⚠️ Session 设置失败",
        body,
        template: "red",
      })
      .catch((sendErr) => this.logger.warn({ err: sendErr }, "control failure notice failed"));
  }

  private async notifyControlSuccess(
    messageId: string | null,
    before: SessionCapabilitiesSnapshot,
    after: SessionCapabilitiesSnapshot,
    controls: SessionControlPatch,
  ): Promise<void> {
    if (!messageId) return;
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "✅ Session profile 已更新",
        body: renderControlSuccessBody(before, after, controls),
        template: "green",
      })
      .catch((sendErr) => this.logger.warn({ err: sendErr }, "control success notice failed"));
  }

  private async notifyInheritedControlsIgnored(
    messageId: string,
    ignored: readonly IgnoredInheritedControl[],
  ): Promise<void> {
    const body = [
      "从当前 repo 最近 session 继承 profile 时，部分 session 设置在当前 agent 上无效，已忽略。",
      "",
      ...ignored.map((item) => `• ${item.kind} ${item.target}：${item.reason}`),
      "",
      "其余可用设置已正常应用，session 会继续启动。",
    ].join("\n");
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "⚠️ 部分继承的 session 设置无效，已忽略",
        body,
        template: "orange",
      })
      .catch((sendErr) =>
        this.logger.warn({ err: sendErr }, "inherited controls warning notice failed"),
      );
  }

  private async notifyStoredControlsIgnored(
    messageId: string,
    ignored: readonly IgnoredInheritedControl[],
  ): Promise<void> {
    const body = [
      "sessions.json 中保存的部分 session 设置在当前 agent 上无效，已自动清理并忽略。",
      "",
      ...ignored.map((item) => `• ${item.kind} ${item.target}：${item.reason}`),
      "",
      "当前消息会继续发送给 agent。请重新查询 capabilities 后再设置有效的 mode/model/config。",
    ].join("\n");
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "⚠️ 已忽略无效的 session 设置",
        body,
        template: "orange",
      })
      .catch((sendErr) =>
        this.logger.warn({ err: sendErr }, "stored controls warning notice failed"),
      );
  }

  private async cleanPersistedControls(
    previous: SessionRecord,
    controls: SessionControls,
  ): Promise<void> {
    const updated: SessionRecord = {
      ...previous,
      ...(hasControls(controls) ? { controls } : { controls: undefined }),
      updatedAt: Date.now(),
    };
    await this.opts.sessionStore
      .save(updated)
      .catch((err) => this.logger.warn({ err }, "failed to clean persisted controls"));
  }

  private async applyControlsToState(
    state: ChatRuntimeState,
    controls: SessionControlPatch,
  ): Promise<SessionCapabilitiesSnapshot> {
    let next = state.sessionCapabilities;
    const rollbacks: Array<() => Promise<void>> = [];
    try {
      if (controls.clearModelId === true && next.models) {
        next = {
          ...next,
          models: { ...next.models, currentModelId: undefined },
        };
      }
      if (controls.modelId !== undefined) {
        const previousModelId = next.models?.currentModelId;
        try {
          await state.agent.connection.unstable_setSessionModel({
            sessionId: state.agent.sessionId,
            modelId: controls.modelId,
          });
        } catch (err) {
          throw new ControlApplyError("Model", controls.modelId, formatAgentError(err));
        }
        if (previousModelId && previousModelId !== controls.modelId) {
          rollbacks.push(() =>
            state.agent.connection.unstable_setSessionModel({
              sessionId: state.agent.sessionId,
              modelId: previousModelId,
            }),
          );
        }
        if (next.models) {
          next = {
            ...next,
            models: { ...next.models, currentModelId: controls.modelId },
          };
        }
      }
      if (controls.modeId !== undefined) {
        const previousModeId = next.modes?.currentModeId;
        try {
          await state.agent.connection.setSessionMode({
            sessionId: state.agent.sessionId,
            modeId: controls.modeId,
          });
        } catch (err) {
          throw new ControlApplyError("Mode", controls.modeId, formatAgentError(err));
        }
        if (previousModeId && previousModeId !== controls.modeId) {
          rollbacks.push(() =>
            state.agent.connection.setSessionMode({
              sessionId: state.agent.sessionId,
              modeId: previousModeId,
            }),
          );
        }
        if (next.modes) {
          next = {
            ...next,
            modes: { ...next.modes, currentModeId: controls.modeId },
          };
        }
      }
      for (const [configId, value] of Object.entries(controls.config ?? {})) {
        const previousOption = next.configOptions?.find((option) => option.id === configId);
        try {
          const response = await state.agent.connection.setSessionConfigOption({
            sessionId: state.agent.sessionId,
            configId,
            ...value,
          });
          next = {
            ...next,
            configOptions: response.configOptions,
          };
        } catch (err) {
          throw new ControlApplyError("Config", configId, formatAgentError(err));
        }
        if (previousOption) {
          rollbacks.push(() =>
            state.agent.connection.setSessionConfigOption({
              sessionId: state.agent.sessionId,
              configId,
              ...configRollbackValue(previousOption),
            }),
          );
        }
      }
      if (controls.bridgePermissionMode !== undefined) {
        next = {
          ...next,
          bridgePermissionMode: controls.bridgePermissionMode,
        };
      }
      return next;
    } catch (err) {
      await rollbackControlChanges(rollbacks, this.logger);
      throw err;
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
        state.client.adoptProgressCard(pending.progressCardId);

        await this.applyPendingControlsBeforePrompt(state, pending.messageId);
        if (this.aborted || this.state !== state) return;

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

  private async applyPendingControlsBeforePrompt(
    state: ChatRuntimeState,
    messageId: string,
  ): Promise<void> {
    let consumed: Awaited<ReturnType<SessionStore["consumePendingControls"]>>;
    try {
      consumed = await this.opts.sessionStore.consumePendingControls({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId: state.agent.sessionId,
      });
    } catch (err) {
      this.logger.warn({ err }, "pending session controls lookup failed");
      return;
    }
    const pendingControls = consumed.pendingControls;
    if (pendingControls === undefined || !hasControls(pendingControls)) return;

    const beforeSnapshot = cloneCapabilitiesSnapshot({
      ...state.sessionCapabilities,
      bridgePermissionMode: state.client.getPermissionMode(),
    });
    try {
      this.validateControls(state.sessionCapabilities, pendingControls);
      const nextCapabilities = await this.applyControlsToState(state, pendingControls);
      if (pendingControls.bridgePermissionMode !== undefined) {
        state.client.setPermissionMode(pendingControls.bridgePermissionMode);
      }
      state.sessionCapabilities = nextCapabilities;
      await this.persistSession(state.agent.sessionId, pendingControls);
      await this.notifyPendingControlSuccess(
        messageId,
        state,
        beforeSnapshot,
        {
          ...state.sessionCapabilities,
          bridgePermissionMode: state.client.getPermissionMode(),
        },
        pendingControls,
      );
    } catch (err) {
      this.logger.warn({ err }, "pending session controls apply failed");
      await this.notifyPendingControlFailure(messageId, err);
    }
  }

  private async notifyPendingControlFailure(messageId: string, err: unknown): Promise<void> {
    const body = [
      "之前排队的 session control 设置在本轮发送前应用失败，已丢弃；当前消息会继续使用旧 profile。",
      "",
      formatControlFailure(err),
      "",
      "请让 agent 重新查询 capabilities 后，使用有效的 modelId / modeId / config 值再试。",
    ].join("\n");
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "⚠️ 排队的 Session 设置未生效",
        body,
        template: "orange",
      })
      .catch((sendErr) =>
        this.logger.warn({ err: sendErr }, "pending control failure notice failed"),
      );
  }

  private async notifyPendingControlSuccess(
    messageId: string,
    state: ChatRuntimeState,
    before: SessionCapabilitiesSnapshot,
    after: SessionCapabilitiesSnapshot,
    controls: SessionControls,
  ): Promise<void> {
    await this.opts.presenter
      .replyNoticeCard(messageId, {
        title: "✅ 排队的 Session profile 已生效",
        body: renderControlSuccessBody(before, after, controls),
        template: "green",
      })
      .catch((sendErr) =>
        this.logger.warn({ err: sendErr }, "pending control success notice failed"),
      );
  }

  private async runPrompt(state: ChatRuntimeState, pending: PendingMessage): Promise<void> {
    this.logger.info("sending prompt to agent");
    await state.client.showForwarded();

    const result = await this.promptOrDisconnect(state, pending);

    if (this.suppressPromptErrorNotice || this.aborted || this.state !== state) {
      this.logger.info("prompt completed after runtime was superseded; skipping session persist");
      return;
    }

    this.logger.info({ stopReason: result.stopReason, usage: result.usage ?? null }, "prompt done");
    await state.client.finalize(stopReasonToStatus(result.stopReason));
    await this.persistSession(state.agent.sessionId);
    await this.applyPendingControlsBeforePrompt(state, pending.messageId);
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
    const suppressNotice = this.suppressPromptErrorNotice;
    const exitCode = state.agent.process.exitCode;
    const signal = state.agent.process.signalCode;
    const stderrTail = procDead ? state.agent.getRecentStderr() : [];
    const terminalStatus: AgentStatus =
      (cancelRequested || suppressNotice) && !isAuthError ? "cancelled" : "failed";

    // Always finalize the unified card so the in-progress state doesn't get
    // stuck. Best-effort — if presenter rejects we still surface the error via
    // a notice card below.
    await state.client
      .finalize(terminalStatus)
      .catch((finalErr) => this.logger.debug({ err: finalErr }, "finalize after error rejected"));

    if (suppressNotice) {
      this.suppressPromptErrorNotice = false;
      return;
    }

    // A closed connection means the agent is gone even if the OS hasn't
    // surfaced an exit code yet — tear it down so the next message respawns.
    if (isAuthError || procDead || disconnected) {
      await this.shutdown(null);
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

  private async persistSession(sessionId: string, controls?: SessionControlPatch): Promise<void> {
    const now = Date.now();
    try {
      const latest = await this.opts.sessionStore.getLatest(this.opts.chatId, this.opts.threadId);
      const previous = latest?.sessionId === sessionId || latest?.profileOnly ? latest : null;
      const liveState = this.state?.agent.sessionId === sessionId ? this.state : null;
      const title = sanitizeSessionTitle(liveState?.sessionTitle ?? previous?.title);
      const sessionUpdatedAt = liveState?.sessionUpdatedAt ?? previous?.sessionUpdatedAt;
      await this.opts.sessionStore.save({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId,
        ...(title !== undefined ? { title } : {}),
        ...(sessionUpdatedAt !== undefined ? { sessionUpdatedAt } : {}),
        ...(this.opts.agentLabel !== undefined ? { agentLabel: this.opts.agentLabel } : {}),
        agentCommand: this.opts.agentCommand,
        agentArgs: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
        ...(previous?.controls !== undefined || controls !== undefined
          ? { controls: mergeSessionControls(previous?.controls, controls) }
          : {}),
        ...(previous?.pendingControls !== undefined
          ? { pendingControls: previous.pendingControls }
          : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      this.logger.warn({ err }, "session store save failed");
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sessionMetaFromSnapshot(snapshot: SessionCapabilitiesSnapshot): SessionCardMeta {
  return {
    agent: displayAgent(snapshot.agent),
    mode: displayMode(snapshot),
    model: displayModel(snapshot),
    permission: displayPermission(snapshot),
  };
}

function sanitizeSessionTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[上下文:")) return undefined;
  if (trimmed.startsWith("[humming:")) return undefined;
  return trimmed;
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

function renderControlSuccessBody(
  before: SessionCapabilitiesSnapshot,
  after: SessionCapabilitiesSnapshot,
  controls: SessionControlPatch,
): string {
  const changed = controlChangeLines(before, after, controls);
  return [
    "当前 topic 的 session profile 已切换。",
    "",
    "**修改明细**",
    ...changed,
    "",
    "**当前 profile**",
    `• Agent：${displayAgent(after.agent)}`,
    `• Mode：${displayMode(after)}`,
    `• Model：${displayModel(after)}`,
    `• Permission：${displayPermission(after)}`,
    `• Controls：${displayControls(after)}`,
  ].join("\n");
}

function controlChangeLines(
  before: SessionCapabilitiesSnapshot,
  after: SessionCapabilitiesSnapshot,
  controls: SessionControlPatch,
): string[] {
  const lines: string[] = [];
  if (controls.modeId !== undefined) {
    lines.push(`• Mode：${displayMode(before)} → ${displayMode(after)}`);
  }
  if (controls.clearModelId === true || controls.modelId !== undefined) {
    lines.push(`• Model：${displayModel(before)} → ${displayModel(after)}`);
  }
  if (controls.bridgePermissionMode !== undefined) {
    lines.push(
      `• Permission：${bridgePermissionLabel(before.bridgePermissionMode)} → ${bridgePermissionLabel(after.bridgePermissionMode)}`,
    );
  }
  for (const configId of Object.keys(controls.config ?? {})) {
    lines.push(
      `• Control ${displayConfigName(after, configId)}：${displayConfigValue(before, configId)} → ${displayConfigValue(after, configId)}`,
    );
  }
  return lines.length > 0 ? lines : ["• 无实际变化"];
}

function displayControls(snapshot: SessionCapabilitiesSnapshot): string {
  const options = snapshot.configOptions ?? [];
  if (options.length === 0) return "—";
  return options
    .map((option) => `${option.name}: ${displayConfigCurrentValue(option)}`)
    .join(" · ");
}

function displayConfigName(snapshot: SessionCapabilitiesSnapshot, configId: string): string {
  const option = snapshot.configOptions?.find((candidate) => candidate.id === configId);
  return option?.name ?? configId;
}

function displayConfigValue(snapshot: SessionCapabilitiesSnapshot, configId: string): string {
  const option = snapshot.configOptions?.find((candidate) => candidate.id === configId);
  return option ? displayConfigCurrentValue(option) : "—";
}

export function validateSessionControls(
  snapshot: SessionCapabilitiesSnapshot,
  controls: SessionControlPatch,
): void {
  if (controls.modelId !== undefined) {
    if (!snapshot.models) {
      throw new ControlApplyError(
        "Model",
        controls.modelId,
        "agent does not expose ACP model controls",
      );
    }
    if (!snapshot.models.availableModels.some((model) => model.modelId === controls.modelId)) {
      throw new ControlApplyError("Model", controls.modelId, "modelId is not in availableModels");
    }
  }

  if (controls.modeId !== undefined) {
    if (!snapshot.modes) {
      throw new ControlApplyError(
        "Mode",
        controls.modeId,
        "agent does not expose ACP mode controls",
      );
    }
    if (!snapshot.modes.availableModes.some((mode) => mode.id === controls.modeId)) {
      throw new ControlApplyError("Mode", controls.modeId, "modeId is not in availableModes");
    }
  }

  for (const [configId, value] of Object.entries(controls.config ?? {})) {
    const option = snapshot.configOptions?.find((candidate) => candidate.id === configId);
    if (!option) {
      throw new ControlApplyError("Config", configId, "configId is not in configOptions");
    }
    if (option.type === "boolean") {
      if (!("type" in value) || value.type !== "boolean" || typeof value.value !== "boolean") {
        throw new ControlApplyError("Config", configId, "expected boolean config value");
      }
      continue;
    }
    if (typeof value.value !== "string") {
      throw new ControlApplyError("Config", configId, "expected select config value");
    }
    if (!selectOptionValues(option.options).has(value.value)) {
      throw new ControlApplyError(
        "Config",
        configId,
        `select value is not in available options: ${value.value}`,
      );
    }
  }

  if (
    controls.bridgePermissionMode !== undefined &&
    !PERMISSION_MODES.includes(controls.bridgePermissionMode)
  ) {
    throw new ControlApplyError(
      "Permission",
      controls.bridgePermissionMode,
      "bridgePermissionMode is not supported",
    );
  }
}

function cloneCapabilitiesSnapshot(
  snapshot: SessionCapabilitiesSnapshot,
): SessionCapabilitiesSnapshot {
  return structuredClone(snapshot) as SessionCapabilitiesSnapshot;
}

function mergeSessionControls(
  existing: SessionControls | undefined,
  patch: SessionControlPatch | undefined,
): SessionControls {
  const out: SessionControls = { ...(existing ?? {}) };
  if (patch?.clearModelId === true) delete out.modelId;
  if (patch?.modelId !== undefined) out.modelId = patch.modelId;
  if (patch?.modeId !== undefined) out.modeId = patch.modeId;
  if (patch?.bridgePermissionMode !== undefined)
    out.bridgePermissionMode = patch.bridgePermissionMode;
  const config = mergeSessionConfig(existing?.config, patch?.config);
  if (config) out.config = config;
  else delete out.config;
  return out;
}

function mergeSessionConfig(
  existing: SessionControls["config"] | undefined,
  patch: SessionControls["config"] | undefined,
): Record<string, SessionConfigControlValue> | undefined {
  const merged: Record<string, SessionConfigControlValue> = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function hasControls(controls: SessionControlPatch): boolean {
  return (
    controls.clearModelId === true ||
    controls.modelId !== undefined ||
    controls.modeId !== undefined ||
    controls.bridgePermissionMode !== undefined ||
    Object.keys(controls.config ?? {}).length > 0
  );
}

interface IgnoredInheritedControl {
  readonly kind: string;
  readonly target: string;
  readonly reason: string;
}

function filterSessionControls(
  snapshot: SessionCapabilitiesSnapshot,
  controls: SessionControls,
): { controls: SessionControls; ignored: IgnoredInheritedControl[] } {
  const out: SessionControls = {};
  const ignored: IgnoredInheritedControl[] = [];

  if (controls.modelId !== undefined) {
    if (!snapshot.models) {
      ignored.push({
        kind: "Model",
        target: controls.modelId,
        reason: "agent does not expose ACP model controls",
      });
    } else if (
      !snapshot.models.availableModels.some((model) => model.modelId === controls.modelId)
    ) {
      ignored.push({
        kind: "Model",
        target: controls.modelId,
        reason: "modelId is not in availableModels",
      });
    } else {
      out.modelId = controls.modelId;
    }
  }

  if (controls.modeId !== undefined) {
    if (!snapshot.modes) {
      ignored.push({
        kind: "Mode",
        target: controls.modeId,
        reason: "agent does not expose ACP mode controls",
      });
    } else if (!snapshot.modes.availableModes.some((mode) => mode.id === controls.modeId)) {
      ignored.push({
        kind: "Mode",
        target: controls.modeId,
        reason: "modeId is not in availableModes",
      });
    } else {
      out.modeId = controls.modeId;
    }
  }

  const validConfig: Record<string, SessionConfigControlValue> = {};
  for (const [configId, value] of Object.entries(controls.config ?? {})) {
    const option = snapshot.configOptions?.find((candidate) => candidate.id === configId);
    if (!option) {
      ignored.push({
        kind: "Config",
        target: configId,
        reason: "configId is not in configOptions",
      });
      continue;
    }
    if (option.type === "boolean") {
      if (!("type" in value) || value.type !== "boolean" || typeof value.value !== "boolean") {
        ignored.push({ kind: "Config", target: configId, reason: "expected boolean config value" });
        continue;
      }
      validConfig[configId] = value;
      continue;
    }
    if (typeof value.value !== "string") {
      ignored.push({ kind: "Config", target: configId, reason: "expected select config value" });
      continue;
    }
    if (!selectOptionValues(option.options).has(value.value)) {
      ignored.push({
        kind: "Config",
        target: configId,
        reason: `select value is not in available options: ${value.value}`,
      });
      continue;
    }
    validConfig[configId] = value;
  }
  if (Object.keys(validConfig).length > 0) out.config = validConfig;

  if (controls.bridgePermissionMode !== undefined) {
    if (PERMISSION_MODES.includes(controls.bridgePermissionMode)) {
      out.bridgePermissionMode = controls.bridgePermissionMode;
    } else {
      ignored.push({
        kind: "Permission",
        target: controls.bridgePermissionMode,
        reason: "bridgePermissionMode is not supported",
      });
    }
  }

  return { controls: out, ignored };
}

function selectOptionValues(
  options: Extract<
    NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
    { type: "select" }
  >["options"],
): Set<string> {
  const values = new Set<string>();
  for (const option of options) {
    if ("value" in option) {
      values.add(option.value);
      continue;
    }
    for (const child of option.options) values.add(child.value);
  }
  return values;
}

function configRollbackValue(
  option: NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
): SessionConfigControlValue {
  if (option.type === "boolean") return { type: "boolean", value: option.currentValue };
  return { value: option.currentValue };
}

async function rollbackControlChanges(
  rollbacks: Array<() => Promise<void>>,
  logger: LarkLogger,
): Promise<void> {
  for (const rollback of rollbacks.reverse()) {
    try {
      await rollback();
    } catch (err) {
      logger.warn({ err }, "session control rollback failed");
    }
  }
}

class ControlApplyError extends Error {
  override readonly name = "ControlApplyError";

  constructor(
    readonly kind: string,
    readonly target: string,
    readonly reason: string,
  ) {
    super(`${kind} ${target}: ${reason}`);
  }
}

export function formatControlFailure(err: unknown): string {
  if (err instanceof ControlApplyError) {
    return truncateUserVisibleText(`失败项: ${err.kind} ${err.target}\n原因: ${err.reason}`);
  }
  return truncateUserVisibleText(`原因: ${formatAgentError(err)}`);
}

const USER_VISIBLE_ERROR_LIMIT = 1_000;
const STDERR_NOTICE_LINE_LIMIT = 8;
const STDERR_NOTICE_CHAR_LIMIT = 1_500;

function truncateUserVisibleText(text: string, limit = USER_VISIBLE_ERROR_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit)).trimEnd()}…（已截断，完整错误见 bridge.log）`;
}

function formatExitCode(code: number | null, signal: NodeJS.Signals | null | undefined): string {
  return `code=${code ?? "null"}, signal=${signal ?? "null"}`;
}

function formatExitBody(reason: string, stderrTail: readonly string[]): string {
  const safeReason = truncateUserVisibleText(reason);
  if (stderrTail.length === 0) return safeReason;
  const visibleTail = stderrTail.slice(-STDERR_NOTICE_LINE_LIMIT);
  const stderrText = truncateUserVisibleText(visibleTail.join("\n"), STDERR_NOTICE_CHAR_LIMIT);
  const omitted = Math.max(0, stderrTail.length - visibleTail.length);
  const omittedLine = omitted > 0 ? `（已省略 ${omitted} 行；完整 stderr 见 bridge.log）\n` : "";
  return `${safeReason}\n\nstderr (最后 ${visibleTail.length} 行):\n${omittedLine}${stderrText}`;
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
  const raw = (() => {
    if (err instanceof Error) return err.message;
    if (err && typeof err === "object") {
      const obj = err as Record<string, unknown>;
      if (typeof obj["message"] === "string") return obj["message"];
      return JSON.stringify(err);
    }
    return String(err);
  })();
  return truncateUserVisibleText(raw);
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
