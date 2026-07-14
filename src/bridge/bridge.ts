import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import {
  sendLifecycleNotice,
  type LifecycleCodeRevision,
  type LifecycleDefaultProfile,
  type LifecycleNoticeDelivery,
  type LifecycleNoticeKind,
} from "../lark/lifecycle-notifier.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";

import {
  createWipNoticeCard,
  finalizeWipNoticeCard,
  restoreWipNoticeCard,
  updateWipNoticeCard,
  type WipNoticeCardRef,
} from "../presenter/notice-card-lifecycle.js";
import { installHomeTemplates } from "../home-templates.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { renderCommandHelpBody } from "../interpreter/commands.js";
import {
  BridgeControlServer,
  type AgentProbeFailureTarget,
  type ConfigureSessionInput,
} from "./control-server.js";
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
  type PromptSegment,
} from "../interpreter/lark-interpreter.js";
import {
  ChatRuntime,
  formatControlFailure,
  type DrainResult,
  type PendingMessage,
} from "./chat-runtime.js";
import { DEFAULT_INBOUND_DIR, sweepInboundDir } from "./inbound-store.js";
import { hydratePrompt } from "./prompt-hydrator.js";
import type { PermissionMode } from "../acp/humming-client.js";
import type { AcknowledgementPort } from "../conversation/topic-conversation-session.js";
import type { LifecycleIntent, LifecycleTransaction } from "../../bin/lifecycle-coordinator.js";
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
  PendingSessionConfiguration,
  PendingSessionMessage,
  PendingTargetAgent,
  SessionCapabilitiesSnapshot,
  SessionControlPatch,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "../session-store/session-store.js";
import {
  mergePendingSessionConfiguration,
  mergeSessionControls,
  pendingConfigurationHasProfileField,
} from "../session-store/session-controls.js";
import type { BindingStore, ChatBinding } from "../binding-store/binding-store.js";
import {
  readSettingsFileObject,
  readSettingsObjectField,
  writeSettingsFileObject,
} from "../settings-file/settings-file.js";

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHATS = 10;
const DEFAULT_SHOW_THOUGHTS = true;
const DEFAULT_SHOW_TOOLS = true;
const DEFAULT_SHOW_CANCEL_BUTTON = true;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_STATUS_CARD_MS = 15_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
const IDLE_CLEANUP_INTERVAL_MS = 2 * 60_000;
/** Debounce for settings.json change events (fs.watch double-fires). */
const SETTINGS_RELOAD_DEBOUNCE_MS = 300;

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
    "Agent / Model / Mode / Permission / Config 属于会话配置，不属于 chat binding。新 topic 会继承当前 repo 最近的会话配置；没有历史 session 时使用全局默认配置。",
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
  /** Action schema version. */
  v?: unknown;
  /** Prompt lifecycle token (v2 only). */
  p?: string;
  /** Segment lifecycle token (v2 Cancel only). */
  s?: string;
  /** One-shot action token (v2 Cancel only). */
  a?: string;
  /** Permission lifecycle token (v2 permission only). */
  q?: string;
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

interface StrictCancelV2 {
  readonly v: 2;
  readonly c: string;
  readonly th?: string;
  readonly cancel: true;
  readonly p: string;
  readonly s: string;
  readonly a: string;
}

interface StrictPermissionV2 {
  readonly v: 2;
  readonly c: string;
  readonly th?: string;
  readonly p: string;
  readonly q: string;
  readonly r: string;
  readonly o: string;
}

function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isStrictCancelV2(value: CardActionPayload): value is StrictCancelV2 {
  return (
    hasExactKeys(value, ["v", "c", "cancel", "p", "s", "a"], ["th"]) &&
    value.v === 2 &&
    value.cancel === true &&
    typeof value.c === "string" &&
    typeof value.p === "string" &&
    typeof value.s === "string" &&
    typeof value.a === "string" &&
    (value.th === undefined || typeof value.th === "string")
  );
}

function isStrictPermissionV2(value: CardActionPayload): value is StrictPermissionV2 {
  return (
    hasExactKeys(value, ["v", "c", "p", "q", "r", "o"], ["th"]) &&
    value.v === 2 &&
    typeof value.c === "string" &&
    typeof value.p === "string" &&
    typeof value.q === "string" &&
    typeof value.r === "string" &&
    typeof value.o === "string" &&
    (value.th === undefined || typeof value.th === "string")
  );
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
   * status card that the next visible event can reuse. 0 disables. Default 15s.
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
  /** Effective global defaults shown on successful start/restart notices. */
  defaultProfile?: LifecycleDefaultProfile;
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

  /** Ask the foreground CLI to stop this bridge after replying to a local control request. */
  onShutdownRequested?: () => void;

  /** Ask the foreground CLI to exit for supervisor-driven restart. */
  onRestartRequested?: () => void;

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

/** Which trigger is applying a topic's persisted Pending Configuration (spec §9.5). */
type PendingConfigurationApplyTrigger = "idle" | "turn-boundary" | "recovery";

/**
 * Whether {@link LarkBridge.acquireRuntime} runs restart recovery of a
 * persisted Pending Configuration before building a runtime.
 *
 * - `recover-on-acquire`: ordinary path (message ingress, the applier's own
 *   nested acquisition). Recovery runs unless the applier is already mid-flight
 *   for this key ({@link LarkBridge.pendingConfigurationApplyInFlight}).
 * - `pending-observed-under-lock`: the caller already holds
 *   {@link LarkBridge.withPendingConfigurationLock} and read the (absent)
 *   Pending Configuration under it, so recovery would only deadlock on that
 *   lock. Distinct from `pendingConfigurationApplyInFlight`, which means "the
 *   applier is running", not "the lock is held".
 */
type RuntimeAcquisitionRecovery = "recover-on-acquire" | "pending-observed-under-lock";

/** Outcome of applying a topic's persisted Pending Configuration. */
interface PendingConfigurationApplyResult {
  /** `false` when there was nothing to apply (no pending config, or quiescing). */
  readonly applied: boolean;
  /** Present when a target Agent switch was applied. */
  readonly agent?: string;
  readonly messageSent: boolean;
}

interface CommandContext {
  readonly isDirectMessage: boolean;
}

export type BridgeLifecycleState =
  | { readonly kind: "running" }
  | {
      readonly kind: "quiescing";
      readonly intent: LifecycleIntent;
      readonly transactionId: string;
    }
  | {
      readonly kind: "readyToExit";
      readonly intent: LifecycleIntent;
      readonly transactionId: string;
      readonly drains: readonly DrainResult[];
    };

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
  private readonly onShutdownRequested: (() => void) | undefined;
  private readonly onRestartRequested: (() => void) | undefined;
  private readonly globalDefaultControlChatIds: readonly string[];
  private readonly lark: LarkBridgeLarkOptions;
  private readonly lifecycleNotificationChatIds: readonly string[];
  private readonly restartMarkerPath: string | null;
  private readonly lifecycleCodeRevision: LifecycleCodeRevision | undefined;
  private readonly lifecycleDefaultProfile: LifecycleDefaultProfile | undefined;
  private readonly lifecycleNoticeTimeoutMs: number | undefined;

  private readonly acknowledgement: AcknowledgementPort;

  private readonly chats = new Map<string, ChatRuntime>();
  private readonly pendingAgentSwitches = new Map<string, PendingAgentSwitch>();
  /**
   * Serializes each chat/thread's `configureSession`/`sendMessage`
   * merge-validate-persist so concurrent requests cannot race the read of the
   * current Pending Configuration (spec §9.3). The persisted
   * `SessionRecord.pendingConfiguration` — not this map — is the source of truth.
   */
  private readonly pendingConfigurationLocks = new Map<string, Promise<unknown>>();
  /**
   * Chat/thread keys whose Pending Configuration the canonical applier is
   * currently applying. Delivering its attached Message can re-enter
   * `acquireRuntime` (and `handleRuntimeTurnComplete`) for the same key; both
   * skip while the key is marked here, so the Message is never re-applied and
   * recovery does not loop. Means "the applier is mid-flight", not "the lock is
   * held" — lock-held callers use {@link RuntimeAcquisitionRecovery} instead.
   */
  private readonly pendingConfigurationApplyInFlight = new Set<string>();
  private readonly promptIngress = new Map<string, Promise<void>>();
  private readonly runtimeTurnCompletions = new Set<Promise<void>>();
  private lifecycleState: BridgeLifecycleState = { kind: "running" };
  private lifecyclePromise: Promise<{
    readonly accepted: true;
    readonly transactionId: string;
    readonly readyToExit: true;
  }> | null = null;
  private lifecycleTransaction: LifecycleTransaction | null = null;
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
      opts.presenter ??
      new LarkCardPresenter({
        http: this.http,
        logger: this.logger,
      });

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
    this.onShutdownRequested = opts.onShutdownRequested;
    this.onRestartRequested = opts.onRestartRequested;
    this.globalDefaultControlChatIds = opts.globalDefaultControlChatIds ?? [];
    this.lifecycleNotificationChatIds = opts.lifecycle?.notificationChatIds ?? [];
    this.restartMarkerPath = opts.lifecycle?.restartMarkerPath ?? null;
    this.lifecycleCodeRevision = opts.lifecycle?.codeRevision;
    this.lifecycleDefaultProfile = opts.lifecycle?.defaultProfile;
    this.lifecycleNoticeTimeoutMs = opts.lifecycle?.noticeTimeoutMs;
    this.acknowledgement = {
      add: async (messageId) => {
        try {
          return await this.http.addMessageReaction(messageId, "OnIt");
        } catch (err) {
          this.logger.debug({ err }, "prompt acknowledgement reaction failed");
          return null;
        }
      },
      remove: async (messageId, reactionId) => {
        try {
          await this.http.removeMessageReaction(messageId, reactionId);
          return true;
        } catch (err) {
          this.logger.debug({ err }, "prompt acknowledgement removal failed");
          return false;
        }
      },
    };
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
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.settingsWatcher) {
      this.settingsWatcher.close();
      this.settingsWatcher = null;
    }
    // If beginLifecycle already drained runtimes and emitted its terminal old-process
    // notice, stop() only releases process resources. Compatibility signal/control
    // shutdowns still use the legacy best-effort drain and notice path.
    if (this.lifecycleState.kind === "quiescing") {
      await this.lifecyclePromise;
      this.chats.clear();
    } else if (this.lifecycleState.kind === "running") {
      await this.shutdownAllRuntimes("cancelled");
      this.chats.clear();
      await this.sendLifecycleTerminalNotice();
    } else {
      this.chats.clear();
    }
    await this.controlServer?.stop();
    this.controlServer = null;
    await this.sessionStore.close();
    await this.bindingStore.close();
    this.logger.info("bridge stopped");
  }

  private async sendLifecycleStartedNotice(): Promise<void> {
    const restart = this.consumeRestartMarker();
    await this.sendLifecycleNotice(restart ? "restarted" : "started", restart?.deliveries);
  }

  private async sendLifecycleTerminalNotice(intent?: LifecycleIntent): Promise<void> {
    const restarting = intent === "restart" || (intent === undefined && this.hasRestartMarker());
    const deliveries = await this.sendLifecycleNotice(restarting ? "restarting" : "stopped");
    if (restarting) this.persistRestartNoticeDeliveries(deliveries);
  }

  private beginLifecycle(transaction: LifecycleTransaction): Promise<{
    readonly accepted: true;
    readonly transactionId: string;
    readonly readyToExit: true;
  }> {
    if (this.lifecycleState.kind !== "running") {
      if (
        this.lifecycleTransaction === null ||
        !isDeepStrictEqual(this.lifecycleTransaction, transaction)
      ) {
        return Promise.reject(
          new Error(`lifecycle transaction ${this.lifecycleState.transactionId} is already active`),
        );
      }
      return (
        this.lifecyclePromise ??
        Promise.resolve({
          accepted: true,
          transactionId: transaction.id,
          readyToExit: true,
        })
      );
    }

    // Quiesce synchronously before the first await so ingress cannot pass the gate.
    this.lifecycleTransaction = transaction;
    this.lifecycleState = {
      kind: "quiescing",
      intent: transaction.intent,
      transactionId: transaction.id,
    };
    const runtimes = [...this.chats.values()];
    const turnCompletions = [...this.runtimeTurnCompletions];
    this.lifecyclePromise = (async () => {
      await Promise.allSettled(turnCompletions);
      const settled = await Promise.allSettled(
        runtimes.map((runtime) => runtime.drain(transaction.intent)),
      );
      const drains = settled.map((result, index): DrainResult => {
        if (result.status === "fulfilled") return result.value;
        const runtime = runtimes[index];
        this.logger.warn(
          { err: result.reason, chatId: runtime?.chatId, threadId: runtime?.threadId },
          "runtime drain failed",
        );
        return {
          intent: transaction.intent,
          outcome: "escalated",
          cancel: "rejected",
          persisted: false,
          agentClose: "timed-out",
        };
      });
      await this.sendLifecycleTerminalNotice(transaction.intent);
      this.lifecycleState = {
        kind: "readyToExit",
        intent: transaction.intent,
        transactionId: transaction.id,
        drains,
      };
      return { accepted: true, transactionId: transaction.id, readyToExit: true } as const;
    })();
    return this.lifecyclePromise;
  }

  private async sendLifecycleNotice(
    kind: LifecycleNoticeKind,
    replace?: readonly LifecycleNoticeDelivery[],
  ): Promise<readonly LifecycleNoticeDelivery[]> {
    return sendLifecycleNotice({
      http: this.http,
      chatIds: this.lifecycleNotificationChatIds,
      kind,
      logger: this.logger,
      ...(replace !== undefined ? { replace } : {}),
      ...(this.lifecycleCodeRevision !== undefined
        ? { codeRevision: this.lifecycleCodeRevision }
        : {}),
      ...(this.lifecycleDefaultProfile !== undefined
        ? { defaultProfile: this.lifecycleDefaultProfile }
        : {}),
      ...(this.lifecycleNoticeTimeoutMs !== undefined
        ? { timeoutMs: this.lifecycleNoticeTimeoutMs }
        : {}),
    });
  }

  private hasRestartMarker(): boolean {
    return this.restartMarkerPath !== null && fs.existsSync(this.restartMarkerPath);
  }

  private persistRestartNoticeDeliveries(deliveries: readonly LifecycleNoticeDelivery[]): void {
    const marker = this.restartMarkerPath;
    if (marker === null) return;
    try {
      fs.writeFileSync(marker, JSON.stringify({ requestedAt: Date.now(), deliveries }), "utf-8");
    } catch (err) {
      this.logger.warn({ err, marker }, "failed to persist restart notice card ids");
    }
  }

  private consumeRestartMarker(): {
    readonly deliveries: readonly LifecycleNoticeDelivery[];
  } | null {
    const marker = this.restartMarkerPath;
    if (marker === null || !fs.existsSync(marker)) return null;
    let deliveries: readonly LifecycleNoticeDelivery[] = [];
    try {
      deliveries = parseRestartNoticeDeliveries(fs.readFileSync(marker, "utf-8"));
    } catch (err) {
      this.logger.warn({ err, marker }, "failed to parse restart marker");
    }
    try {
      fs.unlinkSync(marker);
    } catch (err) {
      this.logger.warn({ err, marker }, "failed to remove restart marker");
    }
    return { deliveries };
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
        beginLifecycle: (transaction) => this.beginLifecycle(transaction),
        shutdown: async () => {
          if (!this.onShutdownRequested) throw new Error("bridge shutdown is unavailable");
          this.onShutdownRequested();
          return { accepted: true };
        },
        restart: async () => {
          if (!this.onRestartRequested) throw new Error("bridge restart is unavailable");
          this.onRestartRequested();
          return { accepted: true };
        },

        capabilities: (chatId, threadId) => this.controlCapabilities(chatId, threadId),
        configureSession: async (chatId, threadId, input, noticeMessageId) => {
          const result = await this.controlConfigureSession(
            chatId,
            threadId,
            input,
            noticeMessageId,
          );
          if (!("rejected" in result) && this.globalDefaultControlChatIds.includes(chatId)) {
            if (input.targetAgent) {
              await this.persistGlobalDefaultAgent(
                input.targetAgent.agentLabel ?? input.targetAgent.agentCommand,
                null,
              );
            }
            if (input.controls) await this.persistGlobalDefaultControls(input.controls, null);
          }
          return result;
        },
        sendMessage: (chatId, threadId, message, noticeMessageId) =>
          this.controlSendMessage(chatId, threadId, message, noticeMessageId),
        bindSession: (record, noticeMessageId) => this.controlBindSession(record, noticeMessageId),
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

  /**
   * Merge a desired target Agent / controls / message into the chat/thread's
   * single Pending Configuration, validate the complete candidate against the
   * resolved Desired Agent, and either apply it now (idle) or queue it for
   * the next Turn boundary (busy). See docs/cli-command-model-SPEC.md §9.
   *
   * @throws never — failures are reported via the returned `rejected` result.
   */
  private async controlConfigureSession(
    chatId: string,
    threadId: string | null,
    input: ConfigureSessionInput,
    noticeMessageId?: string | null,
  ): Promise<
    | { readonly applied: true; readonly agent?: string; readonly messageSent: boolean }
    | { readonly queued: true; readonly agent?: string }
    | { readonly rejected: true; readonly reason: string }
  > {
    return this.withPendingConfigurationLock(chatId, threadId, async () => {
      const key = runtimeKey(chatId, threadId);
      const before = await this.sessionStore.getLatest(chatId, threadId);
      const existingPending = before?.pendingConfiguration;
      const runtime = this.chats.get(key);
      const replyTo = noticeMessageId ?? runtime?.lastMessageId ?? null;

      const trimmedMessage = input.message
        ? { prompt: input.message.prompt.trim(), createdAt: input.message.createdAt }
        : undefined;
      if (trimmedMessage && trimmedMessage.prompt.length === 0) {
        return { rejected: true, reason: "message prompt must not be empty" };
      }

      const merged = mergePendingSessionConfiguration(existingPending, {
        ...(input.targetAgent ? { targetAgent: input.targetAgent } : {}),
        ...(input.controls ? { controls: input.controls } : {}),
        ...(trimmedMessage ? { message: trimmedMessage } : {}),
      });

      if (!pendingConfigurationHasProfileField(merged)) {
        return {
          rejected: true,
          reason:
            "configure requires at least one of Agent, Model, Mode, Permission, or Config; use sendMessage for a message-only request",
        };
      }

      if (runtime?.processing) {
        return this.queuePendingConfiguration(chatId, threadId, before, merged, replyTo);
      }

      // Idle: persist the merged candidate as the single source of truth, then
      // apply it through the canonical applier (which re-reads the persisted
      // snapshot, not this local object). A brand-new topic with a target Agent
      // has no Session to attach it to, so first persist a profile-only carrier
      // derived from that target Agent.
      try {
        if (merged.targetAgent && !before) {
          await this.sessionStore.save({
            ...pendingTargetAgentToSessionRecord(chatId, threadId, merged.targetAgent),
            profileOnly: true,
            pendingConfiguration: merged,
          });
        } else {
          await this.sessionStore.setPendingConfiguration({ chatId, threadId }, merged);
        }
        const outcome = await this.applyPersistedPendingConfiguration(
          chatId,
          threadId,
          replyTo,
          "idle",
        );
        return {
          applied: true,
          ...(outcome.agent !== undefined ? { agent: outcome.agent } : {}),
          messageSent: outcome.messageSent,
        };
      } catch (err) {
        return { rejected: true, reason: formatControlFailure(err) };
      }
    });
  }

  /**
   * Send a Message to the current Topic Session without changing its
   * configuration (spec §10). Must not overtake an existing Pending
   * Configuration — if one exists (or this chat/thread is busy), the Message
   * is merged into / queued alongside it instead of sent directly.
   */
  private async controlSendMessage(
    chatId: string,
    threadId: string | null,
    message: PendingSessionMessage,
    noticeMessageId?: string | null,
  ): Promise<{ readonly sent: true } | { readonly queued: true }> {
    const prompt = message.prompt.trim();
    if (!prompt) throw new Error("message prompt must not be empty");
    return this.withPendingConfigurationLock(chatId, threadId, async () => {
      const key = runtimeKey(chatId, threadId);
      const before = await this.sessionStore.getLatest(chatId, threadId);
      const existingPending = before?.pendingConfiguration;
      const runtime = this.chats.get(key);
      const replyTo = noticeMessageId ?? runtime?.lastMessageId ?? null;

      if (existingPending) {
        const candidate: PendingSessionConfiguration = {
          ...existingPending,
          message: { prompt, createdAt: message.createdAt },
          updatedAt: Date.now(),
        };
        await this.sessionStore.setPendingConfiguration({ chatId, threadId }, candidate);
        return { queued: true };
      }

      if (runtime?.processing) {
        const candidate: PendingSessionConfiguration = {
          message: { prompt, createdAt: message.createdAt },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await this.sessionStore.setPendingConfiguration({ chatId, threadId }, candidate);
        return { queued: true };
      }

      // Nothing to recover — we read the absent Pending Configuration under the
      // lock we hold — so tell acquisition to skip the recovery pass, which
      // would otherwise re-enter this same lock and deadlock.
      const targetRuntime =
        runtime ??
        (await this.acquireRuntimeForSend(chatId, replyTo, before, "pending-observed-under-lock"));
      if (!targetRuntime) return { queued: true };
      await this.enqueueRuntimeMessage(targetRuntime, chatId, threadId, {
        prompt: [{ type: "text", text: prompt }],
        messageId: replyTo ?? chatId,
        chatId,
      });
      return { sent: true };
    });
  }

  private async acquireRuntimeForSend(
    chatId: string,
    replyTo: string | null,
    before: SessionRecord | null,
    recovery: RuntimeAcquisitionRecovery = "recover-on-acquire",
  ): Promise<ChatRuntime | null> {
    const threadId = before?.threadId ?? null;
    const binding = before
      ? sessionRecordToEffectiveBinding(before, true, true)
      : await this.resolveBinding(chatId);
    if (!binding) {
      if (replyTo) {
        await this.presenter
          .replyNoticeCard(
            replyTo,
            buildProfileCommandFailureNotice(
              "⚠️ 发送失败",
              "当前 chat 没有可用 repo/session。请先 /bind <路径> 或 session configure --agent。",
            ),
          )
          .catch((err) => this.logger.warn({ err, chatId }, "send message failure notice failed"));
      }
      return null;
    }
    return this.acquireRuntime(chatId, threadId, binding, recovery);
  }

  /** Runs `fn` serialized per chat/thread key; see {@link pendingConfigurationLocks}. */
  private async withPendingConfigurationLock<T>(
    chatId: string,
    threadId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = runtimeKey(chatId, threadId);
    const prior = this.pendingConfigurationLocks.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(fn);
    this.pendingConfigurationLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async queuePendingConfiguration(
    chatId: string,
    threadId: string | null,
    before: SessionRecord | null,
    candidate: PendingSessionConfiguration,
    replyTo: string | null,
  ): Promise<{ readonly queued: true; readonly agent?: string }> {
    const notice = buildPendingConfigurationQueuedNotice(before, candidate);
    let noticeMessageId = candidate.noticeMessageId;
    const existingCard = noticeMessageId ? restoreWipNoticeCard(noticeMessageId) : null;
    if (existingCard) {
      await updateWipNoticeCard(this.presenter, existingCard, notice).catch((err) =>
        this.logger.warn(
          { err, chatId, threadId },
          "pending configuration queue notice update failed",
        ),
      );
    } else if (replyTo) {
      const created = await createWipNoticeCard(this.presenter, replyTo, notice).catch((err) => {
        this.logger.warn({ err, chatId, threadId }, "pending configuration queue notice failed");
        return null;
      });
      if (created) noticeMessageId = created.messageId;
    }
    const toPersist: PendingSessionConfiguration = {
      ...candidate,
      ...(noticeMessageId ? { noticeMessageId } : {}),
    };
    const saved = await this.sessionStore.setPendingConfiguration({ chatId, threadId }, toPersist);
    const targetAgent = saved.pendingConfiguration?.targetAgent;
    const agent = targetAgent ? (targetAgent.agentLabel ?? targetAgent.agentCommand) : undefined;
    return { queued: true, ...(agent !== undefined ? { agent } : {}) };
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
    const targetAgent: PendingTargetAgent = {
      sessionId: record.sessionId,
      ...(record.profileOnly !== undefined ? { profileOnly: record.profileOnly } : {}),
      agentCommand: record.agentCommand,
      agentArgs: record.agentArgs,
      ...(record.agentEnv ? { agentEnv: record.agentEnv } : {}),
      ...(record.agentLabel !== undefined ? { agentLabel: record.agentLabel } : {}),
      cwd: record.cwd,
    };
    const result = await this.controlConfigureSession(
      record.chatId,
      record.threadId,
      { targetAgent },
      noticeMessageId,
    );
    if ("rejected" in result) throw new Error(result.reason);
    const agent = record.agentLabel ?? record.agentCommand;
    if ("applied" in result) return { switched: true, agent };
    return { queued: true, agent };
  }

  /**
   * Apply an Agent switch (target profile becoming the current session), for
   * an idle immediate switch or a queued one at the Turn boundary / restart
   * recovery: tear down any live runtime, replace the persisted session,
   * deliver the attached Message, and finalize the outcome notice.
   *
   * `rollback` and `previous` are deliberately separate: `rollback` is the
   * record physically restored on failure; `previous` is the prior Session
   * shown in the notice. For a brand-new topic's profile-only carrier (spec
   * §9.3) `rollback` is the carrier — restoring it re-arms its Pending
   * Configuration for retry — while `previous` is null so the notice does not
   * read as a same-Agent self-switch.
   *
   * The persisted switch and Message delivery are one ordered operation (spec
   * §9.5, §9.6): on failure the session is rolled back to `rollback` (which
   * also restores its Pending Configuration) before the error propagates, so
   * the Message is never reported sent.
   *
   * @throws when the switch or Message delivery fails, after `rollback` is
   *         restored; the caller surfaces the failure notice and leaves the
   *         Pending Configuration in place.
   */
  private async applyAgentSwitchNow(
    record: SessionRecord,
    previous: SessionRecord | null,
    rollback: SessionRecord | null,
    inherited: SessionRecord | null,
    replyTo: string | null,
    message?: PendingSessionMessage,
    queuedNotice?: WipNoticeCardRef | null,
  ): Promise<void> {
    const key = runtimeKey(record.chatId, record.threadId);
    const runtime = this.chats.get(key);

    if (runtime) {
      await runtime.supersede();
      this.chats.delete(key);
    }

    await this.sessionStore.clearThread(record.chatId, record.threadId);
    await this.sessionStore.save(record);

    if (message) {
      try {
        await this.enqueueMessageForSession(record, message, replyTo);
      } catch (err) {
        await this.restorePreviousSessionAfterFailedSwitch(record, rollback);
        throw err;
      }
    }

    const notice = buildSessionAgentSwitchedNotice(record, previous, inherited, message);
    await this.finalizeOrSendNotice(record.chatId, replyTo, queuedNotice ?? null, notice);
  }

  /**
   * Restore `rollback` as the current Session after a failed switch (spec
   * §9.6), verbatim — which also restores whatever Pending Configuration it
   * carried for retry.
   */
  private async restorePreviousSessionAfterFailedSwitch(
    failed: SessionRecord,
    rollback: SessionRecord | null,
  ): Promise<void> {
    await this.sessionStore.clearThread(failed.chatId, failed.threadId);
    if (rollback) await this.sessionStore.save(rollback);
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

  /** Finalize a "queued" WIP notice card in place, or send a fresh notice when none was queued. */
  private async finalizeOrSendNotice(
    chatId: string,
    replyTo: string | null,
    queuedNotice: WipNoticeCardRef | null,
    notice: NoticeCardSpec,
  ): Promise<void> {
    if (queuedNotice) {
      await finalizeWipNoticeCard(this.presenter, queuedNotice, notice, async () => {
        await this.sendAgentSwitchNotice(chatId, replyTo, notice);
      });
    } else {
      await this.sendAgentSwitchNotice(chatId, replyTo, notice);
    }
  }

  /**
   * Apply a controls/message-only Pending Configuration (no Agent switch):
   * controls first, then the attached Message (spec §9.5). Idle application
   * reports through the live runtime's own notice; Turn-boundary/recovery
   * bypasses the busy guard and the Bridge owns the notice. A controls failure
   * must not send the Message, and Message-delivery failure fails the whole
   * application — the caller only clears the Pending Configuration on success.
   *
   * @returns whether the attached Message was delivered.
   * @throws when applying controls or delivering the Message fails.
   */
  private async applyPendingControlsAndMessage(
    chatId: string,
    threadId: string | null,
    before: SessionRecord,
    configuration: PendingSessionConfiguration,
    replyTo: string | null,
    queuedNotice: WipNoticeCardRef | null,
    trigger: PendingConfigurationApplyTrigger,
  ): Promise<boolean> {
    const runtime = this.chats.get(runtimeKey(chatId, threadId));

    if (configuration.controls) {
      if (runtime && trigger === "idle") {
        await runtime.applyControls(configuration.controls, replyTo ?? undefined);
      } else if (runtime) {
        const beforeSnapshot = runtime.capabilities();
        await runtime.applyControlsAtTurnBoundary(configuration.controls);
        const afterSnapshot = runtime.capabilities();
        const notice = buildPendingControlsAppliedNotice(
          beforeSnapshot,
          afterSnapshot,
          configuration.controls,
        );
        await this.finalizeOrSendNotice(chatId, replyTo, queuedNotice, notice);
      } else {
        const record = await this.sessionStore.setControls(
          { chatId, threadId },
          configuration.controls,
        );
        const notice = buildStoredControlUpdatedNotice(before, record, configuration.controls);
        await this.finalizeOrSendNotice(chatId, replyTo, queuedNotice, notice);
      }
    }

    if (!configuration.message) return false;
    const targetRuntime = runtime ?? (await this.acquireRuntimeForSend(chatId, replyTo, before));
    if (!targetRuntime) {
      throw new Error("no repo/session available to deliver the pending message");
    }
    await this.enqueueRuntimeMessage(targetRuntime, chatId, threadId, {
      prompt: [{ type: "text", text: configuration.message.prompt }],
      messageId: replyTo ?? chatId,
      chatId,
    });
    return true;
  }

  /**
   * Turn-boundary trigger (spec §9.5): apply any persisted Pending
   * Configuration the just-completed Turn left behind. A nested completion
   * fired while that application delivers its own Message is skipped via
   * {@link pendingConfigurationApplyInFlight}.
   */
  private async handleRuntimeTurnComplete(
    chatId: string,
    threadId: string | null,
    messageId: string,
  ): Promise<void> {
    if (this.lifecycleState.kind !== "running") return;
    if (this.pendingConfigurationApplyInFlight.has(runtimeKey(chatId, threadId))) return;
    await this.withPendingConfigurationLock(chatId, threadId, () =>
      this.applyPersistedPendingConfiguration(chatId, threadId, messageId, "turn-boundary"),
    );
  }

  /**
   * Canonical read -> apply -> conditional-clear for a topic's persisted
   * Pending Configuration, shared by idle configure, the Turn-boundary
   * consumer, and restart recovery. The persisted store — not a caller object
   * — is the single source of truth (spec §9.3), so this also recovers after a
   * Bridge restart. Callers must already hold
   * {@link withPendingConfigurationLock}.
   *
   * Order is target profile -> controls -> Message (spec §9.5); the Pending
   * Configuration is cleared only on full success, and only conditionally so a
   * newer request written meanwhile is never clobbered (spec §9.3). On failure
   * it is left in place for retry; Turn-boundary/recovery surface a failure
   * notice while idle propagates a `rejected` result. The key is marked in
   * {@link pendingConfigurationApplyInFlight} while applying so the attached
   * Message's nested `acquireRuntime` does not re-enter recovery and loop.
   *
   * @throws when applying the target profile, controls, or Message fails.
   */
  private async applyPersistedPendingConfiguration(
    chatId: string,
    threadId: string | null,
    replyTo: string | null,
    trigger: PendingConfigurationApplyTrigger,
  ): Promise<PendingConfigurationApplyResult> {
    const before = await this.sessionStore.getLatest(chatId, threadId);
    const configuration = before?.pendingConfiguration;
    if (!before || !configuration) return { applied: false, messageSent: false };
    if (trigger === "turn-boundary" && this.lifecycleState.kind !== "running") {
      return { applied: false, messageSent: false };
    }

    const key = runtimeKey(chatId, threadId);
    const queuedNotice = configuration.noticeMessageId
      ? restoreWipNoticeCard(configuration.noticeMessageId)
      : null;

    this.pendingConfigurationApplyInFlight.add(key);
    try {
      const targetAgent = configuration.targetAgent;
      if (targetAgent) {
        const { record, inherited } = await this.resolveTargetAgentApplyRecord(
          chatId,
          threadId,
          targetAgent,
          configuration.controls,
        );
        if (trigger === "turn-boundary" && this.lifecycleState.kind !== "running") {
          return { applied: false, messageSent: false };
        }
        // Carrier (profile-only, same sessionId as its target): the switch is
        // "from no previous Session", so previous=null, but rollback stays the
        // carrier to re-arm its Pending Configuration. See applyAgentSwitchNow.
        const fromCarrier =
          before.profileOnly === true && before.sessionId === targetAgent.sessionId;
        const previous = fromCarrier ? null : before;
        await this.applyAgentSwitchNow(
          record,
          previous,
          before,
          inherited,
          replyTo,
          configuration.message,
          queuedNotice,
        );
        return {
          applied: true,
          agent: record.agentLabel ?? record.agentCommand,
          messageSent: configuration.message !== undefined,
        };
      }

      const messageSent = await this.applyPendingControlsAndMessage(
        chatId,
        threadId,
        before,
        configuration,
        replyTo,
        queuedNotice,
        trigger,
      );
      await this.sessionStore.clearPendingConfigurationIfMatches(
        { chatId, threadId },
        configuration,
      );
      return { applied: true, messageSent };
    } catch (err) {
      if (trigger !== "idle") {
        await this.reportPendingConfigurationFailure(chatId, replyTo, queuedNotice, err, trigger);
      }
      throw err;
    } finally {
      this.pendingConfigurationApplyInFlight.delete(key);
    }
  }

  /**
   * Resolve the target Session record (and any inherited controls) for a
   * target-Agent switch: an explicit control patch wins; otherwise the most
   * recent same-Agent Session's controls are inherited (spec §9.5).
   */
  private async resolveTargetAgentApplyRecord(
    chatId: string,
    threadId: string | null,
    targetAgent: PendingTargetAgent,
    explicitControls: SessionControlPatch | undefined,
  ): Promise<{ readonly record: SessionRecord; readonly inherited: SessionRecord | null }> {
    const targetRecordBase = pendingTargetAgentToSessionRecord(chatId, threadId, targetAgent);
    const inherited =
      explicitControls === undefined
        ? await this.findRecentAgentSessionProfile(targetRecordBase)
        : null;
    const controls = explicitControls ?? inherited?.controls;
    const record: SessionRecord = { ...targetRecordBase, ...(controls ? { controls } : {}) };
    return { record, inherited };
  }

  /**
   * Surface a failed Pending Configuration application (spec §9.6). The
   * Pending Configuration remains persisted for retry; the caller rethrows so
   * a new Message cannot overtake it during restart recovery.
   */
  private async reportPendingConfigurationFailure(
    chatId: string,
    replyTo: string | null,
    queuedNotice: WipNoticeCardRef | null,
    err: unknown,
    mode: "turn-boundary" | "recovery",
  ): Promise<void> {
    const failure = buildPendingAgentSwitchFailedNotice(err);
    await this.finalizeOrSendNotice(chatId, replyTo, queuedNotice, failure);
    if (mode === "recovery") {
      this.logger.warn({ err, chatId }, "pending configuration restart recovery failed");
    }
  }

  /**
   * Restart recovery (spec §9.3): apply a leftover persisted Pending
   * Configuration before building a runtime — exactly when a Bridge restart
   * would otherwise strand it, since the Turn-boundary consumer
   * ({@link handleRuntimeTurnComplete}) only fires for a Turn that now never
   * runs. A failed recovery rejects the triggering acquire so a new Message
   * cannot overtake the still-pending configuration.
   */
  private async recoverPendingConfigurationOnAcquire(
    chatId: string,
    threadId: string | null,
  ): Promise<void> {
    await this.withPendingConfigurationLock(chatId, threadId, () =>
      this.applyPersistedPendingConfiguration(chatId, threadId, null, "recovery"),
    );
  }

  private async enqueueMessageForSession(
    record: SessionRecord,
    message: PendingSessionMessage,
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
    await this.enqueueRuntimeMessage(runtime, record.chatId, record.threadId, {
      prompt: [
        { type: "text", text: message.prompt },
        { type: "text", text: POST_TURN_AGENT_SWITCH_TASK_HINT },
      ],
      messageId: messageId ?? record.chatId,
      chatId: record.chatId,
    });
  }

  /**
   * Deliver a Message and discard a runtime that failed during lazy Agent
   * bootstrap/resume. Keeping that runtime would let the next Message retry
   * the failed target invocation after persisted Session selection rolled
   * back.
   *
   * @throws when the runtime cannot process the Message.
   */
  private async enqueueRuntimeMessage(
    runtime: ChatRuntime,
    chatId: string,
    threadId: string | null,
    input: Parameters<ChatRuntime["enqueue"]>[0],
  ): Promise<void> {
    try {
      await runtime.enqueue(input);
    } catch (err) {
      const key = runtimeKey(chatId, threadId);
      if (this.chats.get(key) === runtime) this.chats.delete(key);
      throw err;
    }
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

    if (this.lifecycleState.kind !== "running") {
      void this.rejectQuiescingIngress(messageId);
      return;
    }

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
    if (this.lifecycleState.kind !== "running") {
      await this.rejectQuiescingIngress(messageId);
      return;
    }

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

    if (this.lifecycleState.kind !== "running") {
      await this.rejectQuiescingIngress(messageId);
      return;
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
    const result = await this.controlConfigureSession(chatId, threadId, { controls }, messageId);
    if (!("rejected" in result) && this.shouldPersistGlobalDefaults(chatId, context)) {
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

  private enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    threadId: string | null,
    userId: string,
    messageId: string,
    segments: PromptSegment[],
  ): Promise<void> {
    if (this.lifecycleState.kind !== "running") {
      return this.rejectQuiescingIngress(messageId);
    }
    const key = runtimeKey(chatId, threadId);
    const prior = this.promptIngress.get(key) ?? Promise.resolve();
    const start = prior
      .catch(() => undefined)
      .then(() => {
        let admit!: () => void;
        let rejectAdmission!: (error: unknown) => void;
        const admission = new Promise<void>((resolve, reject) => {
          admit = resolve;
          rejectAdmission = reject;
        });
        const completion = this.enqueueWithContextSerial(
          event,
          chatId,
          threadId,
          userId,
          messageId,
          segments,
          admit,
        ).catch((error) => {
          rejectAdmission(error);
          throw error;
        });
        return { admission, completion };
      });
    const barrier = start.then(({ admission }) => admission);
    const tracked = barrier.finally(() => {
      if (this.promptIngress.get(key) === tracked) this.promptIngress.delete(key);
    });
    this.promptIngress.set(key, tracked);
    return start.then(({ completion }) => completion);
  }

  private async enqueueWithContextSerial(
    event: Lark.RawMessageEvent,
    chatId: string,
    threadId: string | null,
    userId: string,
    messageId: string,
    segments: PromptSegment[],
    admit: () => void,
  ): Promise<void> {
    if (this.lifecycleState.kind !== "running") {
      await this.rejectQuiescingIngress(messageId);
      return;
    }
    const binding = await this.resolveBinding(chatId);
    if (this.lifecycleState.kind !== "running") {
      await this.rejectQuiescingIngress(messageId);
      return;
    }
    if (!binding) {
      admit();
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

    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const runtime = await this.acquireRuntime(chatId, threadId, binding);
    if (this.lifecycleState.kind !== "running") {
      await this.rejectQuiescingIngress(messageId);
      return;
    }
    const response = runtime.acceptResponse({ messageId, content: segments, profile: null });
    admit();
    const reaction = this.http.addMessageReaction(messageId, "OnIt").catch((err) => {
      this.logger.debug({ err }, "prompt acknowledgement reaction failed");
      return null;
    });
    let prompt: Awaited<ReturnType<typeof hydratePrompt>>;
    let userName: string;
    let chatName: string;
    try {
      [prompt, userName, chatName] = await Promise.all([
        hydratePrompt(segments, {
          downloader: this.http,
          resourceDownloader: this.http,
          logger: this.logger,
        }),
        this.http.getUserName(userId),
        isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
      ]);
    } catch (err) {
      response.attachAcknowledgement(await reaction);
      runtime.abandonHydration(response.responseId);
      await response.fail("消息内容读取失败，本轮 Response 未能开始。").catch(() => undefined);
      throw err;
    }
    response.attachAcknowledgement(await reaction);
    if (this.lifecycleState.kind !== "running") {
      runtime.abandonHydration(response.responseId);
      await this.rejectQuiescingIngress(messageId);
      return;
    }

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

    const pending: PendingMessage = {
      prompt,
      messageId,
      chatId,
      response,
    };
    try {
      await runtime.enqueue(pending);
    } catch (err) {
      // bootstrap (spawn / initialize / newSession / resume) failed — the
      // ChatRuntime never registered itself as active, so drop it and let
      // the next message try again from scratch.
      const key = runtimeKey(chatId, threadId);
      if (this.chats.get(key) === runtime) this.chats.delete(key);
      this.logger.error({ err, chatId, threadId }, "agent bootstrap failed");
      const summary = `⚠️ Agent 启动失败: ${formatBootstrapError(err)}`;
      await this.presenter
        .replyText(messageId, summary)
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "bootstrap error reply failed"));
    }
  }

  private async rejectQuiescingIngress(messageId: string): Promise<void> {
    await this.presenter
      .replyNoticeCard(messageId, {
        title: "⏸️ Humming 正在停止",
        body: "这条消息未排队。请等待 Humming 完成停止或重启后重新发送。",
        template: "orange",
      })
      .catch((err) =>
        this.logger.warn({ err, messageId }, "quiescing ingress rejection notice failed"),
      );
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
    recovery: RuntimeAcquisitionRecovery = "recover-on-acquire",
  ): Promise<ChatRuntime> {
    if (this.lifecycleState.kind !== "running") {
      throw new Error("bridge lifecycle is quiescing; runtime acquisition rejected");
    }
    const key = runtimeKey(chatId, threadId);
    const existing = this.chats.get(key);
    if (existing) return existing;

    // Run restart recovery before building a runtime, skipping two proven-safe
    // cases: (1) the applier is already mid-flight for this key
    // (`pendingConfigurationApplyInFlight`) and its own Message delivery can
    // call back here; (2) the caller holds `withPendingConfigurationLock` and
    // read the absent Pending Configuration under it, so recovery would only
    // deadlock (`recovery === "pending-observed-under-lock"`).
    if (recovery === "recover-on-acquire" && !this.pendingConfigurationApplyInFlight.has(key)) {
      await this.recoverPendingConfigurationOnAcquire(chatId, threadId);
      // Recovery may have delivered the attached Message via a nested
      // `acquireRuntime` that already built the runtime — reuse it rather than
      // building a second, orphaning one.
      const recovered = this.chats.get(key);
      if (recovered) return recovered;
    }

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

    const { effective, inherited, usesGlobalDefaults } = await this.resolveRuntimeSessionProfile(
      chatId,
      threadId,
      binding,
    );
    if (this.lifecycleState.kind !== "running") {
      throw new Error("bridge lifecycle is quiescing; runtime acquisition rejected");
    }

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
      onTurnComplete: (messageId) => {
        // The Turn-boundary consumer already surfaces its own failure notice
        // (reportPendingConfigurationFailure); consume the rejection here so
        // ChatRuntime does not also send a generic Agent-failure card, while
        // still tracking the completion for lifecycle drain.
        const completion = this.handleRuntimeTurnComplete(chatId, threadId, messageId).catch(
          (err) =>
            this.logger.warn(
              { err, chatId, threadId },
              "pending configuration application failed after turn",
            ),
        );
        this.runtimeTurnCompletions.add(completion);
        void completion.finally(() => this.runtimeTurnCompletions.delete(completion));
        return completion;
      },
      presenter: this.presenter,
      acknowledgement: this.acknowledgement,
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
        const nextControls = mergeSessionControls(existingControls, controls);
        runtime["defaultControls"] = nextControls;
        if (controls.bridgePermissionMode !== undefined) {
          runtime["permissionMode"] = controls.bridgePermissionMode;
        }
      },
      messageId,
      "会话配置",
    );
  }

  private async mutateSettingsRuntime(
    mutate: (runtime: Record<string, unknown>) => void,
    messageId: string | null,
    label: string,
  ): Promise<void> {
    if (!this.settingsPath) return;
    try {
      const root = readSettingsFileObject(this.settingsPath);
      const runtime = readSettingsObjectField(root, "runtime");
      mutate(runtime);
      writeSettingsFileObject(this.settingsPath, { ...root, runtime });
      if (messageId) {
        await this.presenter.replyNoticeCard(messageId, {
          title: "✅ 全局默认配置已更新",
          body: `${label} 已设为全局默认配置。此变更仅适用于已配置的私聊控制台；群聊中的配置变更只作用于当前会话。`,
          template: "green",
        });
      }
    } catch (err) {
      this.logger.warn({ err }, "global default settings update failed");
      if (messageId) {
        await this.presenter.replyNoticeCard(messageId, {
          title: "⚠️ 全局默认配置未更新",
          body: `当前会话配置已更新，但保存全局默认配置时失败：${formatBootstrapError(err)}`,
          template: "orange",
        });
      }
    }
  }

  private refreshRuntimeDefaultsFromSettings(): void {
    if (!this.settingsPath) return;
    try {
      const root = readSettingsFileObject(this.settingsPath);
      const runtime = readSettingsObjectField(root, "runtime");
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
    if (this.lifecycleState.kind !== "running") {
      this.logger.info("card action ignored while bridge is quiescing");
      return;
    }
    const value = event.action.value as CardActionPayload | undefined;
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "v")) {
      if (value.v !== 2) {
        this.logger.info("unsupported versioned card action ignored");
        return;
      }
      if (isStrictCancelV2(value)) {
        this.handleCancelV2(value);
        return;
      }
      if (isStrictPermissionV2(value)) {
        this.handlePermissionV2(value);
        return;
      }
      this.logger.info("malformed versioned card action ignored");
      return;
    }
    if (!value.c) return;

    // Older cards (pre-topic) carry no `th`; `?? null` maps them to the chat's
    // main conversation, matching how those runtimes are keyed.
    const threadId = value.th ?? null;

    if (value.cancel === true) {
      this.logger.info(
        { chatId: value.c, threadId },
        "tokenless legacy cancel ignored; use /cancel or a versioned active card",
      );
      return;
    }

    if (value.sw && value.swa) {
      this.handleAgentSwitchWarningAction(event.messageId, value.c, threadId, value.sw, value.swa);
      return;
    }

    if (value.r && value.o) {
      this.logger.info(
        { chatId: value.c, threadId, requestId: value.r },
        "tokenless legacy permission action ignored",
      );
    }
  }

  private handleCancelV2(value: StrictCancelV2): void {
    const runtime = this.chats.get(runtimeKey(value.c, value.th ?? null));
    if (!runtime) return;
    const result = runtime.consumeCancelAction({
      promptToken: value.p,
      segmentToken: value.s,
      actionToken: value.a,
    });
    this.logger.info({ result }, "v2 cancel action consumed");
  }

  private handlePermissionV2(value: StrictPermissionV2): void {
    const runtime = this.chats.get(runtimeKey(value.c, value.th ?? null));
    if (!runtime) return;
    const result = runtime.consumePermissionAction({
      promptToken: value.p,
      permissionToken: value.q,
      requestId: value.r,
      optionId: value.o,
    });
    this.logger.info({ result }, "v2 permission action consumed");
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

function pendingTargetAgentToSessionRecord(
  chatId: string,
  threadId: string | null,
  target: PendingTargetAgent,
): SessionRecord {
  const now = Date.now();
  return {
    chatId,
    threadId,
    sessionId: target.sessionId,
    ...(target.profileOnly !== undefined ? { profileOnly: target.profileOnly } : {}),
    agentCommand: target.agentCommand,
    agentArgs: [...target.agentArgs],
    ...(target.agentEnv ? { agentEnv: { ...target.agentEnv } } : {}),
    ...(target.agentLabel !== undefined ? { agentLabel: target.agentLabel } : {}),
    cwd: target.cwd,
    createdAt: now,
    updatedAt: now,
  };
}

function renderInlineControlHint(chatId: string, threadId: string | null): string {
  return `[humming: 若用户要求绑定/改绑仓库、把当前 topic 绑定到已有 Agent session，或修改当前会话的 Agent/Model/Mode/Permission/Config，请先阅读 ~/.humming/AGENTS.md（或 CLAUDE.md）中的 Humming 指引；本会话 chatId=${chatId}, threadId=${threadId ?? "<main>"}。如果同一句话同时包含会话配置变更和真实任务，使用一次 session configure 同时提交配置与消息，不要拆成多次操作，也不要让用户重复。注意：只有 Humming 配置的私聊控制台会把这些变更保存为全局默认配置；群聊/topic 中的变更只作用于当前会话。其它请求忽略本提示。]`;
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
    `• Config：${displayControlConfig(before?.controls)} → ${displayControlConfig(record.controls)}`,
    "",
    `**绑定后**`,
    `• Title：${title}`,
    `• Agent：${record.agentLabel ?? record.agentCommand}`,
    `• Repo：${record.cwd}`,
    `• Mode：${displayControlMode(record.controls)}`,
    `• Model：${displayControlModel(record.controls)}`,
    `• Permission：${displayControlPermission(record.controls)}`,
    `• Config：${displayControlConfig(record.controls)}`,
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
    "当前会话配置已更新。下一条消息会使用新配置启动或恢复会话。",
    "",
    "**修改明细**",
    ...storedControlChangeLines(before?.controls, after.controls, changed),
    "",
    "**当前会话配置**",
    `• Agent：${after.agentLabel ?? after.agentCommand}`,
    `• Mode：${displayControlMode(after.controls)}`,
    `• Model：${displayControlModel(after.controls)}`,
    `• Permission：${displayControlPermission(after.controls)}`,
    `• Config：${displayControlConfig(after.controls)}`,
  ];
  return {
    title: "✅ 会话配置已更新",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildPendingConfigurationQueuedNotice(
  before: SessionRecord | null,
  candidate: PendingSessionConfiguration,
): NoticeCardSpec {
  const messageLine = candidate.message
    ? "• 后续消息：已保存，将在配置变更生效后发送"
    : "• 后续消息：—";
  const targetAgent = candidate.targetAgent;

  if (targetAgent) {
    const targetLabel = targetAgent.agentLabel ?? targetAgent.agentCommand;
    const beforeAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
    const lines = [
      `已准备切换到 **${targetLabel}**。当前回复会先正常结束，随后 Humming 将应用完整的配置变更，再发送已保存的后续消息（如果有）。`,
      "",
      "**待应用配置变更**",
      `• Agent：${beforeAgent} → ${targetLabel}`,
      `• Repo：${targetAgent.cwd}`,
      `• Config：${displayControlPatch(candidate.controls)}`,
      messageLine,
      "",
      "**处理顺序**",
      "1. 应用会话配置（启动或切换 Agent，并设置 Model / Mode / Permission / Config）",
      "2. 发送已保存的后续消息",
    ];
    return { title: "⏳ 配置变更将在本轮后生效", body: lines.join("\n"), template: "blue" };
  }

  const lines = [
    "当前会话正在处理上一条消息，配置变更将在本轮结束后生效。",
    "",
    "当前回复继续使用原配置；发送下一条消息前，Humming 会先应用这些变更。",
    "",
    "**待应用配置变更**",
    `• ${displayControlPatch(candidate.controls)}`,
    messageLine,
  ];
  return { title: "⏳ 配置变更将在本轮后生效", body: lines.join("\n"), template: "blue" };
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
        `• Config ${configId}：${displayStoredConfigValue(before, configId)} → ${displayStoredConfigValue(after, configId)}`,
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
  message?: PendingSessionMessage,
): NoticeCardSpec {
  const beforeAgent = before ? (before.agentLabel ?? before.agentCommand) : "未绑定";
  const currentAgent = record.agentLabel ?? record.agentCommand;
  const continuationLine = message
    ? "已携带同一条请求中的 message，正在交给新 Agent 继续执行。"
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
    `• Config：${displayControlConfig(record.controls)}`,
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

function buildPendingControlsAppliedNotice(
  before: SessionCapabilitiesSnapshot,
  after: SessionCapabilitiesSnapshot,
  changed: SessionControlPatch,
): NoticeCardSpec {
  const lines = ["待应用的配置变更已在本轮结束后生效。", "", "**修改明细**"];
  if (changed.modeId !== undefined) {
    lines.push(`• Mode：${displaySnapshotMode(before)} → ${displaySnapshotMode(after)}`);
  }
  if (changed.clearModelId === true || changed.modelId !== undefined) {
    lines.push(`• Model：${displaySnapshotModel(before)} → ${displaySnapshotModel(after)}`);
  }
  if (changed.bridgePermissionMode !== undefined) {
    lines.push(
      `• Permission：${displaySnapshotPermission(before)} → ${displaySnapshotPermission(after)}`,
    );
  }
  if (changed.config !== undefined && Object.keys(changed.config).length > 0) {
    lines.push(`• Config：${displaySnapshotControls(before)} → ${displaySnapshotControls(after)}`);
  }
  return {
    title: "✅ 会话配置已更新",
    body: lines.join("\n"),
    template: "green",
  };
}

function buildPendingAgentSwitchFailedNotice(err: unknown): NoticeCardSpec {
  return {
    title: "⚠️ 待应用配置变更未完成",
    body: `当前回复已结束，但应用会话配置或发送后续消息时失败。请用 /profile 确认当前配置后重试。\n\n原因：${formatBootstrapError(err)}`,
    template: "red",
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
      "设置方式：/model <model-id|auto>、/mode <mode-id>、/permission <mode>。其他 Config 使用 `humming session configure --config <id=value>` 设置。",
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

function buildProfileCommandUsageNotice(command: string): NoticeCardSpec {
  return {
    title: `ℹ️ 用法：/${command}`,
    body: profileCommandUsage(command),
    template: "blue",
  };
}

/**
 * Parse lifecycle card ids persisted by the old bridge process. A numeric
 * marker is the legacy format and still identifies a restart without cards.
 *
 * @throws {SyntaxError} when a JSON marker has an invalid shape.
 */
function parseRestartNoticeDeliveries(raw: string): readonly LifecycleNoticeDelivery[] {
  const normalized = raw.trim();
  if (/^\d+$/u.test(normalized)) return [];
  const parsed: unknown = JSON.parse(normalized);
  if (!isUnknownRecord(parsed) || !Array.isArray(parsed["deliveries"])) {
    throw new SyntaxError("restart marker must contain a deliveries array");
  }
  return parsed["deliveries"].map((item) => {
    if (
      !isUnknownRecord(item) ||
      typeof item["chatId"] !== "string" ||
      item["chatId"].length === 0 ||
      typeof item["messageId"] !== "string" ||
      item["messageId"].length === 0
    ) {
      throw new SyntaxError("restart marker contains an invalid lifecycle card reference");
    }
    return { chatId: item["chatId"], messageId: item["messageId"] };
  });
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    title: "📋 当前会话配置",
    body: [
      "当前会话正在运行。",
      "",
      "**当前会话配置**",
      `• Agent：${displaySnapshotAgent(snapshot)}`,
      `• Repo：${snapshot.agent.cwd}`,
      `• Mode：${displaySnapshotMode(snapshot)}`,
      `• Model：${displaySnapshotModel(snapshot)}`,
      `• Permission：${displaySnapshotPermission(snapshot)}`,
      `• Config：${displaySnapshotControls(snapshot)}`,
      `• 状态：运行中`,
    ].join("\n"),
    template: "blue",
  };
}

function buildStoredProfileNotice(record: SessionRecord): NoticeCardSpec {
  const pending = record.pendingConfiguration;
  const pendingLine = pending
    ? `${displayControlPatch(pending.controls)}${pending.targetAgent ? ` · Agent → ${pending.targetAgent.agentLabel ?? pending.targetAgent.agentCommand}` : ""}${pending.message ? " · 后续消息已保存" : ""}`
    : "—";
  return {
    title: "📋 当前会话配置",
    body: [
      record.profileOnly
        ? "当前会话尚未开始；下一条消息会创建新的 Agent session。"
        : "当前会话可以在下一条消息到来时恢复。",
      "",
      "**当前会话配置**",
      `• Agent：${record.agentLabel ?? record.agentCommand}`,
      `• Repo：${record.cwd}`,
      `• Mode：${displayControlMode(record.controls)}`,
      `• Model：${displayControlModel(record.controls)}`,
      `• Permission：${displayControlPermission(record.controls)}`,
      `• Config：${displayControlConfig(record.controls)}`,
      `• 待应用配置变更：${pendingLine}`,
      `• 状态：${record.profileOnly ? "尚未开始" : "已保存"}`,
    ].join("\n"),
    template: "blue",
  };
}

function buildNoProfileNotice(binding: EffectiveBinding | null): NoticeCardSpec {
  return {
    title: "📋 当前会话配置",
    body: [
      "当前 topic 还没有会话配置。",
      "",
      "**默认启动信息**",
      `• Agent：${binding?.label ?? "—"}`,
      `• Repo：${binding?.cwd ?? "—"}`,
      "• Mode：—",
      "• Model：—",
      `• Permission：—`,
      "• Config：—",
      "• 状态：尚未创建会话",
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
  if (config !== "—") parts.push(`Config: ${config}`);
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
    "下条消息将在该目录启动 Agent；会话配置会从最近的 session 继承，否则使用全局默认配置。",
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
    "belong to the session configuration. New topics inherit the most recent",
    "session configuration from the same chat + repo, or use the global defaults",
    "if there is no history.",
    "",
    "Do not delete other chats' bindings or other top-level keys (credentials,",
    "runtime, agents).",
    "",
    "For Agent/Model/Mode/Permission/Config changes, read ~/.humming/AGENTS.md",
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
