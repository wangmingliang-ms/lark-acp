import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import {
  sendLifecycleNotice,
  type LifecycleCodeRevision,
  type LifecycleNoticeKind,
} from "../lark/lifecycle-notifier.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import { installHomeTemplates } from "../home-templates.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { renderCommandHelpBody } from "../interpreter/commands.js";
import { BridgeControlServer, type AgentProbeFailureTarget } from "./control-server.js";
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
  type PromptSegment,
} from "../interpreter/lark-interpreter.js";
import {
  ChatRuntime,
  formatControlFailure,
  validateSessionControls,
  type PendingMessage,
} from "./chat-runtime.js";
import { DEFAULT_INBOUND_DIR, sweepInboundDir } from "./inbound-store.js";
import { hydratePrompt } from "./prompt-hydrator.js";
import type { PermissionMode } from "../acp/humming-client.js";
import {
  AgentAuthError,
  probeAgentSessionCapabilities,
  type ProbeAgentSessionCapabilitiesResult,
} from "../acp/agent-process.js";
import { SessionAlreadyBoundError } from "../session-store/file-session-store.js";
import type {
  AgentStatus,
  AgentSwitchWarningCardSpec,
  NoticeCardSpec,
} from "../presenter/presenter.js";
import type {
  PendingSessionTask,
  PendingTargetProfile,
  SessionCapabilitiesSnapshot,
  SessionControlPatch,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";
import type { BindingStore, ChatBinding } from "../binding-store/binding-store.js";

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHATS = 10;
const DEFAULT_SHOW_THOUGHTS = true;
const DEFAULT_SHOW_TOOLS = true;
const DEFAULT_SHOW_CANCEL_BUTTON = true;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_STATUS_CARD_MS = 10_000;
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
    body: "本会话已解绑，agent 进程已停止。下次消息将使用默认配置（若已配置），否则请先 /bind <路径>。",
    template: "grey",
  },
};

const BIND_USAGE_NOTICE: NoticeCardSpec = {
  title: "ℹ️ 用法：/bind",
  body: [
    "把当前会话绑定到一个仓库目录：",
    "",
    "• /bind <路径>            绑定目录",
    "",
    "Agent / Model / Mode / Permission / Controls 属于 session profile，不属于 chat binding。新 topic 会继承当前 repo 最近 session profile；没有历史 session 时使用全局默认 Agent。",
    "",
    "其它命令：",
    "• /where                 查看当前绑定",
    "• /unbind                解除绑定",
    "",
    "示例：/bind ~/workspace/copilot-intellij",
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

const MAX_USER_FACING_ERROR_CHARS = 1_000;

function truncateUserFacingError(message: string): string {
  if (message.length <= MAX_USER_FACING_ERROR_CHARS) return message;
  return `${message.slice(0, MAX_USER_FACING_ERROR_CHARS).trimEnd()}…（已截断，完整错误见 bridge.log）`;
}

function formatBootstrapError(err: unknown): string {
  // Auth failures get a clean, actionable message — no confusing internal
  // "failed to create session" chain.
  if (err instanceof AgentAuthError) return `🔑 ${truncateUserFacingError(err.message)}`;
  if (!(err instanceof Error)) return truncateUserFacingError(String(err));
  const cause = err.cause;
  if (cause instanceof AgentAuthError) return `🔑 ${truncateUserFacingError(cause.message)}`;
  if (cause instanceof Error && cause.message) {
    return truncateUserFacingError(`${err.message}\n→ ${cause.message}`);
  }
  return truncateUserFacingError(err.message);
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
  /** Pending destructive Agent-switch id (set on Agent switch warning cards). */
  sw?: string;
  /** Agent switch warning action. */
  swa?: "confirm" | "cancel";
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

export interface AgentListItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface LarkBridgeAgentOptions {
  /** Maps a selection string → concrete invocation. See {@link AgentResolver}. */
  resolver: AgentResolver;
  /** Agent presets shown by `/agent` with no argument. */
  availableAgents?: readonly AgentListItem[];
  /**
   * Pre-resolved agent used as the cold-start fallback when a chat/repo has no
   * session profile to inherit. Chat bindings are repo-only; Agent belongs to
   * the topic/session profile.
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
   * After a content-bearing card is quiet for this many ms, send a new empty
   * status card that the next visible event can reuse. 0 disables. Default 10s.
   */
  idleStatusCardMs?: number;
  /**
   * How to handle agent-side permission requests. Default `"alwaysAsk"`.
   * `"alwaysAllow"` / `"alwaysDeny"` auto-resolve without involving the user.
   */
  permissionMode?: PermissionMode;
  /** Session controls applied to brand-new topics when no repo/session profile can be inherited. */
  defaultControls?: SessionControls;
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
  /** File created by `humming restart`; when present, stop/start render restart wording. */
  restartMarkerPath?: string | null;
  /** Git revision of the bridge code currently running; shown on restarted notices. */
  codeRevision?: LifecycleCodeRevision;
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
   * where to write bindings via the `HUMMING_SETTINGS` env var. When unset,
   * hot-reload is disabled.
   */
  settingsPath?: string | null;

  /** Unix-domain socket for local `humming control …` requests. */
  controlSocketPath?: string | null;

  /** Direct-message chat ids whose Agent/Model/Mode/Permission changes update settings.json defaults. */
  globalDefaultControlChatIds?: readonly string[];

  sessionStore: SessionStore;
  /** Persistent per-chat repo binding (one bot → many repos). */
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
  readonly idleStatusCardMs: number;
  readonly permissionMode: PermissionMode;
}

/** A chat's effective repo + agent, ready to spawn a {@link ChatRuntime}. */
interface EffectiveBinding {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly label: string;
  /** `true` when this binding's Agent came from a stored session profile. */
  readonly profileSelected?: boolean;
  /** `true` when it came from an explicit `/bind`, `false` for the default. */
  readonly explicit: boolean;
  /**
   * `true` when this is the ephemeral reception-area binding (default agent in
   * `unboundCwd`) for a chat with no real binding. The bridge injects
   * bind-instructions into such a runtime so the user can bind by talking.
   */
  readonly reception: boolean;
  /**
   * Present when an explicit/default binding points at a directory that no
   * longer exists (or is no longer usable) and this binding is a temporary
   * fallback to the reception area so the conversation can keep going.
   */
  readonly fallbackFrom?: UnavailableBinding;
  /** Controls copied from the most recent session profile in the same chat + repo. */
  readonly inheritedControls?: SessionControls;
}

interface UnavailableBinding {
  readonly chatId: string;
  readonly cwd: string;
  readonly reason: string;
  readonly reboundCwd: string;
  readonly reboundAgentLabel: string;
}

interface BindingSnapshot {
  readonly cwd: string;
}

interface PendingAgentSwitch {
  readonly switchId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly target: ResolvedAgentInvocation;
  readonly cwd: string;
  readonly warningCardId?: string;
  readonly persistGlobalDefault?: boolean;
}

interface CommandContext {
  readonly isDirectMessage: boolean;
}

interface PendingPostTurnAgentSwitch {
  readonly record: SessionRecord;
  readonly noticeMessageId: string | null;
  readonly targetProfile?: PendingTargetProfile;
  readonly queuedNoticeMessageId?: string | null;
}

const POST_TURN_AGENT_SWITCH_TASK_HINT =
  "[humming: this prompt is the task portion of an already-applied Agent handoff. Do not call Humming session-control commands again unless the user explicitly requests another Agent/Model/Mode/Permission/Config change.]";

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
  private readonly availableAgents: readonly AgentListItem[];
  private defaultAgent: ResolvedAgentInvocation | null;
  private readonly defaultCwd: string | null;
  private defaultControls: SessionControls | undefined;
  private readonly display: DisplayOptions;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentChats: number;
  private readonly groupRequireMention: boolean;
  private readonly unboundCwd: string | null;
  private readonly settingsPath: string | null;
  private readonly controlSocketPath: string | null;
  private readonly globalDefaultControlChatIds: readonly string[];
  private readonly lark: LarkBridgeLarkOptions;
  private readonly lifecycleNotificationChatIds: readonly string[];
  private readonly restartMarkerPath: string | null;
  private readonly lifecycleCodeRevision: LifecycleCodeRevision | undefined;
  private readonly lifecycleNoticeTimeoutMs: number | undefined;

  private readonly chats = new Map<string, ChatRuntime>();
  private readonly pendingAgentSwitches = new Map<string, PendingAgentSwitch>();
  private readonly pendingPostTurnAgentSwitches = new Map<string, PendingPostTurnAgentSwitch>();
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
    this.availableAgents = opts.agent.availableAgents ?? [];
    this.defaultAgent = opts.agent.defaultAgent ?? null;
    this.defaultCwd = opts.agent.defaultCwd ?? null;
    this.defaultControls = opts.agent.defaultControls;
    this.display = {
      showThoughts: opts.agent.showThoughts ?? DEFAULT_SHOW_THOUGHTS,
      showTools: opts.agent.showTools ?? DEFAULT_SHOW_TOOLS,
      showCancelButton: opts.agent.showCancelButton ?? DEFAULT_SHOW_CANCEL_BUTTON,
      permissionTimeoutMs: opts.agent.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      idleStatusCardMs: opts.agent.idleStatusCardMs ?? DEFAULT_IDLE_STATUS_CARD_MS,
      permissionMode: opts.agent.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };

    this.idleTimeoutMs = opts.session?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrentChats = opts.session?.maxConcurrentChats ?? DEFAULT_MAX_CONCURRENT_CHATS;
    this.groupRequireMention = opts.groupRequireMention ?? false;
    this.unboundCwd = opts.unboundCwd ?? null;
    this.settingsPath = opts.settingsPath ?? null;
    this.controlSocketPath = opts.controlSocketPath ?? null;
    this.globalDefaultControlChatIds = opts.globalDefaultControlChatIds ?? [];
    this.lifecycleNotificationChatIds = opts.lifecycle?.notificationChatIds ?? [];
    this.restartMarkerPath = opts.lifecycle?.restartMarkerPath ?? null;
    this.lifecycleCodeRevision = opts.lifecycle?.codeRevision;
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
    this.sweepInboundResources();
    await this.startControlServer();

    this.cleanupTimer = setInterval(() => {
      this.evictIdle().catch((err) => this.logger.warn({ err }, "idle eviction failed"));
    }, IDLE_CLEANUP_INTERVAL_MS);
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
    await this.shutdownAllRuntimes("cancelled");
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
      ...(this.lifecycleCodeRevision !== undefined
        ? { codeRevision: this.lifecycleCodeRevision }
        : {}),
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
        setControls: async (chatId, threadId, controls) => {
          const result = await this.controlSetControls(chatId, threadId, controls);
          if (!result.rejected && this.globalDefaultControlChatIds.includes(chatId)) {
            await this.persistGlobalDefaultControls(controls, null);
          }
          return result;
        },
        setPendingTask: (chatId, threadId, task) =>
          this.controlSetPendingTask(chatId, threadId, task),
        setPendingTargetProfile: (chatId, threadId, profile, noticeMessageId) =>
          this.controlSetPendingTargetProfile(chatId, threadId, profile, noticeMessageId),
        bindSession: (record, noticeMessageId) => this.controlBindSession(record, noticeMessageId),
        setAgent: async (record, noticeMessageId) => {
          const result = await this.controlSetAgent(record, noticeMessageId);
          if (this.globalDefaultControlChatIds.includes(record.chatId)) {
            await this.persistGlobalDefaultAgent(record.agentLabel ?? record.agentCommand, null);
          }
          return result;
        },
        agentProbeFailed: (chatId, threadId, agent, error, noticeMessageId) =>
          this.controlAgentProbeFailed(chatId, threadId, agent, error, noticeMessageId),
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
    controls: SessionControlPatch,
    noticeMessageId?: string | null,
  ): Promise<{
    readonly applied: boolean;
    readonly queued?: boolean;
    readonly rejected?: boolean;
    readonly recordSessionId?: string;
    readonly reason?: string;
  }> {
    const key = runtimeKey(chatId, threadId);
    const runtime = this.chats.get(key);
    if (runtime) {
      if (runtime.processing) {
        const pendingAgentSwitch = this.pendingPostTurnAgentSwitches.get(key);
        if (pendingAgentSwitch) {
          const validation = await this.validateControlPatchForStoredProfile(
            chatId,
            threadId,
            pendingAgentSwitch.record,
            controls,
            noticeMessageId ?? runtime.lastMessageId,
          );
          if (!validation.ok) return { applied: false, rejected: true, reason: validation.reason };

          const updatedRecord: SessionRecord = {
            ...pendingAgentSwitch.record,
            controls: mergeStoredControls(pendingAgentSwitch.record.controls, controls),
            updatedAt: Date.now(),
          };
          this.pendingPostTurnAgentSwitches.set(key, {
            ...pendingAgentSwitch,
            record: updatedRecord,
          });
          const replyTo = noticeMessageId ?? runtime.lastMessageId ?? chatId;
          await this.presenter
            .replyNoticeCard(
              replyTo,
              buildPendingAgentSwitchControlQueuedNotice(
                pendingAgentSwitch.record,
                updatedRecord,
                controls,
              ),
            )
            .catch((err) =>
              this.logger.warn(
                { err, chatId, threadId },
                "pending target control queue notice failed",
              ),
            );
          return { applied: false, queued: true, recordSessionId: updatedRecord.sessionId };
        }

        const before = await this.sessionStore.getLatest(chatId, threadId);
        const snapshot = runtime.capabilities();
        const validation = await this.validateControlPatchForSnapshot(
          snapshot,
          controls,
          noticeMessageId ?? runtime.lastMessageId,
        );
        if (!validation.ok) return { applied: false, rejected: true, reason: validation.reason };
        const record = await this.sessionStore.setPendingControls({ chatId, threadId }, controls);
        const replyTo = noticeMessageId ?? runtime.lastMessageId ?? chatId;
        const queuedNoticeMessageId = await this.presenter
          .replyNoticeCard(replyTo, buildPendingControlQueuedNotice(before, record, controls))
          .catch((err) => {
            this.logger.warn({ err, chatId, threadId }, "pending control queue notice failed");
            return null;
          });
        if (queuedNoticeMessageId) {
          await this.sessionStore.save({
            ...record,
            pendingControlsNoticeMessageId: queuedNoticeMessageId,
          });
        }
        return { applied: false, queued: true, recordSessionId: record.sessionId };
      }
      try {
        await runtime.applyControls(controls, noticeMessageId ?? undefined);
        return { applied: true, recordSessionId: runtime.capabilities().session.sessionId };
      } catch (err) {
        return { applied: false, rejected: true, reason: formatControlFailure(err) };
      }
    }

    const before = await this.sessionStore.getLatest(chatId, threadId);
    const validation = await this.validateControlPatchForStoredProfile(
      chatId,
      threadId,
      before,
      controls,
      noticeMessageId ?? null,
    );
    if (!validation.ok) return { applied: false, rejected: true, reason: validation.reason };
    const record = await this.sessionStore.setControls({ chatId, threadId }, controls);
    const notice = buildStoredControlUpdatedNotice(before, record, controls);
    const sendStoredNotice = noticeMessageId
      ? this.presenter.replyNoticeCard(noticeMessageId, notice)
      : this.presenter.sendNoticeCard(chatId, notice);
    await sendStoredNotice.catch((err) =>
      this.logger.warn({ err, chatId, threadId }, "stored control notice failed"),
    );
    return { applied: false, recordSessionId: record.sessionId };
  }

  private async validateControlPatchForStoredProfile(
    chatId: string,
    threadId: string | null,
    before: SessionRecord | null,
    controls: SessionControlPatch,
    noticeMessageId: string | null,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const bridgeOnlySnapshot = buildBridgeOnlyValidationSnapshot(
      chatId,
      threadId,
      before,
      controls,
    );
    if (!controlPatchNeedsAgentCapabilities(controls)) {
      return this.validateControlPatchForSnapshot(bridgeOnlySnapshot, controls, noticeMessageId);
    }
    const snapshot = await this.resolveSessionCapabilitiesForControlValidation(
      chatId,
      threadId,
      before,
      noticeMessageId,
    );
    if (!snapshot) return { ok: false, reason: "capabilities probe failed" };
    return this.validateControlPatchForSnapshot(snapshot, controls, noticeMessageId);
  }

  private async validateControlPatchForSnapshot(
    snapshot: SessionCapabilitiesSnapshot,
    controls: SessionControlPatch,
    noticeMessageId: string | null,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    try {
      validateSessionControls(snapshot, controls);
      return { ok: true };
    } catch (err) {
      const reason = formatControlFailure(err);
      await this.notifyControlValidationFailure(noticeMessageId, reason);
      return { ok: false, reason };
    }
  }

  private async resolveSessionCapabilitiesForControlValidation(
    chatId: string,
    threadId: string | null,
    before: SessionRecord | null,
    noticeMessageId: string | null,
  ): Promise<SessionCapabilitiesSnapshot | null> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      if (noticeMessageId) {
        await this.presenter.replyNoticeCard(
          noticeMessageId,
          buildProfileCommandFailureNotice(
            "⚠️ Session 设置失败",
            "当前 chat 没有可用 repo。请先 /bind <路径>，或配置默认 / reception cwd。",
          ),
        );
      }
      return null;
    }
    const effectiveBinding: EffectiveBinding = before
      ? {
          cwd: before.cwd,
          command: before.agentCommand,
          args: before.agentArgs,
          ...(before.agentEnv ? { env: before.agentEnv } : {}),
          label: before.agentLabel ?? before.agentCommand,
          explicit: binding.explicit,
          reception: false,
        }
      : binding;
    try {
      const result = await probeAgentSessionCapabilities({
        command: effectiveBinding.command,
        args: [...effectiveBinding.args],
        cwd: effectiveBinding.cwd,
        ...(effectiveBinding.env ? { env: { ...effectiveBinding.env } } : {}),
        logger: this.logger,
      });
      return buildProbeCapabilitiesSnapshot(chatId, threadId, effectiveBinding, result);
    } catch (err) {
      if (noticeMessageId) {
        await this.controlAgentProbeFailed(
          chatId,
          threadId,
          {
            label: effectiveBinding.label,
            command: effectiveBinding.command,
            args: [...effectiveBinding.args],
            cwd: effectiveBinding.cwd,
          },
          formatBootstrapError(err),
          noticeMessageId,
        );
      }
      return null;
    }
  }

  private async notifyControlValidationFailure(
    noticeMessageId: string | null,
    reason: string,
  ): Promise<void> {
    if (!noticeMessageId) return;
    await this.presenter
      .replyNoticeCard(noticeMessageId, {
        title: "⚠️ Session 设置失败",
        body: [
          "Session control 设置失败，当前 runtime 和 sessions.json 未更新。",
          "",
          reason,
          "",
          "请先用 /model、/mode 或 /capabilities 查询可用项，再使用有效的 modelId / modeId / config 值。",
        ].join("\n"),
        template: "red",
      })
      .catch((err) => this.logger.warn({ err }, "control validation failure notice failed"));
  }

  private async controlSetPendingTask(
    chatId: string,
    threadId: string | null,
    task: PendingSessionTask,
  ): Promise<{ readonly queued: true; readonly promptLength: number }> {
    const prompt = task.prompt.trim();
    if (!prompt) throw new Error("pending task prompt must not be empty");
    const record = await this.sessionStore.setPendingTask(
      { chatId, threadId },
      { prompt, createdAt: task.createdAt },
    );
    this.logger.info(
      { chatId, threadId, sessionId: record.sessionId, promptLength: prompt.length },
      "pending task queued",
    );
    return { queued: true, promptLength: prompt.length };
  }

  private async controlSetPendingTargetProfile(
    chatId: string,
    threadId: string | null,
    profile: PendingTargetProfile,
    noticeMessageId?: string | null,
  ): Promise<{ readonly queued: true; readonly agent: string; readonly hasTask: boolean }> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (!runtime?.processing) {
      const record = pendingTargetProfileToSessionRecord(chatId, threadId, profile);
      const pendingTask = profile.task;
      await this.applyAgentSwitchNow(
        record,
        await this.sessionStore.getLatest(chatId, threadId),
        null,
        noticeMessageId ?? null,
        pendingTask,
      );
      if (this.globalDefaultControlChatIds.includes(chatId)) {
        await this.persistGlobalDefaultPendingTargetProfile(profile, noticeMessageId ?? null);
      }
      return {
        queued: true,
        agent: record.agentLabel ?? record.agentCommand,
        hasTask: pendingTask !== undefined,
      };
    }

    const baseRecord = pendingTargetProfileToSessionRecord(chatId, threadId, profile);
    const validation = profile.controls
      ? await this.validateControlPatchForStoredProfile(
          chatId,
          threadId,
          baseRecord,
          profile.controls,
          noticeMessageId ?? runtime.lastMessageId,
        )
      : { ok: true as const };
    if (!validation.ok) throw new Error(validation.reason);

    const previous = await this.sessionStore.getLatest(chatId, threadId);
    const saved = await this.sessionStore.setPendingTargetProfile(
      { chatId, threadId },
      {
        ...profile,
        ...(profile.task ? { task: { ...profile.task, prompt: profile.task.prompt.trim() } } : {}),
      },
    );
    const replyTo = noticeMessageId ?? runtime.lastMessageId ?? chatId;
    const queuedNoticeMessageId = await this.presenter
      .replyNoticeCard(
        replyTo,
        buildPendingTargetProfileQueuedNotice(previous, baseRecord, saved.pendingTargetProfile),
      )
      .catch((err) => {
        this.logger.warn({ err, chatId, threadId }, "pending target profile notice failed");
        return null;
      });
    this.pendingPostTurnAgentSwitches.set(runtimeKey(chatId, threadId), {
      record: baseRecord,
      noticeMessageId: noticeMessageId ?? runtime.lastMessageId ?? null,
      targetProfile: profile,
      queuedNoticeMessageId,
    });
    if (this.globalDefaultControlChatIds.includes(chatId)) {
      await this.persistGlobalDefaultPendingTargetProfile(
        profile,
        noticeMessageId ?? runtime.lastMessageId ?? null,
      );
    }
    return {
      queued: true,
      agent: baseRecord.agentLabel ?? baseRecord.agentCommand,
      hasTask: profile.task !== undefined,
    };
  }

  private async controlAgentProbeFailed(
    chatId: string,
    threadId: string | null,
    agent: AgentProbeFailureTarget,
    error: string,
    noticeMessageId?: string | null,
  ): Promise<{ readonly notified: true }> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    const replyTo = noticeMessageId ?? runtime?.lastMessageId ?? null;
    const notice = buildAgentProbeFailedNotice(agent, error);
    if (replyTo) {
      await this.presenter
        .replyNoticeCard(replyTo, notice)
        .catch((err) => this.logger.warn({ err }, "agent probe failure notice failed"));
    } else {
      await this.presenter
        .sendNoticeCard(chatId, notice)
        .catch((err) => this.logger.warn({ err }, "agent probe failure notice failed"));
    }
    return { notified: true };
  }

  private async controlSetAgent(
    record: SessionRecord,
    noticeMessageId?: string | null,
  ): Promise<
    | { readonly switched: true; readonly agent: string }
    | { readonly queued: true; readonly agent: string }
  > {
    const key = runtimeKey(record.chatId, record.threadId);
    const runtime = this.chats.get(key);
    const replyTo = noticeMessageId ?? runtime?.lastMessageId ?? null;
    const previous = await this.sessionStore.getLatest(record.chatId, record.threadId);

    const inherited = await this.findRecentAgentSessionProfile(record);
    const nextRecord: SessionRecord = inherited?.controls
      ? { ...record, controls: inherited.controls }
      : record;

    if (runtime?.processing) {
      this.pendingPostTurnAgentSwitches.set(key, { record: nextRecord, noticeMessageId: replyTo });
      if (replyTo) {
        await this.presenter
          .replyNoticeCard(
            replyTo,
            buildPendingAgentSwitchQueuedNotice(nextRecord, previous, inherited),
          )
          .catch((err) => this.logger.warn({ err }, "pending agent switch notice failed"));
      }
      return { queued: true, agent: record.agentLabel ?? record.agentCommand };
    }

    await this.applyAgentSwitchNow(nextRecord, previous, inherited, replyTo);
    return { switched: true, agent: record.agentLabel ?? record.agentCommand };
  }

  private async applyAgentSwitchNow(
    record: SessionRecord,
    previous: SessionRecord | null,
    inherited: SessionRecord | null,
    replyTo: string | null,
    pendingTask?: PendingSessionTask,
    noticeKind: "agent-switch" | "pending-target-profile" = "agent-switch",
    updateNoticeMessageId?: string | null,
  ): Promise<void> {
    const key = runtimeKey(record.chatId, record.threadId);
    const runtime = this.chats.get(key);

    if (runtime) {
      await runtime.supersede();
      this.chats.delete(key);
    }

    await this.sessionStore.clearThread(record.chatId, record.threadId);
    await this.sessionStore.save(record);

    const notice =
      noticeKind === "pending-target-profile"
        ? buildPendingTargetProfileAppliedNotice(record, previous, pendingTask)
        : buildSessionAgentSwitchedNotice(record, previous, inherited, pendingTask);
    if (updateNoticeMessageId && this.presenter.updateNoticeCard) {
      const updated = await this.presenter.updateNoticeCard(updateNoticeMessageId, notice);
      if (!updated) {
        await this.sendAgentSwitchNotice(record.chatId, replyTo, notice);
      }
    } else {
      await this.sendAgentSwitchNotice(record.chatId, replyTo, notice);
    }

    if (pendingTask) await this.enqueueTaskForSwitchedAgent(record, pendingTask, replyTo);
  }

  private async sendAgentSwitchNotice(
    chatId: string,
    replyTo: string | null,
    notice: NoticeCardSpec,
  ): Promise<void> {
    if (replyTo) {
      await this.presenter
        .replyNoticeCard(replyTo, notice)
        .catch((err) => this.logger.warn({ err }, "session agent switch notice failed"));
    } else {
      await this.presenter
        .sendNoticeCard(chatId, notice)
        .catch((err) => this.logger.warn({ err }, "session agent switch notice failed"));
    }
  }

  private async handleRuntimeTurnComplete(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const key = runtimeKey(chatId, threadId);
    const pending = this.pendingPostTurnAgentSwitches.get(key);
    const previous = await this.sessionStore.getLatest(chatId, threadId);
    const storedTarget = previous?.pendingTargetProfile;
    if (!pending && !storedTarget) return;
    this.pendingPostTurnAgentSwitches.delete(key);

    const targetProfile = pending?.targetProfile ?? storedTarget;
    const targetRecord =
      pending?.record ?? pendingTargetProfileToSessionRecord(chatId, threadId, targetProfile!);
    const pendingTask = targetProfile?.task ?? previous?.pendingTask;
    await this.applyAgentSwitchNow(
      targetRecord,
      previous,
      pending?.record.controls ? await this.findRecentAgentSessionProfile(pending.record) : null,
      pending?.noticeMessageId ?? messageId,
      pendingTask,
      targetProfile ? "pending-target-profile" : "agent-switch",
      pending?.queuedNoticeMessageId ?? null,
    );
  }

  private async enqueueTaskForSwitchedAgent(
    record: SessionRecord,
    task: PendingSessionTask,
    messageId: string | null,
  ): Promise<void> {
    const runtime = await this.acquireRuntime(record.chatId, record.threadId, {
      cwd: record.cwd,
      command: record.agentCommand,
      args: record.agentArgs,
      ...(record.agentEnv ? { env: record.agentEnv } : {}),
      label: record.agentLabel ?? record.agentCommand,
      explicit: true,
      reception: false,
      ...(record.controls ? { inheritedControls: record.controls } : {}),
    });
    await runtime.enqueue({
      prompt: [
        { type: "text", text: task.prompt },
        { type: "text", text: POST_TURN_AGENT_SWITCH_TASK_HINT },
      ],
      messageId: messageId ?? record.chatId,
      chatId: record.chatId,
    });
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
        const notice = buildSessionBindRejectedNotice(record);
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
      await runtime.supersede();
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

    this.routeMessage(event, userId, messageId, chatId, threadId).catch((err) => {
      this.logger.error({ err, chatId, threadId }, "routeMessage failed");
      this.presenter
        .replyNoticeCard(messageId, buildRouteFailureNotice(err))
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "route failure notice failed"));
    });
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
    const commandContext: CommandContext = { isDirectMessage: !isGroup };

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

    // Inbound middleware pipeline. Each middleware can fully handle the message
    // and short-circuit routing; only messages that fall through are forwarded
    // to the Agent as prompts.
    if (
      await this.runSlashCommandMiddleware(interpreted, chatId, threadId, messageId, commandContext)
    )
      return;

    switch (interpreted.kind) {
      case "empty":
        return;
      case "prompt":
        await this.enqueueWithContext(
          event,
          chatId,
          threadId,
          userId,
          messageId,
          interpreted.segments,
        );
        return;
      case "command":
        throw new Error("slash command middleware declined a parsed command");
      default:
        return assertNever(interpreted);
    }
  }

  private async runSlashCommandMiddleware(
    interpreted: InterpretedMessage,
    chatId: string,
    threadId: string | null,
    messageId: string,
    context: CommandContext = { isDirectMessage: false },
  ): Promise<boolean> {
    if (interpreted.kind !== "command") return false;
    await this.dispatchSlashCommand(interpreted.command, chatId, threadId, messageId, context);
    return true;
  }

  /** Backward-compatible private entrypoint used by integration tests. */
  private async handleCommand(
    command: LarkCommand,
    chatId: string,
    threadId: string | null,
    messageId: string,
    context: CommandContext = { isDirectMessage: false },
  ): Promise<void> {
    await this.dispatchSlashCommand(command, chatId, threadId, messageId, context);
  }

  private async dispatchSlashCommand(
    command: LarkCommand,
    chatId: string,
    threadId: string | null,
    messageId: string,
    context: CommandContext,
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
        await this.teardownThread(chatId, threadId);
        await this.clearThreadSessions(chatId, threadId);
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.new);
        return;
      }
      case "help":
        await this.presenter.replyCommandResultCard(messageId, buildHelpNotice());
        return;
      case "capabilities":
        await this.handleCapabilitiesCommand(command.agent, chatId, threadId, messageId);
        return;
      case "bind":
        await this.handleBind(command.cwd, command.agent, chatId, messageId);
        return;
      case "bind-usage":
        await this.presenter.replyCommandResultCard(messageId, BIND_USAGE_NOTICE);
        return;
      case "unbind":
        await this.handleUnbind(chatId, messageId);
        return;
      case "where":
        await this.handleWhere(chatId, messageId);
        return;
      case "set-agent":
        await this.handleSetAgentCommand(command.agent, chatId, threadId, messageId, context);
        return;
      case "list-agents":
        await this.presenter.replyCommandResultCard(
          messageId,
          buildAgentListNotice(this.availableAgents),
        );
        return;
      case "set-model":
        await this.handleSetControlsCommand(
          modelCommandToPatch(command.model),
          chatId,
          threadId,
          messageId,
          context,
        );
        return;
      case "list-models":
        await this.handleListModelsCommand(chatId, threadId, messageId);
        return;
      case "set-mode":
        await this.handleSetControlsCommand(
          { modeId: command.mode },
          chatId,
          threadId,
          messageId,
          context,
        );
        return;
      case "list-modes":
        await this.handleListModesCommand(chatId, threadId, messageId);
        return;
      case "set-permission":
        await this.handleSetControlsCommand(
          { bridgePermissionMode: command.permissionMode },
          chatId,
          threadId,
          messageId,
          context,
        );
        return;
      case "list-permissions":
        await this.presenter.replyCommandResultCard(
          messageId,
          buildPermissionListNotice(this.display.permissionMode),
        );
        return;
      case "profile":
        await this.handleProfileCommand(chatId, threadId, messageId);
        return;
      case "profile-command-usage":
        await this.presenter.replyCommandResultCard(
          messageId,
          buildProfileCommandUsageNotice(command.command),
        );
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
    let cwd: string;
    try {
      cwd = this.resolveBindTarget(rawCwd, rawAgent);
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
      cwd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.bindingStore.set(binding);
    this.bindingSnapshots.set(chatId, bindingSnapshotOf(binding));

    // A rebind changes repo; tear down the live runtime and drop any persisted
    // ACP sessions so the next message starts fresh in the new cwd instead of
    // resuming a session that belongs to the old repo.
    await this.teardownChat(chatId);
    await this.clearChatSessions(chatId);

    this.logger.info({ chatId, cwd }, "chat bound");
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
    await this.teardownChat(chatId);
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
    if (binding.fallbackFrom) {
      await this.notifyUnavailableBindingFallback(messageId, binding.fallbackFrom);
      return;
    }
    const source = binding.explicit ? "显式绑定" : "默认配置（未显式绑定）";
    await this.presenter.replyNoticeCard(messageId, {
      title: "📍 当前绑定",
      body: `• 目录：${binding.cwd}\n• Agent：${binding.label}\n• 来源：${source}`,
      template: "blue",
    });
  }

  private async handleSetControlsCommand(
    controls: SessionControlPatch,
    chatId: string,
    threadId: string | null,
    messageId: string,
    context: CommandContext = { isDirectMessage: false },
  ): Promise<void> {
    const result = await this.controlSetControls(chatId, threadId, controls, messageId);
    if (!result.rejected && this.shouldPersistGlobalDefaults(chatId, context)) {
      await this.persistGlobalDefaultControls(controls, messageId);
    }
  }

  private async handleListModelsCommand(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const snapshot = await this.resolveSessionCapabilitiesForListing(chatId, threadId, messageId);
    if (!snapshot) return;
    await this.presenter.replyCommandResultCard(messageId, buildModelListNotice(snapshot));
  }

  private async handleListModesCommand(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const snapshot = await this.resolveSessionCapabilitiesForListing(chatId, threadId, messageId);
    if (!snapshot) return;
    await this.presenter.replyCommandResultCard(messageId, buildModeListNotice(snapshot));
  }

  private async handleCapabilitiesCommand(
    agent: string | null,
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const snapshot = agent
      ? await this.probeCapabilitiesForAgent(agent, chatId, threadId, messageId)
      : await this.resolveSessionCapabilitiesForListing(chatId, threadId, messageId);
    if (!snapshot) return;
    await this.presenter.replyCommandResultCard(
      messageId,
      buildCapabilitiesNotice(snapshot, agent),
    );
  }

  private async probeCapabilitiesForAgent(
    selection: string,
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<SessionCapabilitiesSnapshot | null> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildProfileCommandFailureNotice(
          "⚠️ 无法查询 capabilities",
          "当前 chat 没有可用 repo。请先 /bind <路径>，或配置默认 / reception cwd。",
        ),
      );
      return null;
    }

    let target: ResolvedAgentInvocation;
    try {
      target = this.resolver(selection);
    } catch (err) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildProfileCommandFailureNotice(
          "⚠️ 无法查询 capabilities",
          `无法解析目标 Agent：${formatBootstrapError(err)}`,
        ),
      );
      return null;
    }

    const targetBinding: EffectiveBinding = {
      ...binding,
      command: target.command,
      args: target.args,
      ...(target.env ? { env: target.env } : {}),
      label: target.label,
    };
    try {
      const result = await probeAgentSessionCapabilities({
        command: target.command,
        args: [...target.args],
        cwd: binding.cwd,
        ...(target.env ? { env: { ...target.env } } : {}),
        logger: this.logger,
      });
      return buildProbeCapabilitiesSnapshot(chatId, threadId, targetBinding, result);
    } catch (err) {
      await this.controlAgentProbeFailed(
        chatId,
        threadId,
        {
          label: target.label,
          command: target.command,
          args: [...target.args],
          cwd: binding.cwd,
        },
        formatBootstrapError(err),
        messageId,
      );
      return null;
    }
  }

  private async resolveSessionCapabilitiesForListing(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<SessionCapabilitiesSnapshot | null> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (runtime) return runtime.capabilities();

    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildProfileCommandFailureNotice(
          "⚠️ 无法查询 capabilities",
          "当前 chat 没有可用 repo。请先 /bind <路径>，或配置默认 / reception cwd。",
        ),
      );
      return null;
    }
    try {
      const result = await probeAgentSessionCapabilities({
        command: binding.command,
        args: [...binding.args],
        cwd: binding.cwd,
        ...(binding.env ? { env: { ...binding.env } } : {}),
        logger: this.logger,
      });
      return buildProbeCapabilitiesSnapshot(chatId, threadId, binding, result);
    } catch (err) {
      await this.controlAgentProbeFailed(
        chatId,
        threadId,
        {
          label: binding.label,
          command: binding.command,
          args: [...binding.args],
          cwd: binding.cwd,
        },
        formatBootstrapError(err),
        messageId,
      );
      return null;
    }
  }

  private async handleSetAgentCommand(
    selection: string,
    chatId: string,
    threadId: string | null,
    messageId: string,
    context: CommandContext = { isDirectMessage: false },
  ): Promise<void> {
    const binding = await this.resolveBinding(chatId);
    if (!binding) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildProfileCommandFailureNotice(
          "⚠️ Agent 切换失败",
          "当前 chat 没有可用 repo。请先 /bind <路径>，或配置默认 / reception cwd。",
        ),
      );
      return;
    }
    let target: ResolvedAgentInvocation;
    try {
      target = this.resolver(selection);
    } catch (err) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildProfileCommandFailureNotice(
          "⚠️ Agent 切换失败",
          `无法解析目标 Agent：${formatBootstrapError(err)}`,
        ),
      );
      return;
    }
    const persistGlobalDefault = this.shouldPersistGlobalDefaults(chatId, context);
    const previous = await this.sessionStore.getLatest(chatId, threadId);
    if (previous && !previous.profileOnly) {
      await this.requestDestructiveAgentSwitchConfirmation(
        chatId,
        threadId,
        messageId,
        binding,
        target,
        previous,
        persistGlobalDefault,
      );
      return;
    }
    await this.switchAgentAfterProbe(
      chatId,
      threadId,
      messageId,
      binding.cwd,
      target,
      persistGlobalDefault,
    );
  }

  private async requestDestructiveAgentSwitchConfirmation(
    chatId: string,
    threadId: string | null,
    messageId: string,
    binding: EffectiveBinding,
    target: ResolvedAgentInvocation,
    previous: SessionRecord,
    persistGlobalDefault: boolean,
  ): Promise<void> {
    const switchId = randomUUID();
    const warning = buildAgentSwitchWarning(
      switchId,
      chatId,
      threadId,
      binding.cwd,
      previous,
      target,
    );
    const warningCardId = this.presenter.replyAgentSwitchWarningCard
      ? await this.presenter.replyAgentSwitchWarningCard(messageId, warning)
      : null;
    if (!warningCardId) {
      await this.presenter.replyNoticeCard(messageId, {
        title: "⚠️ 切换 Agent 需要确认",
        body: `${warning.body}\n\n当前客户端不支持确认按钮，未执行切换。`,
        template: "orange",
      });
      return;
    }
    this.pendingAgentSwitches.set(switchId, {
      switchId,
      chatId,
      threadId,
      target,
      cwd: binding.cwd,
      warningCardId,
      persistGlobalDefault,
    });
  }

  private async switchAgentAfterProbe(
    chatId: string,
    threadId: string | null,
    noticeMessageId: string | null,
    cwd: string,
    target: ResolvedAgentInvocation,
    persistGlobalDefault = false,
  ): Promise<void> {
    try {
      await probeAgentSessionCapabilities({
        command: target.command,
        args: [...target.args],
        cwd,
        ...(target.env ? { env: { ...target.env } } : {}),
        logger: this.logger,
      });
    } catch (err) {
      await this.controlAgentProbeFailed(
        chatId,
        threadId,
        {
          label: target.label,
          command: target.command,
          args: [...target.args],
          cwd,
        },
        formatBootstrapError(err),
        noticeMessageId,
      );
      return;
    }

    const now = Date.now();
    await this.controlSetAgent(
      {
        chatId,
        threadId,
        sessionId: `profile:${now}`,
        profileOnly: true,
        agentCommand: target.command,
        agentArgs: [...target.args],
        ...(target.env ? { agentEnv: { ...target.env } } : {}),
        agentLabel: target.label,
        cwd,
        createdAt: now,
        updatedAt: now,
      },
      noticeMessageId,
    );
    if (persistGlobalDefault) {
      await this.persistGlobalDefaultAgent(target, noticeMessageId);
    }
  }

  private handleAgentSwitchWarningAction(
    cardMessageId: string | undefined,
    chatId: string,
    threadId: string | null,
    switchId: string,
    action: "confirm" | "cancel",
  ): void {
    this.resolveAgentSwitchWarningAction(cardMessageId, chatId, threadId, switchId, action).catch(
      (err) => this.logger.warn({ err, chatId, threadId, switchId }, "agent switch action failed"),
    );
  }

  private async resolveAgentSwitchWarningAction(
    cardMessageId: string | undefined,
    chatId: string,
    threadId: string | null,
    switchId: string,
    action: "confirm" | "cancel",
  ): Promise<void> {
    const pending = this.pendingAgentSwitches.get(switchId);
    const updateCardId = cardMessageId ?? pending?.warningCardId;
    if (!pending || pending.chatId !== chatId || pending.threadId !== threadId) {
      if (updateCardId && this.presenter.updateAgentSwitchWarningCard) {
        await this.presenter.updateAgentSwitchWarningCard(updateCardId, {
          status: "expired",
          text: "这次 Agent 切换确认已失效，请重新发送 /agent <agent>。",
        });
      }
      return;
    }

    this.pendingAgentSwitches.delete(switchId);
    if (action === "cancel") {
      if (updateCardId && this.presenter.updateAgentSwitchWarningCard) {
        await this.presenter.updateAgentSwitchWarningCard(updateCardId, {
          status: "cancelled",
          text: "已取消 Agent 切换；当前 session 保持不变。",
        });
      }
      return;
    }

    if (updateCardId && this.presenter.updateAgentSwitchWarningCard) {
      await this.presenter.updateAgentSwitchWarningCard(updateCardId, {
        status: "confirmed",
        text: "已确认切换，正在启动目标 Agent 检查可用性。",
      });
    }
    await this.switchAgentAfterProbe(
      chatId,
      threadId,
      updateCardId ?? null,
      pending.cwd,
      pending.target,
      pending.persistGlobalDefault === true,
    );
  }

  private async handleProfileCommand(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));
    if (runtime) {
      await this.presenter.replyNoticeCard(
        messageId,
        buildLiveProfileNotice(runtime.capabilities()),
      );
      return;
    }
    const latest = await this.sessionStore.getLatest(chatId, threadId);
    if (latest) {
      await this.presenter.replyNoticeCard(messageId, buildStoredProfileNotice(latest));
      return;
    }
    const binding = await this.resolveBinding(chatId);
    await this.presenter.replyNoticeCard(messageId, buildNoProfileNotice(binding));
  }

  /**
   * Expand + validate a `/bind` target.
   *
   * @throws {BindError} when the path is missing / not a directory, or the
   *         agent selection cannot be resolved.
   */
  private resolveBindTarget(rawCwd: string, rawAgent: string | null): string {
    if (rawAgent) {
      throw new BindError("/bind 现在只绑定 repo，不再绑定 Agent。请使用 /bind <路径>。");
    }
    return expandAndValidateDir(rawCwd);
  }

  // ----- Prompt routing ---------------------------------------------------

  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    threadId: string | null,
    userId: string,
    messageId: string,
    segments: PromptSegment[],
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
    if (binding.fallbackFrom) {
      await this.notifyUnavailableBindingFallback(messageId, binding.fallbackFrom);
    }

    const progressCardId = await this.presenter
      .sendUnifiedCard(messageId, {
        status: "received",
        entries: [],
        cancellable: false,
        chatId,
        threadId,
      })
      .catch((err) => {
        this.logger.warn({ err, chatId, threadId }, "initial progress card failed");
        return null;
      });

    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const [prompt, userName, chatName] = await Promise.all([
      hydratePrompt(segments, {
        downloader: this.http,
        resourceDownloader: this.http,
        logger: this.logger,
      }),
      this.http.getUserName(userId),
      isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
    ]);

    const context = isGroup
      ? `[上下文: 群聊 "${chatName}" (${chatId}) 中用户 ${userName} (${userId}) 的消息]`
      : `[上下文: 用户 ${userName} (${userId}) 的私聊消息]`;

    // Keep the user's message as the first prompt block. Several ACP agents
    // derive their session title from the first user text; if humming prepends
    // routing metadata, the title becomes "[上下文: 群聊 ...]" instead of the
    // user's actual request. Durable operating instructions live in
    // ~/.humming/AGENTS.md and ~/.humming/CLAUDE.md, so append the lightweight
    // metadata after the user content.
    prompt.push({ type: "text", text: context });
    prompt.push({ type: "text", text: renderInlineControlHint(chatId, threadId) });

    const runtime = await this.acquireRuntime(chatId, threadId, binding);
    const pending: PendingMessage = { prompt, messageId, chatId, progressCardId };
    try {
      await runtime.enqueue(pending);
    } catch (err) {
      // bootstrap (spawn / initialize / newSession / resume) failed — the
      // ChatRuntime never registered itself as active, so drop it and let
      // the next message try again from scratch.
      this.chats.delete(runtimeKey(chatId, threadId));
      this.logger.error({ err, chatId, threadId }, "agent bootstrap failed");
      const summary = `⚠️ Agent 启动失败: ${formatBootstrapError(err)}`;
      if (progressCardId) {
        const updated = await this.presenter.updateUnifiedCard(progressCardId, {
          status: "failed",
          entries: [{ kind: "text", text: summary }],
          cancellable: false,
          chatId,
          threadId,
        });
        if (updated) return;
      }
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
    this.refreshRuntimeDefaultsFromSettings();
    const stored = await this.bindingStore.get(chatId);
    if (stored) {
      const unavailable = describeUnavailableCwd(stored.cwd);
      if (unavailable) {
        const fallback = await this.rebindUnavailableBindingToReception(
          chatId,
          stored,
          unavailable,
        );
        if (fallback) {
          this.logger.warn(
            { chatId, cwd: stored.cwd, reason: unavailable },
            "explicit binding cwd unavailable — rebound to reception area",
          );
          return fallback;
        }
      }
      if (!this.defaultAgent) return null;
      return {
        cwd: stored.cwd,
        command: this.defaultAgent.command,
        args: this.defaultAgent.args,
        ...(this.defaultAgent.env ? { env: this.defaultAgent.env } : {}),
        label: this.defaultAgent.label,
        explicit: true,
        reception: false,
      };
    }
    if (this.defaultCwd && this.defaultAgent) {
      const unavailable = describeUnavailableCwd(this.defaultCwd);
      if (unavailable) {
        const fallback = this.buildReceptionFallback({
          chatId,
          cwd: this.defaultCwd,
          reason: unavailable,
        });
        if (fallback) {
          this.logger.warn(
            { chatId, cwd: this.defaultCwd, reason: unavailable },
            "default cwd unavailable — falling back to reception area",
          );
          return fallback;
        }
      }
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
    return this.buildReceptionBinding();
  }

  private buildReceptionBinding(): EffectiveBinding | null {
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

  private buildReceptionFallback(
    from: Omit<UnavailableBinding, "reboundCwd" | "reboundAgentLabel">,
  ): EffectiveBinding | null {
    const fallback = this.buildReceptionBinding();
    return fallback
      ? {
          ...fallback,
          fallbackFrom: {
            ...from,
            reboundCwd: fallback.cwd,
            reboundAgentLabel: fallback.label,
          },
        }
      : null;
  }

  private async rebindUnavailableBindingToReception(
    chatId: string,
    stored: ChatBinding,
    reason: string,
  ): Promise<EffectiveBinding | null> {
    const fallback = this.buildReceptionBinding();
    if (!fallback) return null;

    const now = Date.now();
    const rebound: ChatBinding = {
      chatId,
      cwd: fallback.cwd,
      createdAt: stored.createdAt,
      updatedAt: now,
    };

    await this.bindingStore.set(rebound);
    this.bindingSnapshots.set(chatId, bindingSnapshotOf(rebound));
    await this.teardownChat(chatId);
    await this.clearChatSessions(chatId).catch((err) =>
      this.logger.warn({ err, chatId }, "failed to clear sessions on unavailable repo rebind"),
    );

    return this.buildReceptionFallback({
      chatId,
      cwd: stored.cwd,
      reason,
    });
  }

  private async notifyUnavailableBindingFallback(
    messageId: string,
    from: UnavailableBinding,
  ): Promise<void> {
    await this.presenter
      .replyNoticeCard(messageId, buildRepoUnavailableRebindNotice(from))
      .catch((err) => this.logger.warn({ err, messageId }, "repo fallback notice failed"));
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

    const { effective, inherited, usesGlobalDefaults } = await this.resolveRuntimeSessionProfile(
      chatId,
      threadId,
      binding,
    );

    if (inherited) {
      this.logger.info(
        {
          chatId,
          threadId,
          inheritedThreadId: inherited.threadId,
          inheritedSessionId: inherited.sessionId,
          cwd: inherited.cwd,
          agent: inherited.agentLabel ?? inherited.agentCommand,
          hasControls: inherited.controls !== undefined,
        },
        "inheriting recent repo session profile",
      );
    }

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
      idleStatusCardMs: this.display.idleStatusCardMs,
      permissionMode: this.display.permissionMode,
      agentLabel: effective.label,
      ...(binding.fallbackFrom ? { ignoreStoredSession: true } : {}),
      ...(effective.inheritedControls ? { inheritedControls: effective.inheritedControls } : {}),
      ...(usesGlobalDefaults ? { persistInheritedControls: true } : {}),
      onTurnComplete: (messageId) => this.handleRuntimeTurnComplete(chatId, threadId, messageId),
      presenter: this.presenter,
      sessionStore: this.sessionStore,
      logger: this.logger,
    });
    this.chats.set(key, runtime);
    return runtime;
  }

  private async resolveRuntimeSessionProfile(
    chatId: string,
    threadId: string | null,
    binding: EffectiveBinding,
  ): Promise<{
    readonly effective: EffectiveBinding;
    readonly inherited: SessionRecord | null;
    readonly usesGlobalDefaults: boolean;
  }> {
    this.refreshRuntimeDefaultsFromSettings();

    if (!binding.fallbackFrom) {
      const pinned = await this.sessionStore.getLatest(chatId, threadId);
      if (pinned) {
        return {
          effective: sessionRecordToEffectiveBinding(pinned, binding.explicit, false),
          inherited: null,
          usesGlobalDefaults: false,
        };
      }

      const inherited = await this.findRecentRepoSessionProfile(chatId, threadId, binding.cwd);
      if (inherited) {
        return {
          effective: sessionRecordToEffectiveBinding(inherited, binding.explicit, true),
          inherited,
          usesGlobalDefaults: false,
        };
      }
    }

    const globalBinding = this.globalDefaultsBinding(binding);
    return { effective: globalBinding, inherited: null, usesGlobalDefaults: true };
  }

  private globalDefaultsBinding(binding: EffectiveBinding): EffectiveBinding {
    if (!binding.profileSelected && this.defaultAgent) {
      return {
        ...binding,
        command: this.defaultAgent.command,
        args: this.defaultAgent.args,
        ...(this.defaultAgent.env ? { env: this.defaultAgent.env } : { env: undefined }),
        label: this.defaultAgent.label,
        profileSelected: true,
        ...(this.defaultControls ? { inheritedControls: this.defaultControls } : {}),
      };
    }
    return this.defaultControls ? { ...binding, inheritedControls: this.defaultControls } : binding;
  }

  private async findRecentRepoSessionProfile(
    chatId: string,
    threadId: string | null,
    cwd: string,
  ): Promise<SessionRecord | null> {
    const sessions = await this.sessionStore.listByChat(chatId);
    const resolvedCwd = path.resolve(cwd);
    for (const session of sessions) {
      if (session.threadId === threadId) continue;
      if (path.resolve(session.cwd) !== resolvedCwd) continue;
      if (!session.agentCommand) continue;
      return session;
    }
    return null;
  }

  private async findRecentAgentSessionProfile(
    target: SessionRecord,
  ): Promise<SessionRecord | null> {
    const sessions = await this.sessionStore.listByChat(target.chatId);
    for (const session of sessions) {
      if (!sameAgentInvocationRecord(session, target)) continue;
      if (!session.controls) continue;
      return session;
    }
    return null;
  }

  /**
   * Compose the agent subprocess env: the binding's own env (if any) plus
   * `HUMMING_CHAT_ID` and `HUMMING_SETTINGS` so the agent knows which chat
   * it serves and where to persist a binding.
   */
  private buildAgentEnv(
    chatId: string,
    threadId: string | null,
    binding: EffectiveBinding,
  ): Record<string, string> | undefined {
    const base: Record<string, string> = { ...(binding.env ?? {}) };
    base["HUMMING_CHAT_ID"] = chatId;
    base["HUMMING_THREAD_ID"] = threadId ?? "";
    if (this.settingsPath) base["HUMMING_SETTINGS"] = this.settingsPath;
    if (this.controlSocketPath) base["HUMMING_CONTROL_SOCKET"] = this.controlSocketPath;
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
      this.logger.warn({ err, homeDir }, "failed to install humming home templates");
    }
  }

  private shouldPersistGlobalDefaults(chatId: string, context: CommandContext): boolean {
    return (
      context.isDirectMessage &&
      this.settingsPath !== null &&
      this.globalDefaultControlChatIds.includes(chatId)
    );
  }

  private async persistGlobalDefaultAgent(
    target: ResolvedAgentInvocation | string,
    messageId: string | null,
  ): Promise<void> {
    const label = typeof target === "string" ? target : target.label;
    await this.mutateSettingsRuntime(
      (runtime) => {
        runtime["agent"] = label;
      },
      messageId,
      "Agent",
    );
  }

  private async persistGlobalDefaultControls(
    controls: SessionControlPatch,
    messageId: string | null,
  ): Promise<void> {
    await this.mutateSettingsRuntime(
      (runtime) => {
        const existingControls = readSettingsControls(runtime["defaultControls"]);
        const nextControls = mergeGlobalDefaultControls(existingControls, controls);
        runtime["defaultControls"] = nextControls;
        if (controls.bridgePermissionMode !== undefined) {
          runtime["permissionMode"] = controls.bridgePermissionMode;
        }
      },
      messageId,
      "Session profile",
    );
  }

  private async persistGlobalDefaultPendingTargetProfile(
    profile: PendingTargetProfile,
    messageId: string | null,
  ): Promise<void> {
    await this.mutateSettingsRuntime(
      (runtime) => {
        runtime["agent"] = profile.agentLabel ?? profile.agentCommand;
        if (profile.controls) {
          const existingControls = readSettingsControls(runtime["defaultControls"]);
          const nextControls = mergeGlobalDefaultControls(existingControls, profile.controls);
          runtime["defaultControls"] = nextControls;
          if (profile.controls.bridgePermissionMode !== undefined) {
            runtime["permissionMode"] = profile.controls.bridgePermissionMode;
          }
        }
      },
      messageId,
      "Pending target profile",
    );
  }

  private async mutateSettingsRuntime(
    mutate: (runtime: Record<string, unknown>) => void,
    messageId: string | null,
    label: string,
  ): Promise<void> {
    if (!this.settingsPath) return;
    try {
      const root = readJsonObjectForSettingsWrite(this.settingsPath);
      const runtime = readObjectFieldForSettingsWrite(root, "runtime");
      mutate(runtime);
      atomicWritePrivateJson(this.settingsPath, { ...root, runtime });
      if (messageId) {
        await this.presenter.replyNoticeCard(messageId, {
          title: "✅ 全局默认已更新",
          body: `${label} 已保存到 settings.json。此变更只因为当前消息来自已配置的 DM 控制台；群聊消息不会写入全局默认。`,
          template: "green",
        });
      }
    } catch (err) {
      this.logger.warn({ err }, "global default settings update failed");
      if (messageId) {
        await this.presenter.replyNoticeCard(messageId, {
          title: "⚠️ 全局默认未更新",
          body: `当前 session 已处理，但写入 settings.json 失败：${formatBootstrapError(err)}`,
          template: "orange",
        });
      }
    }
  }

  private refreshRuntimeDefaultsFromSettings(): void {
    if (!this.settingsPath) return;
    try {
      const root = readJsonObjectForSettingsWrite(this.settingsPath);
      const runtime = readObjectFieldForSettingsWrite(root, "runtime");
      const agentSelection = runtime["agent"];
      if (agentSelection !== undefined) {
        if (typeof agentSelection !== "string" || agentSelection.length === 0) {
          throw new Error("settings file runtime.agent must be a non-empty string");
        }
        this.defaultAgent = this.resolver(agentSelection);
      }
      this.defaultControls = readSettingsControls(runtime["defaultControls"]);
    } catch (err) {
      this.logger.warn({ err }, "failed to refresh runtime defaults from settings.json");
    }
  }

  private sweepInboundResources(): void {
    sweepInboundDir(DEFAULT_INBOUND_DIR).catch((err) =>
      this.logger.warn({ err, inboundDir: DEFAULT_INBOUND_DIR }, "inbound resource sweep failed"),
    );
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
      this.settingsWatcher.on("error", (err) => {
        this.logger.warn({ err, settings: target }, "settings watcher error — hot-reload off");
        this.settingsWatcher?.close();
        this.settingsWatcher = null;
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
      await this.teardownChat(chatId);
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

    if (value.sw && value.swa) {
      this.handleAgentSwitchWarningAction(event.messageId, value.c, threadId, value.sw, value.swa);
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
  private async teardownThread(chatId: string, threadId: string | null): Promise<void> {
    const key = runtimeKey(chatId, threadId);
    const runtime = this.chats.get(key);
    if (!runtime) return;
    await runtime.shutdown("cancelled");
    this.chats.delete(key);
  }

  /**
   * Shut down and forget *every* runtime belonging to a chat — its main
   * conversation and all topic threads. Used by chat-scoped operations
   * (bind / unbind / rebind) that swap the repo out from under every topic.
   */
  private async teardownChat(chatId: string): Promise<void> {
    // Safe to delete during Map iteration: the iterator tolerates removing the
    // current/visited key (only concurrent insertion is problematic).
    for (const [key, runtime] of this.chats) {
      if (runtime.chatId !== chatId) continue;
      await runtime.shutdown("cancelled");
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

  private async evictIdle(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [key, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (now - runtime.lastActivity <= this.idleTimeoutMs) continue;
      this.logger.info(
        { chatId: runtime.chatId, threadId: runtime.threadId },
        "evicting idle chat",
      );
      await runtime.shutdown(null);
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
    runtime?.shutdown(null).catch((err) => this.logger.warn({ err }, "oldest eviction failed"));
    this.chats.delete(oldest.key);
  }

  private async shutdownAllRuntimes(finalStatus: AgentStatus | null): Promise<void> {
    await Promise.all(
      [...this.chats.values()].map((runtime) =>
        runtime
          .shutdown(finalStatus)
          .catch((err) =>
            this.logger.warn(
              { err, chatId: runtime.chatId, threadId: runtime.threadId },
              "runtime shutdown failed",
            ),
          ),
      ),
    );
  }
}

function controlPatchNeedsAgentCapabilities(controls: SessionControlPatch): boolean {
  return (
    controls.modelId !== undefined ||
    controls.modeId !== undefined ||
    Object.keys(controls.config ?? {}).length > 0
  );
}

function mergeStoredControls(
  existing: SessionControls | undefined,
  patch: SessionControlPatch,
): SessionControls {
  const out: SessionControls = { ...(existing ?? {}) };
  if (patch.clearModelId === true) delete out.modelId;
  if (patch.modelId !== undefined) out.modelId = patch.modelId;
  if (patch.modeId !== undefined) out.modeId = patch.modeId;
  if (patch.bridgePermissionMode !== undefined) {
    out.bridgePermissionMode = patch.bridgePermissionMode;
  }
  const config = mergeStoredConfig(existing?.config, patch.config);
  if (config) out.config = config;
  else delete out.config;
  return out;
}

function mergeStoredConfig(
  existing: SessionControls["config"] | undefined,
  patch: SessionControls["config"] | undefined,
): Record<string, NonNullable<SessionControls["config"]>[string]> | undefined {
  const merged: Record<string, NonNullable<SessionControls["config"]>[string]> = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function pendingTargetProfileToSessionRecord(
  chatId: string,
  threadId: string | null,
  profile: PendingTargetProfile,
): SessionRecord {
  return {
    chatId,
    threadId,
    sessionId: profile.sessionId,
    ...(profile.profileOnly !== undefined ? { profileOnly: profile.profileOnly } : {}),
    agentCommand: profile.agentCommand,
    agentArgs: [...profile.agentArgs],
    ...(profile.agentEnv ? { agentEnv: { ...profile.agentEnv } } : {}),
    ...(profile.agentLabel !== undefined ? { agentLabel: profile.agentLabel } : {}),
    cwd: profile.cwd,
    ...(profile.controls ? { controls: profile.controls } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function buildBridgeOnlyValidationSnapshot(
  chatId: string,
  threadId: string | null,
  before: SessionRecord | null,
  controls: SessionControlPatch,
): SessionCapabilitiesSnapshot {
  const modelId = before?.controls?.modelId;
  return {
    session: { chatId, threadId, sessionId: before?.sessionId ?? "profile-validation" },
    agent: {
      command: before?.agentCommand ?? "",
      args: before?.agentArgs ?? [],
      cwd: before?.cwd ?? "",
    },
    ...(controls.clearModelId === true
      ? {
          models: {
            availableModels: modelId ? [{ modelId, name: modelId }] : [],
            currentModelId: modelId,
          },
        }
      : {}),
    bridgePermissionModes: ["alwaysAllow", "alwaysDeny", "alwaysAsk"],
    bridgePermissionMode: before?.controls?.bridgePermissionMode ?? "alwaysAsk",
  };
}

function renderInlineControlHint(chatId: string, threadId: string | null): string {
  return `[humming: 若用户要求绑定/改绑仓库、把当前 topic 绑定到已有 agent session，或切换当前 session 的 agent/model/mode/config/permission control，请先阅读 ~/.humming/AGENTS.md（或 CLAUDE.md）中的 humming 指引；本会话 chatId=${chatId}, threadId=${threadId ?? "<main>"}。如果同一句话同时包含 Agent/Model/Mode/Permission/Config 控制和真实任务，优先一次性登记 pending target profile（Agent + controls + task），不要拆成 set-agent/set-control/queue-task 多张卡，也不要让用户重复。注意：只有 Humming 配置里的 DM 控制台直聊会把这些 profile 控制写入 settings.json 全局默认；群聊/topic 中的控制只改当前 session。其它请求忽略本提示。]`;
}

function buildRouteFailureNotice(err: unknown): NoticeCardSpec {
  return {
    title: "⚠️ Humming 处理消息失败",
    body: `这条消息没有处理成功，错误已写入 bridge.log。\n\n原因：${formatUserFacingError(err)}`,
    template: "red",
  };
}

function formatUserFacingError(err: unknown): string {
  if (err instanceof Error) return truncateUserFacingError(err.message);
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj["message"] === "string") return truncateUserFacingError(obj["message"]);
  }
  return truncateUserFacingError(String(err));
}

function sameAgentInvocationRecord(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.agentCommand === b.agentCommand &&
    a.agentLabel === b.agentLabel &&
    arrayEqual(a.agentArgs, b.agentArgs) &&
    envEqual(a.agentEnv, b.agentEnv)
  );
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function envEqual(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!arrayEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => left[key] === right[key]);
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
    `• Title：${beforeTitle} → ${title}`,
    `• Agent：${beforeAgent} → ${record.agentLabel ?? record.agentCommand}`,
    `• Repo：${beforeRepo} → ${record.cwd}`,
    `• Mode：${displayControlMode(before?.controls)} → ${displayControlMode(record.controls)}`,
    `• Model：${displayControlModel(before?.controls)} → ${displayControlModel(record.controls)}`,
    `• Permission：${displayControlPermission(before?.controls)} → ${displayControlPermission(record.controls)}`,
    `• Controls：${displayControlConfig(before?.controls)} → ${displayControlConfig(record.controls)}`,
    "",
    `**绑定后**`,
    `• Title：${title}`,
    `• Agent：${record.agentLabel ?? record.agentCommand}`,
    `• Repo：${record.cwd}`,
    `• Mode：${displayControlMode(record.controls)}`,
    `• Model：${displayControlModel(record.controls)}`,
    `• Permission：${displayControlPermission(record.controls)}`,
    `• Controls：${displayControlConfig(record.controls)}`,
  ];
  if (record.sessionUpdatedAt) lines.push(`• Session updated：${record.sessionUpdatedAt}`);
  return {
    title: "✅ 已绑定 session",
    body: lines.join("\n"),
    template: "green",
  };
}

function displayControlMode(controls: SessionControls | undefined): string {
  return controls?.modeId ?? "—";
}

function displayControlModel(controls: SessionControls | undefined): string {
  return controls?.modelId ?? "—";
}

function displayControlPermission(controls: SessionControls | undefined): string {
  const mode = controls?.bridgePermissionMode;
  switch (mode) {
    case "alwaysAsk":
      return "Ask approvals";
    case "alwaysAllow":
      return "Auto approve";
    case "alwaysDeny":
      return "Auto deny";
    case undefined:
      return "—";
    default:
      return mode;
  }
}

function displayControlConfig(controls: SessionControls | undefined): string {
  const config = controls?.config ?? {};
  const entries = Object.entries(config);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${displayControlConfigValue(value)}`).join(" · ");
}

function displayControlConfigValue(value: NonNullable<SessionControls["config"]>[string]): string {
  if ("type" in value && value.type === "boolean") return value.value ? "on" : "off";
  return String(value.value);
}

function buildStoredControlUpdatedNotice(
  before: SessionRecord | null,
  after: SessionRecord,
  changed: SessionControlPatch,
): NoticeCardSpec {
  const lines = [
    "当前 topic 的 session profile 已更新；runtime 未在运行，下一条消息会按新 profile 启动/恢复。",
    "",
    "**修改明细**",
    ...storedControlChangeLines(before?.controls, after.controls, changed),
    "",
    "**当前 profile**",
    `• Agent：${after.agentLabel ?? after.agentCommand}`,
    `• Mode：${displayControlMode(after.controls)}`,
    `• Model：${displayControlModel(after.controls)}`,
    `• Permission：${displayControlPermission(after.controls)}`,
    `• Controls：${displayControlConfig(after.controls)}`,
  ];
  return {
    title: "✅ Session profile 已更新",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildPendingControlQueuedNotice(
  before: SessionRecord | null,
  after: SessionRecord,
  changed: SessionControlPatch,
): NoticeCardSpec {
  const pending = after.pendingControls;
  const lines = [
    "当前 topic 正在处理上一条消息，新的 session profile 已保存为下一轮生效。",
    "",
    "当前任务会继续使用旧 profile；下一次向 agent 发送 prompt 前，Humming 会先应用这些设置，成功后自动清掉 pendingControls。",
    "",
    "**排队修改**",
    ...storedControlChangeLines(before?.pendingControls, pending, changed),
    "",
    "**当前已排队 profile**",
    `• Agent：${after.agentLabel ?? after.agentCommand}`,
    `• Mode：${displayControlMode(pending)}`,
    `• Model：${displayControlModel(pending)}`,
    `• Permission：${displayControlPermission(pending)}`,
    `• Controls：${displayControlConfig(pending)}`,
  ];
  return {
    title: "⏳ Session profile 已排队",
    body: lines.join("\n"),
    template: "blue",
  };
}

function buildPendingAgentSwitchControlQueuedNotice(
  before: SessionRecord,
  after: SessionRecord,
  changed: SessionControlPatch,
): NoticeCardSpec {
  const lines = [
    "检测到当前 topic 已有待生效 Agent 切换；新的 session control 已合并到目标 profile，并基于目标 Agent capabilities 校验。",
    "",
    "当前任务会继续使用旧 profile；当前 turn 结束后，Humming 会切换 Agent 并应用这些目标 profile 设置。",
    "",
    "**排队修改**",
    ...storedControlChangeLines(before.controls, after.controls, changed),
    "",
    "**目标 profile**",
    `• Agent：${after.agentLabel ?? after.agentCommand}`,
    `• Mode：${displayControlMode(after.controls)}`,
    `• Model：${displayControlModel(after.controls)}`,
    `• Permission：${displayControlPermission(after.controls)}`,
    `• Controls：${displayControlConfig(after.controls)}`,
  ];
  return {
    title: "⏳ 目标 Session profile 已更新",
    body: lines.join("\n"),
    template: "blue",
  };
}

function buildPendingTargetProfileQueuedNotice(
  before: SessionRecord | null,
  target: SessionRecord,
  stored: PendingTargetProfile | undefined,
): NoticeCardSpec {
  const taskLine = stored?.task ? "• Task：已保存，将在目标 profile 生效后执行" : "• Task：—";
  const lines = [
    "已保存同一句请求形成的 pending target profile。当前 Agent 这一轮会先正常结束；结束后 Humming 会先应用目标 profile，再把任务交给目标 Agent。",
    "",
    "**当前 profile**",
    `• Agent：${before ? (before.agentLabel ?? before.agentCommand) : "未绑定"}`,
    `• Mode：${displayControlMode(before?.controls)}`,
    `• Model：${displayControlModel(before?.controls)}`,
    `• Permission：${displayControlPermission(before?.controls)}`,
    `• Controls：${displayControlConfig(before?.controls)}`,
    "",
    "**目标 profile**",
    `• Agent：${target.agentLabel ?? target.agentCommand}`,
    `• Repo：${target.cwd}`,
    `• Mode：${displayControlMode(target.controls)}`,
    `• Model：${displayControlModel(target.controls)}`,
    `• Permission：${displayControlPermission(target.controls)}`,
    `• Controls：${displayControlConfig(target.controls)}`,
    taskLine,
    "",
    "**生效顺序**",
    "1. 应用目标 profile",
    "2. 启动 / 切换到目标 Agent",
    "3. 执行已保存的 task",
  ];
  return {
    title: "⏳ Pending target profile 已排队",
    body: lines.join("\n"),
    template: "blue",
  };
}

function storedControlChangeLines(
  before: SessionControlPatch | undefined,
  after: SessionControlPatch | undefined,
  changed: SessionControlPatch,
): string[] {
  const lines: string[] = [];
  if (changed.modeId !== undefined) {
    lines.push(`• Mode：${displayControlMode(before)} → ${displayControlMode(after)}`);
  }
  if (changed.clearModelId === true || changed.modelId !== undefined) {
    lines.push(`• Model：${displayControlModel(before)} → ${displayControlModel(after)}`);
  }
  if (changed.bridgePermissionMode !== undefined) {
    lines.push(
      `• Permission：${displayControlPermission(before)} → ${displayControlPermission(after)}`,
    );
  }
  if (changed.config !== undefined) {
    for (const configId of Object.keys(changed.config)) {
      lines.push(
        `• Control ${configId}：${displayStoredConfigValue(before, configId)} → ${displayStoredConfigValue(after, configId)}`,
      );
    }
  }
  return lines.length > 0 ? lines : ["• 无实际变化"];
}

function displayStoredConfigValue(controls: SessionControls | undefined, configId: string): string {
  const value = controls?.config?.[configId];
  return value ? displayControlConfigValue(value) : "—";
}

function buildAgentProbeFailedNotice(
  agent: AgentProbeFailureTarget,
  error: string,
): NoticeCardSpec {
  const lines = [
    "目标 Agent 启动 / capabilities probe 失败，当前 topic 的 Agent 没有切换。",
    "",
    "**目标 Agent**",
    `• Agent：${agent.label ?? agent.command}`,
    `• Repo：${agent.cwd}`,
    "",
    "**失败原因**",
    error,
    "",
    "请先确认该 Agent 已安装并完成登录/认证，再重新切换。",
  ];
  return {
    title: "⚠️ 目标 Agent 不可用",
    body: lines.join("\n"),
    template: "red",
  };
}

function buildSessionAgentSwitchedNotice(
  record: SessionRecord,
  before?: SessionRecord | null,
  inherited?: SessionRecord | null,
  pendingTask?: PendingSessionTask,
): NoticeCardSpec {
  const beforeAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
  const currentAgent = record.agentLabel ?? record.agentCommand;
  const continuationLine = pendingTask
    ? "已携带同一条用户请求中的任务内容，正在交给新 Agent 继续执行。"
    : "请发送下一条消息开始新的任务。触发切换的纯控制消息不会作为任务发送给新 Agent。";
  const lines = [
    `当前 topic 的 Agent 已切换为 **${currentAgent}**。旧 Agent 的内部对话历史不会自动迁移，内部 session context 没有迁移；后续消息会用新 Agent 创建全新 ACP session。`,
    "",
    continuationLine,
    "",
    "**切换结果**",
    `• Agent：${beforeAgent} → ${currentAgent}`,
    `• Repo：${record.cwd}`,
    `• Mode：${displayControlMode(record.controls)}`,
    `• Model：${displayControlModel(record.controls)}`,
    `• Permission：${displayControlPermission(record.controls)}`,
    `• Controls：${displayControlConfig(record.controls)}`,
  ];
  if (inherited?.controls) {
    lines.push(
      `• Metadata：已从当前 chat 最近的 ${currentAgent} session 继承；未继承历史或 sessionId`,
    );
  }
  return {
    title: "✅ Agent 已切换",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildPendingTargetProfileAppliedNotice(
  record: SessionRecord,
  before: SessionRecord | null,
  pendingTask?: PendingSessionTask,
): NoticeCardSpec {
  const currentAgent = record.agentLabel ?? record.agentCommand;
  const beforeAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
  const beforeControls = before?.controls;
  const afterControls = record.controls;
  const lines = [
    "Pending target profile 已应用。",
    "",
    pendingTask
      ? "正在交给目标 Agent 执行 pending task。"
      : "没有 pending task；下一条消息会使用目标 profile。",
    "",
    "**本次 Profile 更新**",
    `• Agent：${beforeAgent} → ${currentAgent}`,
    `• Repo：${before?.cwd ?? "—"} → ${record.cwd}`,
    `• Mode：${displayControlMode(beforeControls)} → ${displayControlMode(afterControls)}`,
    `• Model：${displayControlModel(beforeControls)} → ${displayControlModel(afterControls)}`,
    `• Permission：${displayControlPermission(beforeControls)} → ${displayControlPermission(afterControls)}`,
    `• Controls：${displayControlConfig(beforeControls)} → ${displayControlConfig(afterControls)}`,
  ];
  return {
    title: "✅ Pending target profile 已生效",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildPendingAgentSwitchQueuedNotice(
  record: SessionRecord,
  before?: SessionRecord | null,
  inherited?: SessionRecord | null,
): NoticeCardSpec {
  const targetAgent = record.agentLabel ?? record.agentCommand;
  const fromAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
  const lines = [
    `已排队切换到 **${targetAgent}**。当前 Agent 这一轮会先正常结束；结束后 Humming 会切换 Agent，再执行已登记的 pending task（如果有）。`,
    "",
    "**排队结果**",
    `• Agent：${fromAgent} → ${targetAgent}`,
    `• Repo：${record.cwd}`,
    "• 时机：当前 turn 结束后立即生效",
  ];
  if (inherited?.controls) {
    lines.push(`• Metadata：将从当前 chat 最近的 ${targetAgent} session 继承 controls`);
  }
  return {
    title: "⏳ Agent 切换已排队",
    body: lines.join("\n"),
    template: "blue",
  };
}

function buildAgentSwitchWarning(
  switchId: string,
  chatId: string,
  threadId: string | null,
  repo: string,
  previous: SessionRecord,
  target: ResolvedAgentInvocation,
): AgentSwitchWarningCardSpec {
  const fromAgent = previous.agentLabel ?? previous.agentCommand;
  const toAgent = target.label;
  const body = [
    `当前 topic 已由 **${fromAgent}** 处理过。确认切换到 **${toAgent}** 后，Humming 会清掉当前 topic 的旧 Agent session binding，并让新 Agent 从全新 session 开始。`,
    "",
    "**会保留**",
    "• 当前 Feishu topic",
    "• 当前 chat/repo 绑定",
    "• topic 里已经可见的历史消息",
    "",
    "**不会保留**",
    "• 当前 Agent 的内部 session context",
    "• 当前 Agent 已读取但未输出的信息",
    "• 当前 Agent 专属的 model/mode/config 状态",
    "• 这条切换消息中的任务内容",
    "",
    "这条切换消息不会作为任务发送给新 Agent。确认切换后，请重新发送你的任务。",
    "",
    "**目标**",
    `• Agent：${toAgent}`,
    `• Repo：${repo}`,
  ];
  return {
    switchId,
    chatId,
    threadId,
    fromAgent,
    toAgent,
    repo,
    body: linesToBody(body),
  };
}

function linesToBody(lines: readonly string[]): string {
  return lines.join("\n");
}

function buildSessionBindRejectedNotice(record: SessionRecord): NoticeCardSpec {
  const title = record.title ?? "Untitled session";
  const lines = [
    "这个 session 已经绑定到另一个 thread，已拒绝本次绑定。",
    "",
    "**冲突明细**",
    `• Title：${title}`,
    `• Agent：${record.agentLabel ?? record.agentCommand}`,
    `• Repo：${record.cwd}`,
    `• 状态：已绑定到其他 thread`,
    "",
    "请先在原 thread 执行 /new 重置，或确认不再需要原 thread 后再重新绑定。",
  ];
  return {
    title: "⚠️ Session 已被绑定",
    body: lines.join("\n"),
    template: "orange",
  };
}

function buildHelpNotice(): NoticeCardSpec {
  return {
    title: "ℹ️ Humming commands",
    body: renderCommandHelpBody(),
    template: "blue",
  };
}

function buildAgentListNotice(agents: readonly AgentListItem[]): NoticeCardSpec {
  const lines =
    agents.length > 0
      ? agents.map(
          (agent) =>
            `• ${agent.id} — ${agent.label}${agent.description ? `：${agent.description}` : ""}`,
        )
      : [
          "• 当前 bridge 没有可展示的 agent registry。仍可使用 /agent <raw-command> 切换到 raw ACP command。",
        ];
  return {
    title: "🤖 可用 Agents",
    body: [
      "使用 `/agent <agent>` 切换当前 topic 的 Agent。切换前会先 probe，失败不改状态。",
      "",
      ...lines,
    ].join("\n"),
    template: "blue",
  };
}

function buildModelListNotice(snapshot: SessionCapabilitiesSnapshot): NoticeCardSpec {
  const current = snapshot.models?.currentModelId ?? "auto/default";
  const lines = formatModelCapabilityLines(snapshot);
  return {
    title: "🧠 可用 Models",
    body: [
      `Agent：${displaySnapshotAgent(snapshot)}`,
      `Repo：${snapshot.agent.cwd}`,
      `当前 Model：${current}`,
      "",
      ...lines,
      "",
      "使用 `/model <model-id>` 设置；使用 `/model auto` 清除显式 model override。",
    ].join("\n"),
    template: "blue",
  };
}

function buildModeListNotice(snapshot: SessionCapabilitiesSnapshot): NoticeCardSpec {
  const modes = snapshot.modes?.availableModes ?? [];
  const current = snapshot.modes?.currentModeId ?? "—";
  const lines =
    modes.length > 0
      ? modes.map(
          (mode) =>
            `• ${mode.id} — ${mode.name}${mode.description ? `：${mode.description}` : ""}${mode.id === snapshot.modes?.currentModeId ? "（当前）" : ""}`,
        )
      : ["• 当前 Agent 没有暴露 ACP mode controls。"];
  return {
    title: "🧭 可用 Modes",
    body: [
      `Agent：${displaySnapshotAgent(snapshot)}`,
      `Repo：${snapshot.agent.cwd}`,
      `当前 Mode：${current}`,
      "",
      ...lines,
      "",
      "使用 `/mode <mode-id>` 设置。",
    ].join("\n"),
    template: "blue",
  };
}

function buildPermissionListNotice(current: PermissionMode): NoticeCardSpec {
  return {
    title: "🛂 可用 Permission modes",
    body: [
      `当前默认策略：${displayControlPermission({ bridgePermissionMode: current })}`,
      "",
      "• alwaysAsk — 每次需要 approval 时询问",
      "• alwaysAllow — 自动批准 Humming permission requests",
      "• alwaysDeny — 自动拒绝 Humming permission requests",
      "",
      "使用 `/permission <mode>` 设置当前 topic 的 bridge-side approval 策略。",
    ].join("\n"),
    template: "blue",
  };
}

function buildCapabilitiesNotice(
  snapshot: SessionCapabilitiesSnapshot,
  requestedAgent: string | null,
): NoticeCardSpec {
  const modelLines = formatModelCapabilityLines(snapshot);
  const modeLines = formatModeCapabilityLines(snapshot);
  const configLines = formatConfigCapabilityLines(snapshot);
  const permissionLines = snapshot.bridgePermissionModes.map(
    (mode) =>
      `• ${mode}${mode === snapshot.bridgePermissionMode ? "（当前）" : ""} — ${displayControlPermission({ bridgePermissionMode: mode })}`,
  );
  const source = requestedAgent ? `probe: /capabilities ${requestedAgent}` : "当前有效 Agent";
  return {
    title: "🧩 Agent capabilities",
    body: [
      `查询范围：${source}`,
      `Agent：${displaySnapshotAgent(snapshot)}`,
      `Repo：${snapshot.agent.cwd}`,
      "",
      "**Models**",
      ...modelLines,
      "",
      "**Modes**",
      ...modeLines,
      "",
      "**Config options**",
      ...configLines,
      "",
      "**Permission modes**",
      ...permissionLines,
      "",
      "设置方式：/model <model-id|auto>、/mode <mode-id>、/permission <mode>。Config controls 暂时通过 `humming sessions set-control` 设置。",
    ].join("\n"),
    template: "blue",
  };
}

function formatModelCapabilityLines(snapshot: SessionCapabilitiesSnapshot): string[] {
  const models = snapshot.models?.availableModels ?? [];
  if (models.length === 0) return ["• 当前 Agent 没有暴露 ACP model controls。"];
  return models.map(
    (model) =>
      `• ${model.modelId} — ${model.name}${model.description ? `：${model.description}` : ""}${model.modelId === snapshot.models?.currentModelId ? "（当前）" : ""}`,
  );
}

function formatModeCapabilityLines(snapshot: SessionCapabilitiesSnapshot): string[] {
  const modes = snapshot.modes?.availableModes ?? [];
  if (modes.length === 0) return ["• 当前 Agent 没有暴露 ACP mode controls。"];
  return modes.map(
    (mode) =>
      `• ${mode.id} — ${mode.name}${mode.description ? `：${mode.description}` : ""}${mode.id === snapshot.modes?.currentModeId ? "（当前）" : ""}`,
  );
}

function formatConfigCapabilityLines(snapshot: SessionCapabilitiesSnapshot): string[] {
  const options = snapshot.configOptions ?? [];
  if (options.length === 0) return ["• 当前 Agent 没有暴露 ACP config controls。"];
  return options.map((option) => {
    const category = option.category ? ` [${option.category}]` : "";
    const description = option.description ? `：${option.description}` : "";
    return `• ${option.id}${category} — ${option.name} (${formatConfigOptionState(option)})${description}`;
  });
}

function formatConfigOptionState(
  option: NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
): string {
  if (option.type === "boolean") return `boolean, 当前 ${option.currentValue ? "on" : "off"}`;
  return `select, 当前 ${option.currentValue}; 可选 ${formatSelectConfigValues(option.options)}`;
}

function formatSelectConfigValues(
  options: Extract<
    NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
    { readonly type: "select" }
  >["options"],
): string {
  return options
    .flatMap((option) => {
      if ("options" in option) {
        return option.options.map((child) => `${child.value}=${child.name}`);
      }
      return `${option.value}=${option.name}`;
    })
    .join(", ");
}

function sessionRecordToEffectiveBinding(
  record: SessionRecord,
  explicit: boolean,
  includeControls: boolean,
): EffectiveBinding {
  return {
    cwd: record.cwd,
    command: record.agentCommand,
    args: record.agentArgs,
    ...(record.agentEnv ? { env: record.agentEnv } : {}),
    label: record.agentLabel ?? record.agentCommand,
    profileSelected: true,
    explicit,
    reception: false,
    ...(includeControls && record.controls ? { inheritedControls: record.controls } : {}),
  };
}

function buildProbeCapabilitiesSnapshot(
  chatId: string,
  threadId: string | null,
  binding: EffectiveBinding,
  result: ProbeAgentSessionCapabilitiesResult,
): SessionCapabilitiesSnapshot {
  return {
    session: { chatId, threadId, sessionId: result.sessionId },
    agent: {
      label: binding.label,
      command: binding.command,
      args: binding.args,
      cwd: binding.cwd,
    },
    ...result.capabilities,
    bridgePermissionModes: ["alwaysAllow", "alwaysDeny", "alwaysAsk"],
    bridgePermissionMode: "alwaysAsk",
  };
}

function modelCommandToPatch(model: string | "auto"): SessionControlPatch {
  return model === "auto" ? { clearModelId: true } : { modelId: model };
}

const SETTINGS_FILE_MODE = 0o600;

function readJsonObjectForSettingsWrite(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings file must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readObjectFieldForSettingsWrite(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`settings file ${key} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function atomicWritePrivateJson(filePath: string, value: Readonly<Record<string, unknown>>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: SETTINGS_FILE_MODE,
  });
  fs.renameSync(tmp, filePath);
}

function readSettingsControls(value: unknown): SessionControls | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings file runtime.defaultControls must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const out: SessionControls = {};
  if (typeof raw["modelId"] === "string") out.modelId = raw["modelId"];
  if (typeof raw["modeId"] === "string") out.modeId = raw["modeId"];
  if (isPermissionMode(raw["bridgePermissionMode"])) {
    out.bridgePermissionMode = raw["bridgePermissionMode"];
  }
  if (raw["config"] && typeof raw["config"] === "object" && !Array.isArray(raw["config"])) {
    out.config = raw["config"] as SessionControls["config"];
  }
  return out;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "alwaysAllow" || value === "alwaysDeny" || value === "alwaysAsk";
}

function mergeGlobalDefaultControls(
  existing: SessionControls | undefined,
  patch: SessionControlPatch,
): SessionControls {
  const out: SessionControls = { ...(existing ?? {}) };
  if (patch.clearModelId === true) delete out.modelId;
  if (patch.modelId !== undefined) out.modelId = patch.modelId;
  if (patch.modeId !== undefined) out.modeId = patch.modeId;
  if (patch.bridgePermissionMode !== undefined)
    out.bridgePermissionMode = patch.bridgePermissionMode;
  const config = { ...(existing?.config ?? {}), ...(patch.config ?? {}) };
  if (Object.keys(config).length > 0) out.config = config;
  else delete out.config;
  return out;
}

function buildProfileCommandUsageNotice(command: string): NoticeCardSpec {
  return {
    title: `ℹ️ 用法：/${command}`,
    body: profileCommandUsage(command),
    template: "blue",
  };
}

function profileCommandUsage(command: string): string {
  switch (command) {
    case "agent":
      return "切换当前 topic 的 Agent：\n/agent <agent>\n\n示例：/agent copilot";
    case "model":
      return "设置当前 topic 的 Model，或清除显式 model override：\n/model <model-id>\n/model auto";
    case "mode":
      return "设置当前 topic 的 Mode：\n/mode <mode-id>";
    case "permission":
      return "设置 Humming approval 策略：\n/permission alwaysAsk\n/permission alwaysAllow\n/permission alwaysDeny";
    default:
      return "可用命令：/agent <agent>、/model <model-id|auto>、/mode <mode-id>、/permission <mode>、/profile";
  }
}

function buildProfileCommandFailureNotice(title: string, body: string): NoticeCardSpec {
  return { title, body, template: "red" };
}

function buildLiveProfileNotice(snapshot: SessionCapabilitiesSnapshot): NoticeCardSpec {
  return {
    title: "📋 当前 Session profile",
    body: [
      "当前 topic 有正在运行的 Agent runtime。",
      "",
      "**当前 profile**",
      `• Agent：${displaySnapshotAgent(snapshot)}`,
      `• Repo：${snapshot.agent.cwd}`,
      `• Mode：${displaySnapshotMode(snapshot)}`,
      `• Model：${displaySnapshotModel(snapshot)}`,
      `• Permission：${displaySnapshotPermission(snapshot)}`,
      `• Controls：${displaySnapshotControls(snapshot)}`,
      `• 状态：live`,
    ].join("\n"),
    template: "blue",
  };
}

function buildStoredProfileNotice(record: SessionRecord): NoticeCardSpec {
  return {
    title: "📋 当前 Session profile",
    body: [
      record.profileOnly
        ? "当前 topic 保存的是 profile-only 记录；下一条消息会创建新的 ACP session。"
        : "当前 topic 有已保存的 ACP session；下一条消息会尝试恢复。",
      "",
      "**当前 profile**",
      `• Agent：${record.agentLabel ?? record.agentCommand}`,
      `• Repo：${record.cwd}`,
      `• Mode：${displayControlMode(record.controls)}`,
      `• Model：${displayControlModel(record.controls)}`,
      `• Permission：${displayControlPermission(record.controls)}`,
      `• Controls：${displayControlConfig(record.controls)}`,
      `• Pending：${displayControlPatch(record.pendingControls)}`,
      `• 状态：${record.profileOnly ? "profile-only" : "stored"}`,
    ].join("\n"),
    template: "blue",
  };
}

function buildNoProfileNotice(binding: EffectiveBinding | null): NoticeCardSpec {
  return {
    title: "📋 当前 Session profile",
    body: [
      "当前 topic 还没有 session profile。",
      "",
      "**默认启动信息**",
      `• Agent：${binding?.label ?? "—"}`,
      `• Repo：${binding?.cwd ?? "—"}`,
      "• Mode：—",
      "• Model：—",
      `• Permission：—`,
      "• Controls：—",
      "• 状态：no session",
    ].join("\n"),
    template: "blue",
  };
}

function displaySnapshotAgent(snapshot: SessionCapabilitiesSnapshot): string {
  return snapshot.agent.label ?? snapshot.agent.command;
}

function displaySnapshotMode(snapshot: SessionCapabilitiesSnapshot): string {
  const modeId = snapshot.modes?.currentModeId;
  if (!modeId) return "—";
  return snapshot.modes?.availableModes.find((mode) => mode.id === modeId)?.name ?? modeId;
}

function displaySnapshotModel(snapshot: SessionCapabilitiesSnapshot): string {
  const modelId = snapshot.models?.currentModelId;
  if (!modelId) return "—";
  return (
    snapshot.models?.availableModels.find((model) => model.modelId === modelId)?.name ?? modelId
  );
}

function displaySnapshotPermission(snapshot: SessionCapabilitiesSnapshot): string {
  return displayControlPermission({ bridgePermissionMode: snapshot.bridgePermissionMode });
}

function displaySnapshotControls(snapshot: SessionCapabilitiesSnapshot): string {
  const options = snapshot.configOptions ?? [];
  if (options.length === 0) return "—";
  return options
    .map((option) => `${option.name}: ${displaySnapshotConfigValue(option)}`)
    .join(" · ");
}

function displaySnapshotConfigValue(
  option: NonNullable<SessionCapabilitiesSnapshot["configOptions"]>[number],
): string {
  if (option.type === "boolean") return option.currentValue ? "on" : "off";
  return option.currentValue;
}

function displayControlPatch(controls: SessionControlPatch | undefined): string {
  if (!controls) return "—";
  const parts: string[] = [];
  if (controls.clearModelId === true) parts.push("Model: auto/default");
  if (controls.modelId !== undefined) parts.push(`Model: ${controls.modelId}`);
  if (controls.modeId !== undefined) parts.push(`Mode: ${controls.modeId}`);
  if (controls.bridgePermissionMode !== undefined) {
    parts.push(`Permission: ${displayControlPermission(controls)}`);
  }
  const config = displayControlConfig(controls);
  if (config !== "—") parts.push(`Controls: ${config}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function bindingSnapshotOf(binding: ChatBinding): BindingSnapshot {
  return { cwd: binding.cwd };
}

function sameBindingSnapshot(
  before: BindingSnapshot | undefined,
  after: BindingSnapshot | undefined,
): boolean {
  return before?.cwd === after?.cwd;
}

function buildRepoBoundNotice(
  before: BindingSnapshot | ChatBinding | null | undefined,
  after: BindingSnapshot | ChatBinding,
): NoticeCardSpec {
  const beforeCwd = before?.cwd ?? "未绑定";
  const changedRepo = before?.cwd !== after.cwd;
  const lines = [
    "本会话已绑定到 repo。",
    "",
    "**修改明细**",
    `• Repo：${beforeCwd} → ${after.cwd}`,
    `• 变更项：${changedRepo ? "repo" : "无实际变化"}`,
    "",
    "**绑定后**",
    `• Repo：${after.cwd}`,
    "",
    "下条消息将在该目录启动 agent；Agent 会从最近 session profile 继承，或使用全局默认 Agent。",
  ];
  return {
    title: "✅ 已绑定 repo",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildRepoUnavailableRebindNotice(from: UnavailableBinding): NoticeCardSpec {
  const lines = [
    "当前绑定的 repo 目录不可用，已自动重新绑定到 Humming home，后续消息会直接在该目录继续，不会重复发送本 warning。",
    "",
    "**不可用绑定**",
    `• Repo：${from.cwd}`,
    `• 原因：${from.reason}`,
    "",
    "**已重新绑定到**",
    `• Repo：${from.reboundCwd}`,
    `• Agent：${from.reboundAgentLabel}`,
    "",
    "如果需要继续原项目，请重新 /bind 到一个仍然存在的 repo。",
  ];
  return {
    title: "⚠️ Repo 不可用，已重新绑定到 Humming home",
    body: lines.join("\n"),
    template: "orange",
  };
}

/** Render the bind-instruction doc dropped into the reception cwd. */
function renderBindInstructions(
  chatId: string,
  settingsPath: string,
  socketPath: string | null,
): string {
  return [
    "# humming — how to bind this chat to a repository",
    "",
    "You are running as a humming agent for a Feishu/Lark chat. This chat is",
    "**not yet bound** to a project directory, so you are running in a reception",
    "area. When the user asks to work on / bind to a specific repository, do the",
    "following:",
    "",
    "1. Determine the absolute path of the repository they mean (ask if unsure).",
    "2. Edit the JSON file at:",
    `   ${settingsPath}`,
    "   Add (or update) an entry under the top-level `bindings` object keyed by",
    "   this chat's id. Preserve all other keys in the file.",
    "",
    "```json",
    "{",
    '  "bindings": {',
    `    "${chatId}": { "cwd": "/absolute/path/to/repo" }`,
    "  }",
    "}",
    "```",
    "",
    `This chat's id is: ${chatId}`,
    "It is also available to agent subprocesses as HUMMING_CHAT_ID; the current",
    "topic/thread id is HUMMING_THREAD_ID (empty for the chat main thread).",
    "The settings file path is HUMMING_SETTINGS.",
    "",
    "After you save the file, humming detects the change and re-routes this chat",
    "to the bound repository automatically — the user's next message will run",
    "there. Tell the user the binding is done and which repo you set. Do not put",
    "an agent in the chat binding: Agent / Model / Mode / Permission / Config",
    "controls belong to the topic/session profile. New topics inherit the most",
    "recent profile from the same chat + repo, or use the global default Agent if",
    "there is no history.",
    "",
    "Do not delete other chats' bindings or other top-level keys (credentials,",
    "runtime, agents).",
    "",
    "For model/mode/config/permission session controls, read ~/.humming/AGENTS.md",
    "or ~/.humming/CLAUDE.md and use the humming control/sessions CLI. Do not",
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
  const unavailable = describeUnavailableCwd(resolved);
  if (unavailable) throw new BindError(unavailable);
  return resolved;
}

function describeUnavailableCwd(cwd: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (err) {
    if (isNodeErrno(err) && err.code === "ENOENT") return `路径不存在：${cwd}`;
    return `无法访问路径：${cwd}`;
  }
  if (!stat.isDirectory()) return `不是目录：${cwd}`;
  return null;
}

function isNodeErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
