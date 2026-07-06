import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { sendLifecycleNotice, type LifecycleNoticeKind } from "../lark/lifecycle-notifier.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import { installHomeTemplates } from "../home-templates.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { BridgeControlServer } from "./control-server.js";
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
} from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
import type { PermissionMode } from "../acp/lark-acp-client.js";
import { AgentAuthError } from "../acp/agent-process.js";
import { SessionAlreadyBoundError } from "../session-store/file-session-store.js";
import type { NoticeCardSpec } from "../presenter/presenter.js";
import type {
  SessionCapabilitiesSnapshot,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";
import type { BindingStore, ChatBinding } from "../binding-store/binding-store.js";
import type * as acp from "@agentclientprotocol/sdk";

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHATS = 10;
const DEFAULT_SHOW_THOUGHTS = true;
const DEFAULT_SHOW_TOOLS = true;
const DEFAULT_SHOW_CANCEL_BUTTON = true;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
const IDLE_CLEANUP_INTERVAL_MS = 2 * 60_000;
/** Debounce for settings.json change events (fs.watch double-fires). */
const SETTINGS_RELOAD_DEBOUNCE_MS = 300;

const ORPHAN_CARD_REASON = "会话已结束，本次确认已失效";

const SENDER_TYPE_USER = "user";
const CHAT_TYPE_GROUP = "group";

const HOME_PREFIX = "~";

const COMMAND_NOTICES: Readonly<Record<"cancel" | "new" | "unbind", NoticeCardSpec>> = {
  cancel: {
    title: "⛔ 已取消",
    body: "已取消当前任务，agent 进程保留以便后续消息继续。",
    template: "grey",
  },
  new: {
    title: "✅ 已重置会话",
    body: "下次消息将启动一个全新的 agent 会话。",
    template: "green",
  },
  unbind: {
    title: "⛔ 已解绑",
    body: "本会话已解绑，agent 进程已停止。下次消息将使用默认配置（若已配置），否则请先 /bind <路径> [agent]。",
    template: "grey",
  },
};

const BIND_USAGE_NOTICE: NoticeCardSpec = {
  title: "ℹ️ 用法：/bind",
  body: [
    "把当前会话绑定到一个仓库目录 + agent：",
    "",
    "• /bind <路径>            绑定目录，使用默认 agent",
    "• /bind <路径> <agent>    绑定目录，并指定 agent（如 claude、codex）",
    "",
    "其它命令：",
    "• /where                 查看当前绑定",
    "• /unbind                解除绑定",
    "",
    "示例：/bind ~/workspace/copilot-intellij claude",
  ].join("\n"),
  template: "blue",
};

function assertNever(x: never): never {
  throw new Error(`unexpected: ${String(x)}`);
}

/**
 * Compose the `chats` map key for a `(chatId, threadId)` pair. A `null`
 * threadId (an ordinary, non-topic message) collapses to the bare chatId, so
 * the chat's "main" conversation keeps the same key it had before topic
 * support. A topic thread is namespaced with a NUL separator — never present
 * in Feishu ids — to avoid any collision with a bare chatId.
 */
function runtimeKey(chatId: string, threadId: string | null): string {
  return threadId === null ? chatId : `${chatId}\u0000${threadId}`;
}

/**
 * Raised by {@link resolveBindTarget} when a `/bind` request is invalid —
 * a non-existent path or an unresolvable agent selection. The message is
 * user-facing (sent back as a Lark notice card).
 */
class BindError extends Error {
  override readonly name = "BindError";
}

function formatBootstrapError(err: unknown): string {
  // Auth failures get a clean, actionable message — no confusing internal
  // "failed to create session" chain.
  if (err instanceof AgentAuthError) return `🔑 ${err.message}`;
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof AgentAuthError) return `🔑 ${cause.message}`;
  if (cause instanceof Error && cause.message) return `${err.message}\n→ ${cause.message}`;
  return err.message;
}

interface CardActionPayload {
  /** Permission request id (set on permission cards). */
  r?: string;
  /** Selected option id (set on permission cards). */
  o?: string;
  /** Option display name (set on permission cards). */
  n?: string;
  /** Option kind, e.g. allow_once / reject_once (set on permission cards). */
  ok?: string;
  /** Tool kind (set on permission cards). */
  k?: string;
  /** Tool title (set on permission cards). */
  t?: string;
  /** Chat id — present on every card the bridge produces. */
  c?: string;
  /**
   * Feishu topic (话题) id the card belongs to; absent/null for the chat's
   * "main" (non-topic) conversation. Together with {@link c} it selects the
   * per-thread runtime that owns the pending permission / cancel.
   */
  th?: string | null;
  /** Set on the unified card's "cancel current task" button. */
  cancel?: boolean;
}

export interface LarkBridgeLarkOptions {
  appId: string;
  appSecret: string;
}

/**
 * A concrete agent invocation: the subprocess command plus optional env.
 * Produced by an {@link AgentResolver} from a selection string.
 */
export interface ResolvedAgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Human label (preset id, or the raw command line) shown by `/where`. */
  readonly label: string;
}

/**
 * Resolve an agent selection — a preset id (`claude`) or a raw command
 * (`node ./my-acp.js`) — into a concrete {@link ResolvedAgentInvocation}.
 *
 * Injected by the CLI so the library never depends on the preset registry.
 *
 * @throws when the selection is empty or cannot be resolved.
 */
export type AgentResolver = (selection: string) => ResolvedAgentInvocation;

export interface LarkBridgeAgentOptions {
  /** Maps a selection string → concrete invocation. See {@link AgentResolver}. */
  resolver: AgentResolver;
  /**
   * Pre-resolved agent used for chats without an explicit binding, and as
   * the fallback for `/bind <path>` when no agent is named. `null` means
   * chats must `/bind` with an explicit agent before they can run.
   */
  defaultAgent?: ResolvedAgentInvocation | null;
  /**
   * Working directory used for chats without an explicit binding. `null`
   * means an unbound chat is prompted to `/bind` instead of running.
   */
  defaultCwd?: string | null;
  /** Include `agent_thought_chunk` content in the unified card. Default `true`. */
  showThoughts?: boolean;
  /** Include `tool_call` / `tool_call_update` events in the unified card. Default `true`. */
  showTools?: boolean;
  /**
   * Render the "中断当前任务" button at the bottom of the running unified
   * card. When `false`, users can still cancel via `/cancel` chat command
   * but the in-card button is hidden. Default `true`.
   */
  showCancelButton?: boolean;
  /**
   * Auto-cancel a permission request if the user doesn't respond within
   * this many ms (0 = wait forever). Default 5 minutes.
   */
  permissionTimeoutMs?: number;
  /**
   * How to handle agent-side permission requests. Default `"alwaysAsk"`.
   * `"alwaysAllow"` / `"alwaysDeny"` auto-resolve without involving the user.
   */
  permissionMode?: PermissionMode;
}

export interface LarkBridgeSessionOptions {
  /** Evict an idle chat after this many ms (0 = never). Default 24h. */
  idleTimeoutMs?: number;
  /** Maximum chats kept in memory; oldest idle gets evicted. Default 10. */
  maxConcurrentChats?: number;
}

export interface LarkBridgeLifecycleOptions {
  /** Chats that receive bridge lifecycle notices. Empty/absent disables them. */
  notificationChatIds?: readonly string[];
  /** File created by `lark-acp restart`; when present, stop/start render restart wording. */
  restartMarkerPath?: string | null;
  /** Per-chat send timeout for best-effort lifecycle notices. */
  noticeTimeoutMs?: number;
}

export interface LarkBridgeOptions {
  lark: LarkBridgeLarkOptions;
  agent: LarkBridgeAgentOptions;
  session?: LarkBridgeSessionOptions;
  lifecycle?: LarkBridgeLifecycleOptions;

  /**
   * In group chats, only handle messages that @-mention the bot. Default
   * `false` — the bridge responds to every group message.
   *
   * When `true`, non-@ group messages are ignored (the classic bot etiquette).
   * Note: responding to *all* group messages additionally requires the
   * `im:message.group_msg` scope on the Feishu app; with only
   * `im:message.group_at_msg:readonly`, Feishu delivers @-messages only and
   * this flag has no effect on what actually arrives.
   */
  groupRequireMention?: boolean;

  /**
   * Working directory for chats that have no explicit or default binding —
   * the "reception area". When set, an unbound chat spawns the default agent
   * here so the user can converse (and ask the agent to bind the chat via
   * natural language). When `null`, an unbound chat gets the old "please
   * /bind" notice instead. Default `null` (caller usually passes the home dir).
   */
  unboundCwd?: string | null;

  /**
   * Absolute path to settings.json. Used for (a) hot-reloading bindings when
   * the file changes (e.g. the agent edits it), and (b) telling the agent
   * where to write bindings via the `LARK_ACP_SETTINGS` env var. When unset,
   * hot-reload is disabled.
   */
  settingsPath?: string | null;

  /** Unix-domain socket for local `lark-acp control …` requests. */
  controlSocketPath?: string | null;

  sessionStore: SessionStore;
  /** Persistent per-chat repo + agent binding (one bot → many repos). */
  bindingStore: BindingStore;

  /** Override the default pino-backed logger. */
  logger?: LarkLogger;
  /**
   * Override the default {@link LarkCardPresenter}. When omitted the bridge
   * builds one from `lark.appId` / `lark.appSecret`.
   */
  presenter?: LarkPresenter;
}

/** Global display / permission prefs applied to every chat runtime. */
interface DisplayOptions {
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
  readonly permissionTimeoutMs: number;
  readonly permissionMode: PermissionMode;
}

/** A chat's effective repo + agent, ready to spawn a {@link ChatRuntime}. */
interface EffectiveBinding {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly label: string;
  /** `true` when it came from an explicit `/bind`, `false` for the default. */
  readonly explicit: boolean;
  /**
   * `true` when this is the ephemeral reception-area binding (default agent in
   * `unboundCwd`) for a chat with no real binding. The bridge injects
   * bind-instructions into such a runtime so the user can bind by talking.
   */
  readonly reception: boolean;
}

interface BindingSnapshot {
  readonly cwd: string;
  readonly agentLabel: string;
}

/**
 * Top-level bridge that connects a Lark bot to ACP agents.
 *
 * A single bridge serves many chats; each chat is bound (via `/bind`, or a
 * configured default) to its own working directory and agent, so one Lark
 * bot can drive many repos at once. Owns: Lark HTTP client, Lark WebSocket
 * subscription, logger, presenter, session + binding stores, and one
 * {@link ChatRuntime} per active chat.
 *
 * Lifecycle:
 *
 * 1. `new LarkBridge(opts)` — wires dependencies, no IO yet.
 * 2. `await bridge.start()` — initialises stores and opens the WebSocket.
 * 3. `await bridge.stop()` — shuts down all chat runtimes and the stores.
 */
export class LarkBridge {
  private readonly logger: LarkLogger;
  private readonly http: LarkHttpClient;
  private readonly presenter: LarkPresenter;
  private readonly sessionStore: SessionStore;
  private readonly bindingStore: BindingStore;
  private readonly resolver: AgentResolver;
  private readonly defaultAgent: ResolvedAgentInvocation | null;
  private readonly defaultCwd: string | null;
  private readonly display: DisplayOptions;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentChats: number;
  private readonly groupRequireMention: boolean;
  private readonly unboundCwd: string | null;
  private readonly settingsPath: string | null;
  private readonly controlSocketPath: string | null;
  private readonly lark: LarkBridgeLarkOptions;
  private readonly lifecycleNotificationChatIds: readonly string[];
  private readonly restartMarkerPath: string | null;
  private readonly lifecycleNoticeTimeoutMs: number | undefined;

  private readonly chats = new Map<string, ChatRuntime>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ws: LarkWsConnection | null = null;
  private controlServer: BridgeControlServer | null = null;
  private started = false;
  /** fs.watch handle for hot-reloading settings.json (null when disabled). */
  private settingsWatcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Snapshot of the last-applied bindings, for diffing on hot-reload. */
  private bindingSnapshots = new Map<string, BindingSnapshot>();

  constructor(opts: LarkBridgeOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger ?? createPinoLogger();
    this.sessionStore = opts.sessionStore;
    this.bindingStore = opts.bindingStore;

    this.http = new LarkHttpClient({
      appId: opts.lark.appId,
      appSecret: opts.lark.appSecret,
      logger: this.logger,
    });

    this.presenter =
      opts.presenter ?? new LarkCardPresenter({ http: this.http, logger: this.logger });

    this.resolver = opts.agent.resolver;
    this.defaultAgent = opts.agent.defaultAgent ?? null;
    this.defaultCwd = opts.agent.defaultCwd ?? null;
    this.display = {
      showThoughts: opts.agent.showThoughts ?? DEFAULT_SHOW_THOUGHTS,
      showTools: opts.agent.showTools ?? DEFAULT_SHOW_TOOLS,
      showCancelButton: opts.agent.showCancelButton ?? DEFAULT_SHOW_CANCEL_BUTTON,
      permissionTimeoutMs: opts.agent.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      permissionMode: opts.agent.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };

    this.idleTimeoutMs = opts.session?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrentChats = opts.session?.maxConcurrentChats ?? DEFAULT_MAX_CONCURRENT_CHATS;
    this.groupRequireMention = opts.groupRequireMention ?? false;
    this.unboundCwd = opts.unboundCwd ?? null;
    this.settingsPath = opts.settingsPath ?? null;
    this.controlSocketPath = opts.controlSocketPath ?? null;
    this.lifecycleNotificationChatIds = opts.lifecycle?.notificationChatIds ?? [];
    this.restartMarkerPath = opts.lifecycle?.restartMarkerPath ?? null;
    this.lifecycleNoticeTimeoutMs = opts.lifecycle?.noticeTimeoutMs;
  }

  /**
   * Initialise the stores and open the Lark WebSocket subscription.
   *
   * @throws when a store fails to initialise.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.sessionStore.init();
    await this.bindingStore.init();

    // Seed the binding signature snapshot, then watch settings.json so an
    // external edit (e.g. the agent binding a chat) hot-reloads without a
    // restart.
    await this.snapshotBindings();
    this.startSettingsWatcher();
    this.writeHomeInstructions();
    await this.startControlServer();

    this.cleanupTimer = setInterval(() => this.evictIdle(), IDLE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();

    this.ws = new LarkWsConnection({
      appId: this.lark.appId,
      appSecret: this.lark.appSecret,
      logger: this.logger,
      onMessage: (event) => this.handleMessage(event),
      onCardAction: (event) => this.handleCardAction(event),
    });
    this.ws.start();

    this.logger.info("bridge started");
    await this.sendLifecycleStartedNotice();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.logger.info("stopping bridge");
    await this.sendLifecycleStoppingNotice();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.settingsWatcher) {
      this.settingsWatcher.close();
      this.settingsWatcher = null;
    }
    await this.controlServer?.stop();
    this.controlServer = null;
    for (const runtime of this.chats.values()) runtime.shutdown();
    this.chats.clear();
    await this.sessionStore.close();
    await this.bindingStore.close();
    this.logger.info("bridge stopped");
  }

  private async sendLifecycleStartedNotice(): Promise<void> {
    const restarted = this.consumeRestartMarker();
    await this.sendLifecycleNotice(restarted ? "restarted" : "started");
  }

  private async sendLifecycleStoppingNotice(): Promise<void> {
    await this.sendLifecycleNotice(this.hasRestartMarker() ? "restarting" : "stopping");
  }

  private async sendLifecycleNotice(kind: LifecycleNoticeKind): Promise<void> {
    await sendLifecycleNotice({
      http: this.http,
      chatIds: this.lifecycleNotificationChatIds,
      kind,
      logger: this.logger,
      ...(this.lifecycleNoticeTimeoutMs !== undefined
        ? { timeoutMs: this.lifecycleNoticeTimeoutMs }
        : {}),
    });
  }

  private hasRestartMarker(): boolean {
    return this.restartMarkerPath !== null && fs.existsSync(this.restartMarkerPath);
  }

  private consumeRestartMarker(): boolean {
    const marker = this.restartMarkerPath;
    if (marker === null || !fs.existsSync(marker)) return false;
    try {
      fs.unlinkSync(marker);
    } catch (err) {
      this.logger.warn({ err, marker }, "failed to remove restart marker");
    }
    return true;
  }

  /** Active chat runtime count (mostly for tests / metrics). */
  get activeChatCount(): number {
    return this.chats.size;
  }

  private async startControlServer(): Promise<void> {
    if (!this.controlSocketPath) return;
    this.controlServer = new BridgeControlServer({
      socketPath: this.controlSocketPath,
      logger: this.logger,
      handlers: {
        capabilities: (chatId, threadId) => this.controlCapabilities(chatId, threadId),
        setControls: (chatId, threadId, controls) =>
          this.controlSetControls(chatId, threadId, controls),
        bindSession: (record, noticeMessageId) => this.controlBindSession(record, noticeMessageId),
      },
    });
    await this.controlServer.start();
  }

  private async controlCapabilities(
    chatId: string,
    threadId: string | null,
  ): Promise<SessionCapabilitiesSnapshot> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (!runtime) throw new Error("session runtime is not started yet");
    return runtime.capabilities();
  }

  private async controlSetControls(
    chatId: string,
    threadId: string | null,
    controls: SessionControls,
  ): Promise<{ readonly applied: boolean; readonly recordSessionId: string }> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (runtime) {
      await runtime.applyControls(controls);
      return { applied: true, recordSessionId: runtime.capabilities().session.sessionId };
    }

    const record = await this.sessionStore.setControls({ chatId, threadId }, controls);
    return { applied: false, recordSessionId: record.sessionId };
  }

  private async controlBindSession(
    record: SessionRecord,
    noticeMessageId?: string | null,
  ): Promise<{ readonly bound: true; readonly sessionId: string; readonly title?: string }> {
    const key = runtimeKey(record.chatId, record.threadId);
    const runtime = this.chats.get(key);
    const replyTo = noticeMessageId ?? runtime?.lastMessageId ?? null;
    const previous = await this.sessionStore.getLatest(record.chatId, record.threadId);
    let saved: SessionRecord;
    try {
      saved = await this.sessionStore.bindThreadSession(record);
    } catch (err) {
      if (err instanceof SessionAlreadyBoundError) {
        const notice = buildSessionBindRejectedNotice(record, err);
        if (replyTo) {
          await this.presenter
            .replyNoticeCard(replyTo, notice)
            .catch((sendErr) =>
              this.logger.warn({ err: sendErr }, "session bind rejection notice failed"),
            );
        } else {
          await this.presenter
            .sendNoticeCard(record.chatId, notice)
            .catch((sendErr) =>
              this.logger.warn({ err: sendErr }, "session bind rejection notice failed"),
            );
        }
      }
      throw err;
    }
    if (runtime) {
      runtime.supersede();
      this.chats.delete(key);
    }
    if (replyTo) {
      await this.presenter
        .replyNoticeCard(replyTo, buildSessionBoundNotice(saved, previous))
        .catch((err) => this.logger.warn({ err }, "session bind notice failed"));
    } else {
      await this.presenter
        .sendNoticeCard(record.chatId, buildSessionBoundNotice(saved, previous))
        .catch((err) => this.logger.warn({ err }, "session bind notice failed"));
    }
    return {
      bound: true,
      sessionId: saved.sessionId,
      ...(saved.title !== undefined ? { title: saved.title } : {}),
    };
  }

  // ----- WS event handlers ------------------------------------------------

  private handleMessage(event: Lark.RawMessageEvent): void {
    const { message, sender } = event;
    if (sender.sender_type !== SENDER_TYPE_USER) return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    if (!userId || !messageId || !chatId) return;

    // Feishu "topic" (话题) id. Absent for ordinary messages → null, which
    // routes to the chat's "main" conversation (identical to pre-topic
    // behaviour). A populated value scopes this message to its own topic.
    const threadId = message.thread_id ?? null;

    this.logger.info(
      { userId, chatId, threadId, messageType: message.message_type },
      "message received",
    );

    this.routeMessage(event, userId, messageId, chatId, threadId).catch((err) =>
      this.logger.error({ err, chatId, threadId }, "routeMessage failed"),
    );
  }

  private async routeMessage(
    event: Lark.RawMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<void> {
    const { message } = event;
    const isGroup = message.chat_type === CHAT_TYPE_GROUP;

    let botOpenId: string | undefined;
    if (isGroup) {
      try {
        botOpenId = await this.http.getBotOpenId();
      } catch (err) {
        // We use our own open_id to strip the bot's self-mention from the
        // prompt text, and (when enabled) to decide whether we were @-ed.
        // Without it, fall back to treating the message as addressed to us
        // rather than dropping it — losing a self-mention marker is harmless,
        // silently ignoring the user is not.
        this.logger.warn({ err, chatId }, "getBotOpenId failed — proceeding without mention check");
      }
      if (this.groupRequireMention) {
        const mentioned = message.mentions?.some((m) => m.id?.open_id === botOpenId);
        if (!mentioned) {
          this.logger.debug({ chatId }, "skipping group message — bot not mentioned");
          return;
        }
      }
    }

    const interpreted: InterpretedMessage = interpretLarkMessage(event, { botOpenId });
    switch (interpreted.kind) {
      case "empty":
        return;
      case "command":
        await this.handleCommand(interpreted.command, chatId, threadId, messageId);
        return;
      case "prompt":
        await this.enqueueWithContext(
          event,
          chatId,
          threadId,
          userId,
          messageId,
          interpreted.blocks,
        );
        return;
      default:
        return assertNever(interpreted);
    }
  }

  private async handleCommand(
    command: LarkCommand,
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    switch (command.kind) {
      case "cancel": {
        this.logger.info({ chatId, threadId }, "cancel command");
        const runtime = this.chats.get(runtimeKey(chatId, threadId));
        try {
          await runtime?.cancel();
        } catch (err) {
          this.logger.warn({ err, chatId, threadId }, "cancel command failed");
        }
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.cancel);
        return;
      }
      case "new": {
        // Thread-scoped ("Reset Thread"): only this topic's runtime + sessions
        // are dropped; the chat's other topics keep running.
        this.logger.info({ chatId, threadId }, "new session command");
        this.teardownThread(chatId, threadId);
        await this.clearThreadSessions(chatId, threadId);
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.new);
        return;
      }
      case "bind":
        await this.handleBind(command.cwd, command.agent, chatId, messageId);
        return;
      case "bind-usage":
        await this.presenter.replyNoticeCard(messageId, BIND_USAGE_NOTICE);
        return;
      case "unbind":
        await this.handleUnbind(chatId, messageId);
        return;
      case "where":
        await this.handleWhere(chatId, messageId);
        return;
      default:
        return assertNever(command);
    }
  }

  // ----- Binding commands -------------------------------------------------

  private async handleBind(
    rawCwd: string,
    rawAgent: string | null,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    let target: { cwd: string; invocation: ResolvedAgentInvocation };
    try {
      target = this.resolveBindTarget(rawCwd, rawAgent);
    } catch (err) {
      const reason = err instanceof BindError ? err.message : formatBootstrapError(err);
      this.logger.warn({ err, chatId }, "bind rejected");
      await this.presenter.replyNoticeCard(messageId, {
        title: "⚠️ 绑定失败",
        body: reason,
        template: "red",
      });
      return;
    }

    const now = Date.now();
    const existing = await this.bindingStore.get(chatId);
    const binding: ChatBinding = {
      chatId,
      cwd: target.cwd,
      agentLabel: target.invocation.label,
      agentCommand: target.invocation.command,
      agentArgs: [...target.invocation.args],
      ...(target.invocation.env ? { agentEnv: { ...target.invocation.env } } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.bindingStore.set(binding);
    this.bindingSnapshots.set(chatId, bindingSnapshotOf(binding));

    // A rebind changes repo/agent; tear down the live runtime and drop any
    // persisted ACP sessions so the next message starts fresh in the new cwd
    // instead of resuming a session that belongs to the old repo.
    this.teardownChat(chatId);
    await this.clearChatSessions(chatId);

    this.logger.info({ chatId, cwd: target.cwd, agent: target.invocation.label }, "chat bound");
    await this.presenter.replyNoticeCard(messageId, buildRepoBoundNotice(existing, binding));
  }

  private async handleUnbind(chatId: string, messageId: string): Promise<void> {
    const existing = await this.bindingStore.get(chatId);
    if (!existing) {
      await this.presenter.replyNoticeCard(messageId, {
        title: "ℹ️ 未绑定",
        body: "本会话当前没有显式绑定。",
        template: "grey",
      });
      return;
    }
    await this.bindingStore.delete(chatId);
    this.teardownChat(chatId);
    await this.clearChatSessions(chatId);
    this.logger.info({ chatId }, "chat unbound");
    await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.unbind);
  }

  private async handleWhere(chatId: string, messageId: string): Promise<void> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      await this.presenter.replyNoticeCard(messageId, {
        title: "ℹ️ 未绑定",
        body: "本会话尚未绑定，且没有配置默认目录。\n请先 /bind <路径> [agent]。",
        template: "orange",
      });
      return;
    }
    const source = binding.explicit ? "显式绑定" : "默认配置（未显式绑定）";
    await this.presenter.replyNoticeCard(messageId, {
      title: "📍 当前绑定",
      body: `• 目录：${binding.cwd}\n• Agent：${binding.label}\n• 来源：${source}`,
      template: "blue",
    });
  }

  /**
   * Expand + validate a `/bind` target.
   *
   * @throws {BindError} when the path is missing / not a directory, or the
   *         agent selection cannot be resolved.
   */
  private resolveBindTarget(
    rawCwd: string,
    rawAgent: string | null,
  ): { cwd: string; invocation: ResolvedAgentInvocation } {
    const cwd = expandAndValidateDir(rawCwd);

    if (rawAgent) {
      let invocation: ResolvedAgentInvocation;
      try {
        invocation = this.resolver(rawAgent);
      } catch (err) {
        throw new BindError(`无法解析 agent「${rawAgent}」：${formatBootstrapError(err)}`);
      }
      return { cwd, invocation };
    }

    if (!this.defaultAgent) {
      throw new BindError("未指定 agent，且没有配置默认 agent。请使用 /bind <路径> <agent>。");
    }
    return { cwd, invocation: this.defaultAgent };
  }

  // ----- Prompt routing ---------------------------------------------------

  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    threadId: string | null,
    userId: string,
    messageId: string,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      this.logger.info({ chatId }, "message in unbound chat — reception disabled, prompting /bind");
      await this.presenter.replyNoticeCard(messageId, {
        title: "⚠️ 尚未绑定仓库",
        body: "本会话还没有绑定仓库目录。请先发送：\n/bind <路径> [agent]\n\n例如：/bind ~/workspace/copilot-intellij claude\n查看用法：/bind",
        template: "orange",
      });
      return;
    }

    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const [userName, chatName] = await Promise.all([
      this.http.getUserName(userId),
      isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
    ]);

    const context = isGroup
      ? `[上下文: 群聊 "${chatName}" (${chatId}) 中用户 ${userName} (${userId}) 的消息]`
      : `[上下文: 用户 ${userName} (${userId}) 的私聊消息]`;

    // Keep the prompt small: durable lark-acp operating instructions live in
    // ~/.lark-acp/AGENTS.md and ~/.lark-acp/CLAUDE.md, not inline every turn.
    prompt.unshift({ type: "text", text: renderInlineControlHint(chatId, threadId) });

    prompt.unshift({ type: "text", text: context });

    const runtime = await this.acquireRuntime(chatId, threadId, binding);
    const pending: PendingMessage = { prompt, messageId, chatId };
    try {
      await runtime.enqueue(pending);
    } catch (err) {
      // bootstrap (spawn / initialize / newSession / resume) failed — the
      // ChatRuntime never registered itself as active, so drop it and let
      // the next message try again from scratch.
      this.chats.delete(runtimeKey(chatId, threadId));
      this.logger.error({ err, chatId, threadId }, "agent bootstrap failed");
      const summary = `⚠️ Agent 启动失败: ${formatBootstrapError(err)}`;
      await this.presenter
        .replyText(messageId, summary)
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "bootstrap error reply failed"));
    }
  }

  /**
   * Resolve a chat's effective binding: an explicit `/bind` if present,
   * else the configured default, else `null` (chat must `/bind` first).
   */
  private async resolveBinding(chatId: string): Promise<EffectiveBinding | null> {
    const stored = await this.bindingStore.get(chatId);
    if (stored) {
      return {
        cwd: stored.cwd,
        command: stored.agentCommand,
        args: stored.agentArgs,
        ...(stored.agentEnv ? { env: stored.agentEnv } : {}),
        label: stored.agentLabel,
        explicit: true,
        reception: false,
      };
    }
    if (this.defaultCwd && this.defaultAgent) {
      return {
        cwd: this.defaultCwd,
        command: this.defaultAgent.command,
        args: this.defaultAgent.args,
        ...(this.defaultAgent.env ? { env: this.defaultAgent.env } : {}),
        label: this.defaultAgent.label,
        explicit: false,
        reception: false,
      };
    }
    // Reception area: no real binding, but if a reception cwd + default agent
    // are configured, spawn the agent there so the user can converse and ask
    // it to bind the chat by natural language.
    if (this.unboundCwd && this.defaultAgent) {
      return {
        cwd: this.unboundCwd,
        command: this.defaultAgent.command,
        args: this.defaultAgent.args,
        ...(this.defaultAgent.env ? { env: this.defaultAgent.env } : {}),
        label: this.defaultAgent.label,
        explicit: false,
        reception: true,
      };
    }
    return null;
  }

  private async acquireRuntime(
    chatId: string,
    threadId: string | null,
    binding: EffectiveBinding,
  ): Promise<ChatRuntime> {
    const key = runtimeKey(chatId, threadId);
    const existing = this.chats.get(key);
    if (existing) return existing;

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

    const pinned = await this.sessionStore.getLatest(chatId, threadId);
    const effective: EffectiveBinding = pinned
      ? {
          cwd: pinned.cwd,
          command: pinned.agentCommand,
          args: pinned.agentArgs,
          ...(pinned.agentEnv ? { env: pinned.agentEnv } : {}),
          label: pinned.agentLabel ?? pinned.agentCommand,
          explicit: binding.explicit,
          reception: false,
        }
      : binding;

    // Inject the chat id + settings path so the agent can bind this chat by
    // editing settings.json. In the reception area also drop instruction files
    // that explain how (the agent reads AGENTS.md / CLAUDE.md on start).
    const injectedEnv = this.buildAgentEnv(chatId, threadId, effective);
    if (effective.reception) this.writeBindInstructions(effective.cwd, chatId);

    const runtime = new ChatRuntime({
      chatId,
      threadId,
      agentCommand: effective.command,
      agentArgs: [...effective.args],
      agentCwd: effective.cwd,
      ...(injectedEnv ? { agentEnv: injectedEnv } : {}),
      showThoughts: this.display.showThoughts,
      showTools: this.display.showTools,
      showCancelButton: this.display.showCancelButton,
      permissionTimeoutMs: this.display.permissionTimeoutMs,
      permissionMode: this.display.permissionMode,
      agentLabel: effective.label,
      presenter: this.presenter,
      sessionStore: this.sessionStore,
      logger: this.logger,
    });
    this.chats.set(key, runtime);
    return runtime;
  }

  /**
   * Compose the agent subprocess env: the binding's own env (if any) plus
   * `LARK_ACP_CHAT_ID` and `LARK_ACP_SETTINGS` so the agent knows which chat
   * it serves and where to persist a binding.
   */
  private buildAgentEnv(
    chatId: string,
    threadId: string | null,
    binding: EffectiveBinding,
  ): Record<string, string> | undefined {
    const base: Record<string, string> = { ...(binding.env ?? {}) };
    base["LARK_ACP_CHAT_ID"] = chatId;
    base["LARK_ACP_THREAD_ID"] = threadId ?? "";
    if (this.settingsPath) base["LARK_ACP_SETTINGS"] = this.settingsPath;
    if (this.controlSocketPath) base["LARK_ACP_CONTROL_SOCKET"] = this.controlSocketPath;
    return Object.keys(base).length > 0 ? base : undefined;
  }

  /**
   * Write `AGENTS.md` + `CLAUDE.md` into the reception cwd telling the agent
   * how to bind this chat. Best-effort: a write failure just means the agent
   * lacks the hint (it can still be told inline). Never throws.
   */
  private writeBindInstructions(cwd: string, chatId: string): void {
    if (!this.settingsPath) return;
    const doc = renderBindInstructions(chatId, this.settingsPath, this.controlSocketPath);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        fs.writeFileSync(path.join(cwd, name), doc, "utf-8");
      } catch (err) {
        this.logger.warn({ err, cwd, name }, "failed to write bind instructions");
      }
    }
  }

  private writeHomeInstructions(): void {
    const settingsPath = this.settingsPath;
    if (!settingsPath) return;
    const homeDir = path.dirname(settingsPath);
    try {
      installHomeTemplates({
        homeDir,
        settingsPath,
        sessionsPath: path.join(homeDir, "sessions.json"),
        controlSocketPath: this.controlSocketPath,
        overwriteDocs: true,
      });
    } catch (err) {
      this.logger.warn({ err, homeDir }, "failed to install lark-acp home templates");
    }
  }

  // ----- Hot-reload of settings.json bindings -----------------------------

  /** Snapshot the current bindings. Used as the baseline the watcher diffs against. */
  private async snapshotBindings(): Promise<void> {
    this.bindingSnapshots.clear();
    const all = await this.bindingStore.list();
    for (const b of all) {
      this.bindingSnapshots.set(b.chatId, bindingSnapshotOf(b));
    }
  }

  /**
   * Watch settings.json for external edits (the agent binding a chat, or a
   * hand edit) and hot-reload. Disabled when no settings path is configured.
   * Debounced because fs.watch double-fires; tolerant of transient read
   * failures (a half-written file yields no changes, retried on the next event).
   */
  private startSettingsWatcher(): void {
    if (!this.settingsPath) return;
    const target = this.settingsPath;
    try {
      // Watch the directory, not the file: editors/atomic renames replace the
      // inode, which breaks a file-level watch. Filter to the settings file.
      const dir = path.dirname(target);
      const base = path.basename(target);
      this.settingsWatcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== base) return;
        this.scheduleReload();
      });
      this.logger.info({ settings: target }, "watching settings.json for binding changes");
    } catch (err) {
      this.logger.warn({ err, settings: target }, "could not watch settings.json — hot-reload off");
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reloadBindings().catch((err) => this.logger.error({ err }, "binding hot-reload failed"));
    }, SETTINGS_RELOAD_DEBOUNCE_MS);
  }

  /**
   * Re-read bindings and apply any adds/changes/removals. A changed or removed
   * binding tears down that chat's live runtime so the next message respawns
   * in the new cwd (or the reception area). Other chats + the WS are untouched.
   */
  private async reloadBindings(): Promise<void> {
    // Skip transient corruption: if the store can tell us the settings file is
    // mid-write / unparseable, wait for the next event rather than mistaking a
    // half-written file for "all bindings removed" and tearing down every chat.
    const store = this.bindingStore as { isReadable?: () => boolean };
    if (typeof store.isReadable === "function" && !store.isReadable()) {
      this.logger.debug("settings.json not readable yet — deferring hot-reload");
      return;
    }

    const all = await this.bindingStore.list();
    const next = new Map<string, BindingSnapshot>();
    for (const b of all) next.set(b.chatId, bindingSnapshotOf(b));

    const affected: Array<{
      readonly chatId: string;
      readonly before?: BindingSnapshot;
      readonly after?: BindingSnapshot;
    }> = [];
    // Added or changed.
    for (const [chatId, after] of next) {
      const before = this.bindingSnapshots.get(chatId);
      if (!sameBindingSnapshot(before, after)) affected.push({ chatId, before, after });
    }
    // Removed.
    for (const [chatId, before] of this.bindingSnapshots) {
      if (!next.has(chatId)) affected.push({ chatId, before });
    }

    if (affected.length === 0) return;

    this.bindingSnapshots = next;
    for (const change of affected) {
      const { chatId } = change;
      const hadRuntime = this.chats.has(chatId);
      this.teardownChat(chatId);
      // The chat's persisted ACP sessions belonged to the *previous* binding
      // (often the reception-area agent). A new binding means a different cwd
      // and possibly a different agent binary, so resuming those sessions
      // would fail. Drop them: the next message starts a fresh session in the
      // newly-bound repo.
      await this.clearChatSessions(chatId).catch((err) =>
        this.logger.warn({ err, chatId }, "failed to clear sessions on rebind"),
      );
      this.logger.info(
        { chatId, rebound: next.has(chatId), hadRuntime },
        "binding changed — chat runtime reset",
      );
      if (change.after) {
        await this.presenter
          .sendNoticeCard(chatId, buildRepoBoundNotice(change.before ?? null, change.after))
          .catch((err) => this.logger.warn({ err, chatId }, "repo bind notice failed"));
      }
    }
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.c) return;

    // Older cards (pre-topic) carry no `th`; `?? null` maps them to the chat's
    // main conversation, matching how those runtimes are keyed.
    const threadId = value.th ?? null;

    if (value.cancel === true) {
      this.handleCancelButton(value.c, threadId);
      return;
    }

    if (!value.r || !value.o) return;
    this.handlePermissionCardAction(
      event,
      value.c,
      threadId,
      value.r,
      value.o,
      value.n,
      value.ok,
      value.k,
      value.t,
    );
  }

  private handleCancelButton(chatId: string, threadId: string | null): void {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (!runtime) {
      this.logger.info({ chatId, threadId }, "cancel button clicked but no active runtime");
      return;
    }
    this.logger.info({ chatId, threadId }, "cancel button clicked");
    runtime
      .cancel()
      .catch((err) => this.logger.warn({ err, chatId, threadId }, "cancel via card button failed"));
  }

  private handlePermissionCardAction(
    event: Lark.CardActionEvent,
    chatId: string,
    threadId: string | null,
    requestId: string,
    optionId: string,
    optionName: string | undefined,
    optionKind: string | undefined,
    toolKind: string | undefined,
    toolTitle: string | undefined,
  ): void {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    const handled = runtime?.handleCardAction(requestId, optionId) ?? false;
    const messageId = event.messageId;

    if (!handled) {
      this.logger.info({ chatId, threadId, requestId }, "orphan card action — patching as expired");
      if (messageId) {
        this.presenter
          .expirePermissionCard(messageId, ORPHAN_CARD_REASON)
          .catch((err) => this.logger.warn({ err }, "expirePermissionCard failed"));
      }
      return;
    }

    this.logger.info({ chatId, optionId }, "card action resolved");

    if (messageId && optionName && toolKind && toolTitle) {
      this.presenter
        .updatePermissionCard(messageId, toolKind, toolTitle, optionName, optionKind)
        .catch((err) => this.logger.warn({ err }, "updatePermissionCard failed"));
    }
  }

  // ----- Lifecycle helpers ------------------------------------------------

  /**
   * Shut down and forget one topic's runtime (the `(chatId, threadId)` pair).
   * Used by the thread-scoped `/new` ("Reset Thread") command; the chat's
   * other topics keep running.
   */
  private teardownThread(chatId: string, threadId: string | null): void {
    const key = runtimeKey(chatId, threadId);
    const runtime = this.chats.get(key);
    if (!runtime) return;
    runtime.shutdown();
    this.chats.delete(key);
  }

  /**
   * Shut down and forget *every* runtime belonging to a chat — its main
   * conversation and all topic threads. Used by chat-scoped operations
   * (bind / unbind / rebind) that swap the repo out from under every topic.
   */
  private teardownChat(chatId: string): void {
    // Safe to delete during Map iteration: the iterator tolerates removing the
    // current/visited key (only concurrent insertion is problematic).
    for (const [key, runtime] of this.chats) {
      if (runtime.chatId !== chatId) continue;
      runtime.shutdown();
      this.chats.delete(key);
    }
  }

  /**
   * Drop every persisted ACP session for a chat, across all its topics
   * (used on bind / unbind / rebind).
   */
  private async clearChatSessions(chatId: string): Promise<void> {
    const sessions = await this.sessionStore.listByChat(chatId);
    await Promise.all(sessions.map((s) => this.sessionStore.delete(chatId, s.sessionId)));
  }

  /**
   * Drop the persisted ACP sessions for one topic only (used by the
   * thread-scoped `/new`). Other topics in the same chat are untouched.
   */
  private async clearThreadSessions(chatId: string, threadId: string | null): Promise<void> {
    const sessions = await this.sessionStore.listByThread(chatId, threadId);
    await Promise.all(sessions.map((s) => this.sessionStore.delete(chatId, s.sessionId)));
  }

  private evictIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [key, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (now - runtime.lastActivity <= this.idleTimeoutMs) continue;
      this.logger.info(
        { chatId: runtime.chatId, threadId: runtime.threadId },
        "evicting idle chat",
      );
      runtime.shutdown();
      this.chats.delete(key);
    }
  }

  private evictOldest(): void {
    let oldest: { key: string; lastActivity: number } | null = null;
    for (const [key, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (!oldest || runtime.lastActivity < oldest.lastActivity) {
        oldest = { key, lastActivity: runtime.lastActivity };
      }
    }
    if (!oldest) return;
    const runtime = this.chats.get(oldest.key);
    this.logger.info(
      { chatId: runtime?.chatId, threadId: runtime?.threadId },
      "max concurrent chats reached — evicting oldest",
    );
    runtime?.shutdown();
    this.chats.delete(oldest.key);
  }
}

function renderInlineControlHint(chatId: string, threadId: string | null): string {
  return `[lark-acp: 若用户要求绑定/改绑仓库、把当前 topic 绑定到已有 agent session，或切换当前 session 的 model/mode/config/permission control，请先阅读 ~/.lark-acp/AGENTS.md（或 CLAUDE.md）中的 lark-acp 指引；本会话 chatId=${chatId}, threadId=${threadId ?? "<main>"}。其它请求忽略本提示。]`;
}

function buildSessionBoundNotice(
  record: SessionRecord,
  before?: SessionRecord | null,
): NoticeCardSpec {
  const title = record.title ?? "Untitled session";
  const beforeTitle = before?.title ?? (before ? "Untitled session" : "未绑定");
  const beforeAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
  const beforeRepo = before?.cwd ?? "未绑定";
  const lines = [
    `已将当前 topic 绑定到已有 session。`,
    "",
    `**修改明细**`,
    `• Repo：${beforeRepo} → ${record.cwd}`,
    `• Agent：${beforeAgent} → ${record.agentLabel ?? record.agentCommand}`,
    `• Session title：${beforeTitle} → ${title}`,
    `• Session ID：${before ? "已存在" : "未绑定"} → 已更新（已隐藏）`,
    "",
    `**绑定后**`,
    `• Title: ${title}`,
    `• Agent: ${record.agentLabel ?? record.agentCommand}`,
    `• Repo: ${record.cwd}`,
  ];
  if (record.sessionUpdatedAt) lines.push(`• Session updated: ${record.sessionUpdatedAt}`);
  return {
    title: "✅ 已绑定 session",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildSessionBindRejectedNotice(
  record: SessionRecord,
  err: SessionAlreadyBoundError,
): NoticeCardSpec {
  const title = record.title ?? "Untitled session";
  const lines = [
    "这个 session 已经绑定到另一个 thread，已拒绝本次绑定。",
    "",
    "**冲突明细**",
    `• Session title：${title}`,
    `• 目标 Repo：${record.cwd}`,
    `• 目标 Agent：${record.agentLabel ?? record.agentCommand}`,
    `• 已绑定 Chat：已隐藏`,
    `• 已绑定 Thread：${err.existingThreadId === null ? "<main>" : "已隐藏"}`,
    "",
    "请先在原 thread 执行 /new 重置，或确认不再需要原 thread 后再重新绑定。",
  ];
  return {
    title: "⚠️ Session 已被绑定",
    body: lines.join("\n"),
    template: "orange",
  };
}

function bindingSnapshotOf(binding: ChatBinding): BindingSnapshot {
  return { cwd: binding.cwd, agentLabel: binding.agentLabel };
}

function sameBindingSnapshot(
  before: BindingSnapshot | undefined,
  after: BindingSnapshot | undefined,
): boolean {
  return before?.cwd === after?.cwd && before?.agentLabel === after?.agentLabel;
}

function buildRepoBoundNotice(
  before: BindingSnapshot | ChatBinding | null | undefined,
  after: BindingSnapshot | ChatBinding,
): NoticeCardSpec {
  const beforeCwd = before?.cwd ?? "未绑定";
  const beforeAgent = before?.agentLabel ?? "未绑定";
  const changedRepo = before?.cwd !== after.cwd;
  const changedAgent = before?.agentLabel !== after.agentLabel;
  const changed = [changedRepo ? "repo" : null, changedAgent ? "agent" : null]
    .filter((item): item is string => item !== null)
    .join("、");
  const lines = [
    "本会话已绑定到 repo。",
    "",
    "**修改明细**",
    `• Repo：${beforeCwd} → ${after.cwd}`,
    `• Agent：${beforeAgent} → ${after.agentLabel}`,
    `• 变更项：${changed || "无实际变化"}`,
    "",
    "**绑定后**",
    `• Repo：${after.cwd}`,
    `• Agent：${after.agentLabel}`,
    "",
    "下条消息将在该目录启动 agent。",
  ];
  return {
    title: "✅ 已绑定 repo",
    body: lines.join("\n"),
    template: "green",
  };
}

/**
 * Render the bind-instruction doc dropped into the reception cwd. It tells the
 * agent how to bind THIS chat to a repo by editing settings.json — including
 * that it may pick any agent (claude / codex / copilot / gemini / opencode).
 */
function renderBindInstructions(
  chatId: string,
  settingsPath: string,
  socketPath: string | null,
): string {
  return [
    "# lark-acp — how to bind this chat to a repository",
    "",
    "You are running as a lark-acp agent for a Feishu/Lark chat. This chat is",
    "**not yet bound** to a project directory, so you are running in a reception",
    "area. When the user asks to work on / bind to a specific repository, do the",
    "following:",
    "",
    "1. Determine the absolute path of the repository they mean (ask if unsure).",
    '2. Determine which agent to use. If they name one (e.g. "use claude",',
    '   "用 codex"), honour it. Valid agents: `claude`, `codex`, `copilot`,',
    "   `gemini`, `opencode`, `claude-agent`. If they don't say, use `claude`.",
    "3. Edit the JSON file at:",
    `   ${settingsPath}`,
    "   Add (or update) an entry under the top-level `bindings` object keyed by",
    "   this chat's id. Preserve all other keys in the file.",
    "",
    "```json",
    "{",
    '  "bindings": {',
    `    "${chatId}": { "cwd": "/absolute/path/to/repo", "agent": "claude" }`,
    "  }",
    "}",
    "```",
    "",
    `This chat's id is: ${chatId}`,
    "(also available in the env var LARK_ACP_CHAT_ID; the settings file path is",
    "in LARK_ACP_SETTINGS.)",
    "",
    "After you save the file, lark-acp detects the change and re-routes this chat",
    "to the bound repository automatically — the user's next message will run",
    "there. Tell the user the binding is done and which repo + agent you set.",
    "",
    "Do not delete other chats' bindings or other top-level keys (credentials,",
    "runtime, agents).",
    "",
    "For model/mode/config/permission session controls, read ~/.lark-acp/AGENTS.md",
    "or ~/.lark-acp/CLAUDE.md and use the lark-acp control/sessions CLI. Do not",
    "guess model/mode/config ids; query live capabilities first.",
    ...(socketPath ? ["", `Control socket: ${socketPath}`] : []),
    "",
  ].join("\n");
}

/**
 * Expand a leading `~` to the user's home dir, resolve to an absolute path,
 * and assert it is an existing directory.
 *
 * @throws {BindError} when the path does not exist or is not a directory.
 */
function expandAndValidateDir(rawPath: string): string {
  const expanded =
    rawPath === HOME_PREFIX || rawPath.startsWith(`${HOME_PREFIX}/`)
      ? path.join(os.homedir(), rawPath.slice(HOME_PREFIX.length))
      : rawPath;
  const resolved = path.resolve(expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new BindError(`路径不存在：${resolved}`);
  }
  if (!stat.isDirectory()) throw new BindError(`不是目录：${resolved}`);
  return resolved;
}
