import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
} from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
import type { PermissionMode } from "../acp/lark-acp-client.js";
import type { NoticeCardSpec } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
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
    title: "已取消",
    body: "已取消当前任务，agent 进程保留以便后续消息继续。",
    template: "grey",
  },
  new: {
    title: "已重置会话",
    body: "下次消息将启动一个全新的 agent 会话。",
    template: "green",
  },
  unbind: {
    title: "已解绑",
    body: "本会话已解绑，agent 进程已停止。下次消息将使用默认配置（若已配置），否则请先 /bind <路径> [agent]。",
    template: "grey",
  },
};

const BIND_USAGE_NOTICE: NoticeCardSpec = {
  title: "用法：/bind",
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
 * Raised by {@link resolveBindTarget} when a `/bind` request is invalid —
 * a non-existent path or an unresolvable agent selection. The message is
 * user-facing (sent back as a Lark notice card).
 */
class BindError extends Error {
  override readonly name = "BindError";
}

function formatBootstrapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
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
  /** Tool kind (set on permission cards). */
  k?: string;
  /** Tool title (set on permission cards). */
  t?: string;
  /** Chat id — present on every card the bridge produces. */
  c?: string;
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

export interface LarkBridgeOptions {
  lark: LarkBridgeLarkOptions;
  agent: LarkBridgeAgentOptions;
  session?: LarkBridgeSessionOptions;

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
  private readonly lark: LarkBridgeLarkOptions;

  private readonly chats = new Map<string, ChatRuntime>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ws: LarkWsConnection | null = null;
  private started = false;
  /** fs.watch handle for hot-reloading settings.json (null when disabled). */
  private settingsWatcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Snapshot of the last-applied bindings, for diffing on hot-reload. */
  private bindingSignatures = new Map<string, string>();

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
  }

  async stop(): Promise<void> {
    this.logger.info("stopping bridge");
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.settingsWatcher) {
      this.settingsWatcher.close();
      this.settingsWatcher = null;
    }
    for (const runtime of this.chats.values()) runtime.shutdown();
    this.chats.clear();
    await this.sessionStore.close();
    await this.bindingStore.close();
    this.logger.info("bridge stopped");
  }

  /** Active chat runtime count (mostly for tests / metrics). */
  get activeChatCount(): number {
    return this.chats.size;
  }

  // ----- WS event handlers ------------------------------------------------

  private handleMessage(event: Lark.RawMessageEvent): void {
    const { message, sender } = event;
    if (sender.sender_type !== SENDER_TYPE_USER) return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    if (!userId || !messageId || !chatId) return;

    this.logger.info({ userId, chatId, messageType: message.message_type }, "message received");

    this.routeMessage(event, userId, messageId, chatId).catch((err) =>
      this.logger.error({ err, chatId }, "routeMessage failed"),
    );
  }

  private async routeMessage(
    event: Lark.RawMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
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
        await this.handleCommand(interpreted.command, chatId, messageId);
        return;
      case "prompt":
        await this.enqueueWithContext(event, chatId, userId, messageId, interpreted.blocks);
        return;
      default:
        return assertNever(interpreted);
    }
  }

  private async handleCommand(
    command: LarkCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    switch (command.kind) {
      case "cancel": {
        this.logger.info({ chatId }, "cancel command");
        const runtime = this.chats.get(chatId);
        try {
          await runtime?.cancel();
        } catch (err) {
          this.logger.warn({ err, chatId }, "cancel command failed");
        }
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.cancel);
        return;
      }
      case "new": {
        this.logger.info({ chatId }, "new session command");
        this.teardownChat(chatId);
        await this.clearChatSessions(chatId);
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
        title: "绑定失败",
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

    // A rebind changes repo/agent; tear down the live runtime and drop any
    // persisted ACP sessions so the next message starts fresh in the new cwd
    // instead of resuming a session that belongs to the old repo.
    this.teardownChat(chatId);
    await this.clearChatSessions(chatId);

    this.logger.info({ chatId, cwd: target.cwd, agent: target.invocation.label }, "chat bound");
    await this.presenter.replyNoticeCard(messageId, {
      title: "已绑定",
      body: `本会话已绑定：\n• 目录：${target.cwd}\n• Agent：${target.invocation.label}\n\n下条消息将在该目录启动 agent。`,
      template: "green",
    });
  }

  private async handleUnbind(chatId: string, messageId: string): Promise<void> {
    const existing = await this.bindingStore.get(chatId);
    if (!existing) {
      await this.presenter.replyNoticeCard(messageId, {
        title: "未绑定",
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
        title: "未绑定",
        body: "本会话尚未绑定，且没有配置默认目录。\n请先 /bind <路径> [agent]。",
        template: "orange",
      });
      return;
    }
    const source = binding.explicit ? "显式绑定" : "默认配置（未显式绑定）";
    await this.presenter.replyNoticeCard(messageId, {
      title: "当前绑定",
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
    userId: string,
    messageId: string,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      this.logger.info({ chatId }, "message in unbound chat — reception disabled, prompting /bind");
      await this.presenter.replyNoticeCard(messageId, {
        title: "尚未绑定仓库",
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

    // In the reception area, remind the agent (inline, every turn) that this
    // chat is unbound and how to bind it — reinforces the AGENTS.md/CLAUDE.md
    // dropped at spawn, in case the agent's harness ignores those files.
    if (binding.reception) {
      prompt.unshift({
        type: "text",
        text:
          `[lark-acp: 本会话尚未绑定到具体仓库，当前运行在接待区。若用户要求绑定/切换到某个仓库，` +
          `请按工作目录下 AGENTS.md 的说明，编辑 settings.json 的 bindings["${chatId}"] = ` +
          `{ cwd, agent }（agent 可为 claude/codex/copilot/gemini/opencode，用户指定则从其指定）。` +
          `保存后 lark-acp 会自动重新路由，无需重启。本会话 chatId: ${chatId}]`,
      });
    }

    prompt.unshift({ type: "text", text: context });

    const runtime = this.acquireRuntime(chatId, binding);
    const pending: PendingMessage = { prompt, messageId, chatId };
    try {
      await runtime.enqueue(pending);
    } catch (err) {
      // bootstrap (spawn / initialize / newSession / resume) failed — the
      // ChatRuntime never registered itself as active, so drop it and let
      // the next message try again from scratch.
      this.chats.delete(chatId);
      this.logger.error({ err, chatId }, "agent bootstrap failed");
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

  private acquireRuntime(chatId: string, binding: EffectiveBinding): ChatRuntime {
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

    // Inject the chat id + settings path so the agent can bind this chat by
    // editing settings.json. In the reception area also drop instruction files
    // that explain how (the agent reads AGENTS.md / CLAUDE.md on start).
    const injectedEnv = this.buildAgentEnv(chatId, binding);
    if (binding.reception) this.writeBindInstructions(binding.cwd, chatId);

    const runtime = new ChatRuntime({
      chatId,
      agentCommand: binding.command,
      agentArgs: [...binding.args],
      agentCwd: binding.cwd,
      ...(injectedEnv ? { agentEnv: injectedEnv } : {}),
      showThoughts: this.display.showThoughts,
      showTools: this.display.showTools,
      showCancelButton: this.display.showCancelButton,
      permissionTimeoutMs: this.display.permissionTimeoutMs,
      permissionMode: this.display.permissionMode,
      presenter: this.presenter,
      sessionStore: this.sessionStore,
      logger: this.logger,
    });
    this.chats.set(chatId, runtime);
    return runtime;
  }

  /**
   * Compose the agent subprocess env: the binding's own env (if any) plus
   * `LARK_ACP_CHAT_ID` and `LARK_ACP_SETTINGS` so the agent knows which chat
   * it serves and where to persist a binding.
   */
  private buildAgentEnv(
    chatId: string,
    binding: EffectiveBinding,
  ): Record<string, string> | undefined {
    const base: Record<string, string> = { ...(binding.env ?? {}) };
    base["LARK_ACP_CHAT_ID"] = chatId;
    if (this.settingsPath) base["LARK_ACP_SETTINGS"] = this.settingsPath;
    return Object.keys(base).length > 0 ? base : undefined;
  }

  /**
   * Write `AGENTS.md` + `CLAUDE.md` into the reception cwd telling the agent
   * how to bind this chat. Best-effort: a write failure just means the agent
   * lacks the hint (it can still be told inline). Never throws.
   */
  private writeBindInstructions(cwd: string, chatId: string): void {
    if (!this.settingsPath) return;
    const doc = renderBindInstructions(chatId, this.settingsPath);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        fs.writeFileSync(path.join(cwd, name), doc, "utf-8");
      } catch (err) {
        this.logger.warn({ err, cwd, name }, "failed to write bind instructions");
      }
    }
  }

  // ----- Hot-reload of settings.json bindings -----------------------------

  /**
   * Snapshot the current bindings into `bindingSignatures` (chatId ->
   * "cwd|label"). Used as the baseline the watcher diffs against.
   */
  private async snapshotBindings(): Promise<void> {
    this.bindingSignatures.clear();
    const all = await this.bindingStore.list();
    for (const b of all) {
      this.bindingSignatures.set(b.chatId, `${b.cwd}|${b.agentLabel}`);
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
    const next = new Map<string, string>();
    for (const b of all) next.set(b.chatId, `${b.cwd}|${b.agentLabel}`);

    const affected: string[] = [];
    // Added or changed.
    for (const [chatId, sig] of next) {
      if (this.bindingSignatures.get(chatId) !== sig) affected.push(chatId);
    }
    // Removed.
    for (const chatId of this.bindingSignatures.keys()) {
      if (!next.has(chatId)) affected.push(chatId);
    }

    if (affected.length === 0) return;

    this.bindingSignatures = next;
    for (const chatId of affected) {
      const hadRuntime = this.chats.has(chatId);
      this.teardownChat(chatId);
      this.logger.info(
        { chatId, rebound: next.has(chatId), hadRuntime },
        "binding changed — chat runtime reset",
      );
    }
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.c) return;

    if (value.cancel === true) {
      this.handleCancelButton(value.c);
      return;
    }

    if (!value.r || !value.o) return;
    this.handlePermissionCardAction(event, value.c, value.r, value.o, value.n, value.k, value.t);
  }

  private handleCancelButton(chatId: string): void {
    const runtime = this.chats.get(chatId);
    if (!runtime) {
      this.logger.info({ chatId }, "cancel button clicked but no active runtime");
      return;
    }
    this.logger.info({ chatId }, "cancel button clicked");
    runtime
      .cancel()
      .catch((err) => this.logger.warn({ err, chatId }, "cancel via card button failed"));
  }

  private handlePermissionCardAction(
    event: Lark.CardActionEvent,
    chatId: string,
    requestId: string,
    optionId: string,
    optionName: string | undefined,
    toolKind: string | undefined,
    toolTitle: string | undefined,
  ): void {
    const runtime = this.chats.get(chatId);
    const handled = runtime?.handleCardAction(requestId, optionId) ?? false;
    const messageId = event.messageId;

    if (!handled) {
      this.logger.info({ chatId, requestId }, "orphan card action — patching as expired");
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
        .updatePermissionCard(messageId, toolKind, toolTitle, optionName)
        .catch((err) => this.logger.warn({ err }, "updatePermissionCard failed"));
    }
  }

  // ----- Lifecycle helpers ------------------------------------------------

  /** Shut down and forget a chat's live runtime, if any. */
  private teardownChat(chatId: string): void {
    const runtime = this.chats.get(chatId);
    if (!runtime) return;
    runtime.shutdown();
    this.chats.delete(chatId);
  }

  /** Drop every persisted ACP session for a chat (used on bind / unbind / new). */
  private async clearChatSessions(chatId: string): Promise<void> {
    const sessions = await this.sessionStore.listByChat(chatId);
    await Promise.all(sessions.map((s) => this.sessionStore.delete(chatId, s.sessionId)));
  }

  private evictIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (now - runtime.lastActivity <= this.idleTimeoutMs) continue;
      this.logger.info({ chatId }, "evicting idle chat");
      runtime.shutdown();
      this.chats.delete(chatId);
    }
  }

  private evictOldest(): void {
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (!oldest || runtime.lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity: runtime.lastActivity };
      }
    }
    if (!oldest) return;
    this.logger.info({ chatId: oldest.chatId }, "max concurrent chats reached — evicting oldest");
    const runtime = this.chats.get(oldest.chatId);
    runtime?.shutdown();
    this.chats.delete(oldest.chatId);
  }
}

/**
 * Render the bind-instruction doc dropped into the reception cwd. It tells the
 * agent how to bind THIS chat to a repo by editing settings.json — including
 * that it may pick any agent (claude / codex / copilot / gemini / opencode).
 */
function renderBindInstructions(chatId: string, settingsPath: string): string {
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
