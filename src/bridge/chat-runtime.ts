import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { AgentStatus, LarkPresenter } from "../presenter/presenter.js";
import { LarkAcpClient, type PermissionMode, type SessionStatus } from "../acp/lark-acp-client.js";
import {
  spawnAgent,
  spawnAndResumeAgent,
  killAgent,
  AgentDisconnectedError,
  type AgentProcess,
  type SpawnAgentOptions,
} from "../acp/agent-process.js";
import type { SessionStore } from "../session-store/session-store.js";

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
  presenter: LarkPresenter;
  sessionStore: SessionStore;
  logger: LarkLogger;
}

interface ChatRuntimeState {
  client: LarkAcpClient;
  agent: AgentProcess;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
  /** Last messageId we processed — used to attach exit notices to a thread. */
  lastMessageId: string | null;
  /** Current status reaction per user message. */
  statusReactions: Map<string, StatusReaction>;
  /** Serialises status reaction updates per user message so fast transitions cannot reorder. */
  statusReactionUpdates: Map<string, Promise<void>>;
}

interface StatusReaction {
  emoji: string;
  reactionId: string;
}

const SESSION_STATUS_REACTION: Record<SessionStatus, string> = {
  processing: "OnIt",
  waiting: "OneSecond",
  complete: "CheckMark",
  failed: "ERROR",
  cancelled: "CrossMark",
};

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

  private async bootstrap(firstMessage: PendingMessage): Promise<ChatRuntimeState> {
    this.logger.info("creating chat runtime");

    const client = new LarkAcpClient({
      presenter: this.opts.presenter,
      logger: this.logger,
      showThoughts: this.opts.showThoughts,
      showTools: this.opts.showTools,
      showCancelButton: this.opts.showCancelButton,
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
      permissionMode: this.opts.permissionMode,
      callbacks: {
        onTyping: () => this.setStatusReaction(firstMessage.messageId, "processing"),
        onStatus: (status) => this.setStatusReaction(firstMessage.messageId, status),
      },
    });

    const spawnOpts: SpawnAgentOptions = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      logger: this.logger,
    };

    const latest = await this.opts.sessionStore.getLatest(this.opts.chatId, this.opts.threadId);
    let agent: AgentProcess;
    if (latest) {
      this.logger.info({ previousSessionId: latest.sessionId }, "attempting resume");
      const result = await spawnAndResumeAgent(spawnOpts, latest.sessionId);
      agent = result.agent;
    } else {
      agent = await spawnAgent(spawnOpts);
    }

    await this.persistSession(agent.sessionId);

    agent.process.on("exit", (code, signal) => {
      this.handleUnexpectedExit(code, signal);
    });

    return {
      client,
      agent,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
      lastMessageId: firstMessage.messageId,
      statusReactions: new Map(),
      statusReactionUpdates: new Map(),
    };
  }

  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    // If a prompt is in-flight or we've torn down deliberately, the prompt
    // error path / shutdown already covers user-facing notification.
    if (this.promptInFlight || this.aborted || !this.state) return;

    const exitedNormally = code === 0 || code === null;
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

    const stderrSuffix =
      tail.length > 0 ? `\n\nstderr (最后 ${tail.length} 行):\n${tail.join("\n")}` : "";
    const summary = `⚠️ Agent 进程意外退出 (code=${code ?? "null"}, signal=${signal ?? "null"})${stderrSuffix}`;
    this.opts.presenter
      .replyText(messageId, summary)
      .catch((err) => this.logger.warn({ err }, "exit notice reply failed"));
  }

  private async processQueue(): Promise<void> {
    const state = this.state;
    if (!state) return;

    try {
      while (state.queue.length > 0 && !this.aborted) {
        const pending = state.queue.shift()!;
        state.lastMessageId = pending.messageId;

        state.client.updateCallbacks({
          onTyping: () => this.setStatusReaction(pending.messageId, "processing"),
          onStatus: (status) => this.setStatusReaction(pending.messageId, status),
        });

        state.client.setContext(pending.messageId, pending.chatId, this.opts.threadId);

        this.promptInFlight = true;
        try {
          await this.runPrompt(state, pending);
        } catch (err) {
          await this.handlePromptError(state, pending, err);
          if (!this.state) return; // shut down by error handler
        } finally {
          this.promptInFlight = false;
        }
      }
    } finally {
      if (this.state) this.state.processing = false;
    }
  }

  private async runPrompt(state: ChatRuntimeState, pending: PendingMessage): Promise<void> {
    await this.setStatusReaction(pending.messageId, "processing");
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
    const stderrTail = procDead ? state.agent.getRecentStderr() : [];
    const stderrSuffix =
      stderrTail.length > 0
        ? `\n\nstderr (最后 ${stderrTail.length} 行):\n${stderrTail.join("\n")}`
        : "";

    // Always finalize the unified card as failed so the in-progress state
    // doesn't get stuck. Best-effort — if presenter rejects we still surface
    // the error via replyText below.
    await state.client
      .finalize("failed")
      .catch((finalErr) => this.logger.debug({ err: finalErr }, "finalize after error rejected"));

    // A closed connection means the agent is gone even if the OS hasn't
    // surfaced an exit code yet — tear it down so the next message respawns.
    if (isAuthError || procDead || disconnected) {
      this.shutdown();
      const summary = isAuthError
        ? `⚠️ Agent authentication failed: ${errMsg}${stderrSuffix}`
        : `⚠️ Agent crashed: ${errMsg}${stderrSuffix}`;
      this.logger.error({ err, isAuthError, disconnected }, "agent died");
      await this.opts.presenter
        .replyText(pending.messageId, summary)
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
      return;
    }

    this.logger.warn({ err }, "agent error");
    await this.opts.presenter
      .replyText(pending.messageId, `⚠️ Agent error: ${errMsg}`)
      .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
  }

  private async persistSession(sessionId: string): Promise<void> {
    const now = Date.now();
    try {
      await this.opts.sessionStore.save({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId,
        agentCommand: this.opts.agentCommand,
        agentArgs: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      this.logger.warn({ err }, "session store save failed");
    }
  }

  private async setStatusReaction(messageId: string, status: SessionStatus): Promise<void> {
    const state = this.state;
    if (!state) return;

    const previous = state.statusReactionUpdates.get(messageId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.applyStatusReaction(state, messageId, status));
    state.statusReactionUpdates.set(messageId, next);
    await next;
    if (state.statusReactionUpdates.get(messageId) === next) {
      state.statusReactionUpdates.delete(messageId);
    }
  }

  private async applyStatusReaction(
    state: ChatRuntimeState,
    messageId: string,
    status: SessionStatus,
  ): Promise<void> {
    const emoji = SESSION_STATUS_REACTION[status];
    const current = state.statusReactions.get(messageId);
    if (current?.emoji === emoji) return;

    const reactionId = await this.opts.presenter.addReaction(messageId, emoji).catch((err) => {
      this.logger.debug({ err, messageId, emoji, status }, "add status reaction failed");
      return null;
    });
    if (!reactionId) return;

    state.statusReactions.set(messageId, { emoji, reactionId });
    if (current) {
      await this.opts.presenter.removeReaction(messageId, current.reactionId).catch((err) => {
        this.logger.debug(
          { err, messageId, emoji: current.emoji },
          "remove old status reaction failed",
        );
      });
    }
  }
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
