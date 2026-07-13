import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { AgentStatus, LarkPresenter, SessionCardMeta } from "../presenter/presenter.js";
import { finalizeWipNoticeCard, restoreWipNoticeCard } from "../presenter/notice-card-lifecycle.js";
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
import { hasSessionControls, mergeSessionControls } from "../session-store/session-controls.js";

import {
  RingBufferLifecycleDiagnosticSink,
  type LifecycleDiagnosticSink,
} from "../acp/lifecycle-diagnostics.js";
import type { AcknowledgementPort } from "../conversation/topic-conversation-session.js";
import { PromptCallbackRouter } from "../acp/prompt-callback-router.js";
import { TopicConversationSession } from "../conversation/topic-conversation-session.js";
import { ConversationResponseHandle } from "../conversation/conversation-response-handle.js";
import type { RequestMessage, ResponseId } from "../conversation/topic-conversation.js";
import type { PromptToken } from "../presenter/conversation-card-view.js";
import crypto from "node:crypto";
import type { LifecycleIntent } from "../../bin/lifecycle-coordinator.js";

const SHUTDOWN_FINALIZE_TIMEOUT_MS = 3_000;

export interface DrainResult {
  readonly intent: LifecycleIntent;
  readonly outcome: "drained" | "escalated";
  readonly cancel: "not-needed" | "sent" | "rejected" | "timed-out";
  readonly persisted: boolean;
  readonly agentClose: "not-needed" | "closed" | "timed-out";
}

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  /** Message used as reply/card anchor for this prompt. */
  messageId: string;
  chatId: string;
  /** Response-scoped facade for the semantic conversation lifecycle. */
  response?: ConversationResponseHandle;
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
  /** Controls copied from the most recent session profile in the same chat +
   * repo. Used only when this runtime creates a brand-new ACP session; existing
   * topic sessions keep their own persisted controls.
   */
  inheritedControls?: SessionControls;
  /** Persist inherited/default controls even when every field is bridge-side only. */
  persistInheritedControls?: boolean;
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
  onTurnComplete?: (messageId: string) => Promise<void>;

  lifecycleDiagnostics?: LifecycleDiagnosticSink;
  acknowledgement?: AcknowledgementPort;
}

const HANDOFF_TASK_HINT =
  "[humming: this prompt is the task portion of an already-applied pending task continuation. Do not call Humming session-control commands again unless the user explicitly requests another Agent/Model/Mode/Permission/Config change.]";

interface ChatRuntimeState {
  client: HummingClient;
  router: PromptCallbackRouter | null;
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

  private readonly lifecycleDiagnostics: LifecycleDiagnosticSink;
  private readonly conversation: TopicConversationSession;
  private activeResponse: ConversationResponseHandle | null = null;
  private pendingCarrier: PendingMessage | null = null;
  private committedCarrierResponseId: ResponseId | null = null;
  private committedPendingBatch: readonly RequestMessage[] | null = null;
  private state: ChatRuntimeState | null = null;
  private bootstrapPromise: Promise<ChatRuntimeState> | null = null;
  private readonly admissionOrder: ResponseId[] = [];
  private readonly hydratedAdmissions = new Map<
    ResponseId,
    {
      readonly message: PendingMessage;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  private readonly hydratedByMessageId = new Map<string, PendingMessage>();
  private admissionDrain: Promise<void> = Promise.resolve();
  private aborted = false;
  /** True after a topic-level /cancel or runtime shutdown requested cancellation. */
  private topicCancelRequested = false;
  /** Response whose tokenized Card Cancel requested cancellation. */
  private responseCancelRequested: ResponseId | null = null;
  /** Response whose mandatory Permission Card could not be displayed. */
  private permissionDisplayFailureResponse: ResponseId | null = null;
  /** True after a busy follow-up requested a soft cancel of the current prompt. */
  private followupInterruptRequested = false;
  /** Suppress the prompt-error notice when this runtime is intentionally replaced. */
  private suppressPromptErrorNotice = false;
  /** Absorbing coordinated lifecycle reason, never reset by prompt cleanup. */
  private lifecycleIntent: LifecycleIntent | null = null;
  private drainPromise: Promise<DrainResult> | null = null;
  /** Set while a prompt is in-flight — exit handler defers to handlePromptError then. */
  private promptInFlight = false;
  /** Follow-up messages preserved across a respawn after an interrupt closed the agent. */
  private readonly queuedAfterRespawn: PendingMessage[] = [];
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

    this.lifecycleDiagnostics =
      opts.lifecycleDiagnostics ?? new RingBufferLifecycleDiagnosticSink();
    this.conversation = new TopicConversationSession({
      presenter: opts.presenter,
      logger: this.logger,
      route: {
        c: opts.chatId,
        ...(opts.threadId === null ? {} : { th: opts.threadId }),
      },
      showThoughts: opts.showThoughts,
      showTools: opts.showTools,
      showCancelButton: opts.showCancelButton,
      presentationEnabled: true,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      permissionMode: () => this.state?.client.getPermissionMode() ?? opts.permissionMode,
      acknowledgement: opts.acknowledgement,
      onCancelResponse: async (responseId) => this.cancelResponse(responseId),
      onPermissionDisplayFailure: async (responseId) =>
        this.cancelResponse(responseId, "permission_display_failed"),
    });
  }

  acceptResponse(context: {
    messageId: string;
    content: unknown;
    profile: SessionCardMeta | null;
  }): ConversationResponseHandle {
    const accepted = this.conversation.accept({
      sourceMessageId: context.messageId,
      content: context.content,
      profile: context.profile,
    });
    const handle = new ConversationResponseHandle(
      accepted.responseId,
      accepted.responseToken,
      context.messageId,
      this.conversation,
    );
    this.admissionOrder.push(handle.responseId);
    return handle;
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
    const admitted: PendingMessage =
      message.response === undefined
        ? {
            ...message,
            response: this.acceptResponse({
              messageId: message.messageId,
              content: message.prompt,
              profile: null,
            }),
          }
        : message;
    await new Promise<void>((resolve, reject) => {
      this.hydratedByMessageId.set(admitted.messageId, admitted);
      this.hydratedAdmissions.set(admitted.response!.responseId, {
        message: admitted,
        resolve,
        reject,
      });
      this.scheduleAdmissionDrain();
    });
  }

  private scheduleAdmissionDrain(): void {
    this.admissionDrain = this.admissionDrain
      .then(async () => {
        while (this.admissionOrder.length > 0) {
          const responseId = this.admissionOrder[0];
          if (responseId === undefined) return;
          const hydrated = this.hydratedAdmissions.get(responseId);
          if (hydrated === undefined) return;
          this.admissionOrder.shift();
          this.hydratedAdmissions.delete(responseId);
          try {
            await this.enqueueReady(hydrated.message);
            hydrated.resolve();
          } catch (error) {
            hydrated.reject(error);
            if (this.aborted && this.state === null) {
              await this.conversation.interruptTopic().catch(() => undefined);
              this.clearAdmissionState("runtime bootstrap failed");
              return;
            }
          }
        }
      })
      .catch((error) => this.logger.error({ error }, "admission drain crashed"));
  }

  private async enqueueReady(message: PendingMessage): Promise<void> {
    const pending = message;
    if (!this.state) {
      // A previous agent crash / idle exit tears down `state`; the next user
      // message should spawn a fresh agent, not inherit the old aborted flag.
      this.aborted = false;
      this.topicCancelRequested = false;
      this.followupInterruptRequested = false;
      const ownsBootstrap = this.bootstrapPromise === null;
      if (ownsBootstrap) {
        this.booting = true;
        this.bootstrapPromise = this.bootstrap(pending);
      }
      const bootstrap = this.bootstrapPromise;
      if (bootstrap === null) throw new Error("runtime bootstrap was not scheduled");
      try {
        const bootstrapped = await bootstrap;
        if (this.aborted) {
          killAgent(bootstrapped.agent.process);
          return;
        }
        this.state = bootstrapped;
      } catch (err) {
        if (this.aborted) return;
        if (pending.response !== undefined) {
          await pending.response
            .fail("Agent 启动失败，本轮 Response 未能开始。")
            .catch(() => undefined);
        }
        this.aborted = true;
        throw err;
      } finally {
        if (ownsBootstrap) {
          this.bootstrapPromise = null;
          this.booting = false;
        }
      }
    }

    const state = this.state;
    if (state === null) throw new Error("runtime bootstrap did not produce state");
    state.lastActivity = Date.now();
    if (pending.response !== undefined && !pending.response.isRunnable()) return;
    if (pending.response !== undefined && this.committedCarrierResponseId !== null) {
      if (pending.response.responseId !== this.committedCarrierResponseId) {
        throw new Error("hydrated Response does not match committed batch carrier");
      }
      this.committedCarrierResponseId = null;
      this.pendingCarrier = null;
      this.applyCommittedBatchPrompt(pending);
      state.queue.push(pending);
      if (!state.processing) {
        state.processing = true;
        this.processQueue().catch((err) => this.logger.error({ err }, "queue processor crashed"));
      }
      return;
    }
    if (
      this.conversation.snapshot.executionOwnerResponseId !== null &&
      (state.processing || this.promptInFlight) &&
      pending.response !== undefined
    ) {
      const previousCarrier = this.pendingCarrier;
      if (previousCarrier !== null) {
        pending.prompt = [
          ...previousCarrier.prompt,
          { type: "text", text: "[用户补充/修正了上一条尚未发送的消息，以下内容属于同一请求批次]" },
          ...pending.prompt,
        ];
      }
      this.pendingCarrier = pending;
      await this.interruptCurrentPromptForFollowup(state, pending);
      return;
    }
    state.queue.push(pending);

    if (state.processing || this.promptInFlight) {
      return;
    }

    state.processing = true;
    this.processQueue().catch((err) => this.logger.error({ err }, "queue processor crashed"));
  }

  private commitPendingCarrier(handoff: {
    readonly pendingBatch: readonly RequestMessage[] | null;
    readonly carrierResponseId: ResponseId | null;
  }): void {
    if (handoff.pendingBatch === null || handoff.carrierResponseId === null) return;
    this.committedPendingBatch = handoff.pendingBatch;
    const queuedCarrier = this.state?.queue.find(
      (message) => message.response?.responseId === handoff.carrierResponseId,
    );
    if (queuedCarrier !== undefined) {
      this.applyCommittedBatchPrompt(queuedCarrier);
      this.pendingCarrier = null;
      this.committedCarrierResponseId = null;
      return;
    }
    const carrier = this.pendingCarrier;
    if (carrier === null) {
      this.committedCarrierResponseId = handoff.carrierResponseId;
      return;
    }
    if (carrier.response?.responseId !== handoff.carrierResponseId) {
      throw new Error("domain pending batch carrier does not match runtime carrier");
    }
    this.applyCommittedBatchPrompt(carrier);
    this.pendingCarrier = null;
    this.state?.queue.push(carrier);
  }

  private applyCommittedBatchPrompt(carrier: PendingMessage): void {
    const batch = this.committedPendingBatch;
    if (batch === null) return;
    const blocks: acp.ContentBlock[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const request = batch[index];
      if (request === undefined) continue;
      const hydrated = this.hydratedByMessageId.get(request.sourceMessageId);
      if (hydrated === undefined) {
        throw new Error(`pending batch message is not hydrated: ${request.sourceMessageId}`);
      }
      if (blocks.length > 0) {
        blocks.push({
          type: "text",
          text: "[用户补充/修正了上一条尚未发送的消息，以下内容属于同一请求批次]",
        });
      }
      blocks.push(...hydrated.prompt);
    }
    carrier.prompt = blocks;
    for (const request of batch) this.hydratedByMessageId.delete(request.sourceMessageId);
    this.committedPendingBatch = null;
  }

  /**
   * Soft-interrupt the in-flight prompt so a queued user follow-up can run next.
   * The queue is intentionally preserved; unlike `/cancel`, the new message is
   * the work the user wants next, not something to discard.
   */
  private async interruptCurrentPromptForFollowup(
    state: ChatRuntimeState,
    _message: PendingMessage,
  ): Promise<void> {
    if (this.followupInterruptRequested) return;
    this.followupInterruptRequested = true;

    try {
      await state.agent.connection.cancel({ sessionId: state.agent.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "busy follow-up cancel notification rejected");
    }
  }

  private async cancelResponse(
    responseId: ResponseId,
    reason: "card_cancel" | "permission_display_failed" = "card_cancel",
  ): Promise<void> {
    const state = this.state;
    if (state === null || this.activeResponse?.responseId !== responseId) return;
    if (reason === "permission_display_failed") {
      this.permissionDisplayFailureResponse = responseId;
    } else {
      this.responseCancelRequested = responseId;
    }
    try {
      await state.agent.connection.cancel({ sessionId: state.agent.sessionId });
    } catch (err) {
      this.logger.warn({ err, responseId }, "Response cancel notification rejected");
    }
  }

  private clearAdmissionState(reason: string): void {
    const error = new Error(reason);
    for (const hydrated of this.hydratedAdmissions.values()) hydrated.reject(error);
    this.admissionOrder.length = 0;
    this.hydratedAdmissions.clear();
    this.hydratedByMessageId.clear();
    this.committedPendingBatch = null;
    this.committedCarrierResponseId = null;
    this.pendingCarrier = null;
  }

  /**
   * Cancel the current prompt (if any) and clear the queue. Keeps the
   * agent process alive so the next message can resume the same session.
   */
  async cancel(): Promise<void> {
    const state = this.state;
    if (!state) {
      this.aborted = true;
      this.topicCancelRequested = true;
      await this.conversation.beginTopicCancel();
      this.clearAdmissionState("topic was cancelled");
      return;
    }
    this.logger.info("cancelling current task");
    this.topicCancelRequested = true;
    await this.conversation.beginTopicCancel();

    try {
      await state.agent.connection.cancel({ sessionId: state.agent.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "cancel notification rejected");
    }
    this.clearAdmissionState("topic was cancelled");
    state.queue.length = 0;
  }

  /** Tear down the agent process so the next message starts fresh. */
  async shutdown(_finalStatus: AgentStatus | null = "cancelled"): Promise<void> {
    this.aborted = true;
    const state = this.state;
    if (!state) {
      await this.conversation.interruptTopic();
      this.clearAdmissionState("runtime was shut down");
      return;
    }
    this.logger.info("shutting down chat runtime");
    await this.conversation.interruptTopic();
    this.clearAdmissionState("runtime was shut down");

    this.state = null;
    killAgent(state.agent.process);
  }

  /** Gracefully quiesce this runtime for coordinated bridge Stop/Restart. */
  drain(intent: LifecycleIntent): Promise<DrainResult> {
    if (this.lifecycleIntent !== null && this.lifecycleIntent !== intent) {
      return Promise.reject(new Error(`runtime is already draining for ${this.lifecycleIntent}`));
    }
    if (this.drainPromise !== null) return this.drainPromise;

    // Commit crash suppression and revoke ingress/action authority before any await/ACP action.
    this.lifecycleIntent = intent;
    this.suppressPromptErrorNotice = true;
    this.aborted = true;
    const state = this.state;
    const interruption = this.conversation.interruptTopic();
    this.clearAdmissionState(`runtime is draining for ${intent}`);
    this.queuedAfterRespawn.length = 0;
    if (state !== null) state.queue.length = 0;

    this.drainPromise = this.finishDrain(intent, state, interruption);
    return this.drainPromise;
  }

  private async finishDrain(
    intent: LifecycleIntent,
    state: ChatRuntimeState | null,
    interruption: Promise<void>,
  ): Promise<DrainResult> {
    let escalated = false;
    await withTimeout(
      interruption.then(() => this.conversation.flushPresentation()),
      SHUTDOWN_FINALIZE_TIMEOUT_MS,
    ).catch((err) => {
      escalated = true;
      this.logger.warn({ err, intent }, "drain presentation flush timed out");
    });

    if (state === null) {
      return {
        intent,
        outcome: escalated ? "escalated" : "drained",
        cancel: "not-needed",
        persisted: false,
        agentClose: "not-needed",
      };
    }

    let cancel: DrainResult["cancel"] = "sent";
    try {
      await withTimeout(
        state.agent.connection.cancel({ sessionId: state.agent.sessionId }),
        SHUTDOWN_FINALIZE_TIMEOUT_MS,
      );
    } catch (err) {
      cancel = isTimeoutError(err) ? "timed-out" : "rejected";
      escalated = true;
      this.logger.info({ err, intent }, "expected drain cancel did not settle cleanly");
    }

    let promptTimedOut = false;
    try {
      await withTimeout(
        waitUntil(() => !this.promptInFlight),
        SHUTDOWN_FINALIZE_TIMEOUT_MS,
      );
    } catch (err) {
      promptTimedOut = true;
      escalated = true;
      this.logger.info({ err, intent }, "active prompt did not settle during drain");
    }

    const persisted = await this.persistSession(state.agent.sessionId);
    this.state = null;
    killAgent(state.agent.process);
    return {
      intent,
      outcome: escalated ? "escalated" : "drained",
      cancel,
      persisted,
      agentClose: promptTimedOut ? "timed-out" : "closed",
    };
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
    if (!state) {
      await this.conversation.interruptTopic();
      this.clearAdmissionState("runtime was superseded");
      return;
    }
    this.logger.info("superseding chat runtime");
    this.suppressPromptErrorNotice = true;
    this.topicCancelRequested = true;
    await this.conversation.interruptTopic();
    this.clearAdmissionState("runtime was superseded");

    await withTimeout(
      this.promptInFlight
        ? this.finishRuntimePrompt(state, "superseded")
        : this.finishRuntimePromptIfActive(state, "superseded"),
      SHUTDOWN_FINALIZE_TIMEOUT_MS,
    ).catch((err) => this.logger.warn({ err }, "supersede card finalize failed"));
    this.state = null;
    killAgent(state.agent.process);
  }

  private async finishRuntimePrompt(
    _state: ChatRuntimeState,
    _outcome: "complete" | "cancelled" | "failed" | "superseded" | "abandoned",
  ): Promise<void> {
    await this.conversation.finishOwner("interrupted");
  }

  private async finishRuntimePromptIfActive(
    _state: ChatRuntimeState,
    _outcome: "complete" | "cancelled" | "failed" | "superseded" | "abandoned",
  ): Promise<void> {
    await this.conversation.finishOwner("interrupted");
  }

  abandonHydration(responseId: ResponseId): void {
    const index = this.admissionOrder.indexOf(responseId);
    if (index >= 0) this.admissionOrder.splice(index, 1);
    const hydrated = this.hydratedAdmissions.get(responseId);
    if (hydrated !== undefined) {
      this.hydratedAdmissions.delete(responseId);
      this.hydratedByMessageId.delete(hydrated.message.messageId);
      hydrated.reject(new Error("response hydration was abandoned"));
    }
    this.scheduleAdmissionDrain();
    if (this.pendingCarrier?.response?.responseId === responseId) this.pendingCarrier = null;
    if (this.committedCarrierResponseId === responseId) {
      this.committedCarrierResponseId = null;
      this.committedPendingBatch = null;
    }
  }

  consumeCancelAction(input: {
    promptToken: string;
    segmentToken: string;
    actionToken: string;
  }): "accepted" | "stale" {
    return this.conversation.consumeCancel({
      responseToken: input.promptToken,
      cardId: input.segmentToken,
      actionToken: input.actionToken,
    });
  }

  consumePermissionAction(input: {
    promptToken: string;
    permissionToken: string;
    requestId: string;
    optionId: string;
  }): "accepted" | "stale" {
    return this.conversation.consumePermission({
      responseToken: input.promptToken,
      permissionToken: input.permissionToken,
      requestId: input.requestId,
      optionId: input.optionId,
    });
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
    const applySessionInfo = (update: acp.SessionInfoUpdate): void => {
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
    };
    const client = new HummingClient({
      permissionMode:
        latest?.controls?.bridgePermissionMode ??
        this.opts.inheritedControls?.bridgePermissionMode ??
        this.opts.permissionMode,
    });
    currentClient = client;
    const router = new PromptCallbackRouter(
      {
        readTextFile: (params) => client.readTextFile(params),
        writeTextFile: (params) => client.writeTextFile(params),
        onSessionInfo: applySessionInfo,
        onMode: () => undefined,
        onConfig: () => undefined,
        onCommands: () => undefined,
        onUsage: () => undefined,
      },
      this.lifecycleDiagnostics,
    );
    const bootstrapRoute =
      router?.activateBootstrap(latest && !latest.profileOnly ? "resume" : "new", {
        sessionUpdate: async (params) => {
          const update = params.update;
          if (update.sessionUpdate === "session_info_update") applySessionInfo(update);
        },
      }) ?? null;

    const spawnOpts: SpawnAgentOptions = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client: router ?? client,
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
      if (!this.aborted && firstMessage.response !== undefined) {
        await firstMessage.response
          .fail("Agent 启动失败，本轮 Response 未能开始。")
          .catch(() => undefined);
      }
      throw err;
    } finally {
      if (router !== null && bootstrapRoute !== null) router.closeBootstrap(bootstrapRoute);
    }

    try {
      await this.persistSession(agent.sessionId);

      const persistedTitle = sanitizeSessionTitle(latest?.title);
      const state: ChatRuntimeState = {
        client,
        router,
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

      if (latest?.controls) {
        const { controls, ignored } = filterSessionControls(
          state.sessionCapabilities,
          latest.controls,
        );
        if (ignored.length > 0) {
          await this.cleanPersistedControls(latest, controls);
          await this.notifyStoredControlsIgnored(firstMessage.messageId, ignored);
        }
        if (hasSessionControls(controls)) {
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
        if (hasSessionControls(controls)) {
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
        } else if (this.opts.persistInheritedControls) {
          await this.persistSession(agent.sessionId, controls);
        }
        if (ignored.length > 0) {
          await this.notifyInheritedControlsIgnored(firstMessage.messageId, ignored);
        }
      }

      agent.process.on("exit", (code, signal) => {
        this.handleUnexpectedExit(code, signal);
      });
      return state;
    } catch (err) {
      killAgent(agent.process);
      throw err;
    }
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
      ...(hasSessionControls(controls) ? { controls } : { controls: undefined }),
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

    this.state = null;
    this.aborted = true;
  }

  private async processQueue(): Promise<void> {
    const state = this.state;
    if (!state) return;

    try {
      while (!this.aborted) {
        if (state.queue.length === 0) {
          if (this.queuedAfterRespawn.length === 0) break;
          state.queue.push(...this.queuedAfterRespawn.splice(0));
        }
        const pending = state.queue.shift()!;
        if (pending.response !== undefined && !pending.response.isRunnable()) continue;
        this.hydratedByMessageId.delete(pending.messageId);
        state.lastMessageId = pending.messageId;

        await this.applyPendingControlsBeforePrompt(state, pending.messageId);
        if (this.aborted || this.state !== state) return;

        this.promptInFlight = true;
        try {
          await this.runPrompt(state, pending);
        } catch (err) {
          await this.handlePromptError(state, pending, err);
          if (!this.state) return; // shut down by error handler
        } finally {
          if (pending.response !== undefined && this.activeResponse === pending.response) {
            this.activeResponse = null;
          }
          const router = state.router;
          if (router !== null && !router.isConnectionHealthy()) {
            this.logger.warn(
              "quarantined ACP callback route; restarting connection before next prompt",
            );
            const queued = state.queue.splice(0);
            this.queuedAfterRespawn.push(...queued);
            this.state = null;
          }
          this.promptInFlight = false;
          this.topicCancelRequested = false;
          this.responseCancelRequested = null;
          this.permissionDisplayFailureResponse = null;
          this.followupInterruptRequested = false;
        }
      }
    } finally {
      if (this.state) this.state.processing = false;
      if (!this.state && this.queuedAfterRespawn.length > 0 && !this.aborted) {
        const next = this.queuedAfterRespawn.shift()!;
        await this.enqueueReady(next);
      }
    }
  }

  private async applyPendingControlsBeforePrompt(
    state: ChatRuntimeState,
    messageId: string,
  ): Promise<boolean> {
    let consumed: Awaited<ReturnType<SessionStore["consumePendingControls"]>>;
    try {
      consumed = await this.opts.sessionStore.consumePendingControls({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId: state.agent.sessionId,
      });
    } catch (err) {
      this.logger.warn({ err }, "pending session controls lookup failed");
      return false;
    }
    const pendingControls = consumed.pendingControls;
    if (pendingControls === undefined || !hasSessionControls(pendingControls)) return false;

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
        consumed.noticeMessageId,
      );
      return true;
    } catch (err) {
      this.logger.warn({ err }, "pending session controls apply failed");
      await this.notifyPendingControlFailure(messageId, err, consumed.noticeMessageId);
      return false;
    }
  }

  private async enqueuePendingTaskAfterControls(
    state: ChatRuntimeState,
    messageId: string,
  ): Promise<void> {
    let consumed: Awaited<ReturnType<SessionStore["consumePendingTask"]>>;
    try {
      consumed = await this.opts.sessionStore.consumePendingTask({
        chatId: this.opts.chatId,
        threadId: this.opts.threadId,
        sessionId: state.agent.sessionId,
      });
    } catch (err) {
      this.logger.warn({ err }, "pending task lookup failed");
      return;
    }
    const promptText = consumed.pendingTask?.prompt.trim();
    if (!promptText) return;
    const injected: PendingMessage = {
      prompt: [
        { type: "text", text: promptText },
        { type: "text", text: HANDOFF_TASK_HINT },
      ],
      messageId,
      chatId: this.opts.chatId,
      response: this.acceptResponse({
        messageId,
        content: promptText,
        profile: sessionMetaFromSnapshot({
          ...state.sessionCapabilities,
          bridgePermissionMode: state.client.getPermissionMode(),
        }),
      }),
    };
    if (injected.response !== undefined) {
      this.hydratedByMessageId.set(injected.messageId, injected);
      this.hydratedAdmissions.set(injected.response.responseId, {
        message: injected,
        resolve: () => undefined,
        reject: (error) => this.logger.warn({ error }, "injected pending task admission failed"),
      });
      this.scheduleAdmissionDrain();
      return;
    }
    state.queue.unshift(injected);
  }

  private async notifyPendingControlFailure(
    messageId: string,
    err: unknown,
    queuedNoticeMessageId?: string,
  ): Promise<void> {
    const notice = {
      title: "⚠️ 排队的 Session 设置未生效",
      body: [
        "之前排队的 session control 设置在本轮发送前应用失败，已丢弃；当前消息会继续使用旧 profile。",
        "",
        formatControlFailure(err),
        "",
        "请让 agent 重新查询 capabilities 后，使用有效的 modelId / modeId / config 值再试。",
      ].join("\n"),
      template: "orange" as const,
    };
    const queuedNotice = restoreWipNoticeCard(queuedNoticeMessageId);
    if (queuedNotice) {
      await finalizeWipNoticeCard(this.opts.presenter, queuedNotice, notice, async () => {
        await this.opts.presenter.replyNoticeCard(messageId, notice);
      });
      return;
    }
    await this.opts.presenter
      .replyNoticeCard(messageId, notice)
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
    queuedNoticeMessageId?: string,
  ): Promise<void> {
    const notice = {
      title: "✅ 排队的 Session profile 已生效",
      body: renderControlSuccessBody(before, after, controls),
      template: "green" as const,
    };
    const queuedNotice = restoreWipNoticeCard(queuedNoticeMessageId);
    if (queuedNotice) {
      await finalizeWipNoticeCard(this.opts.presenter, queuedNotice, notice, async () => {
        await this.opts.presenter.replyNoticeCard(messageId, notice);
      });
      return;
    }
    await this.opts.presenter
      .replyNoticeCard(messageId, notice)
      .catch((sendErr) =>
        this.logger.warn({ err: sendErr }, "pending control success notice failed"),
      );
  }

  private async runPrompt(state: ChatRuntimeState, pending: PendingMessage): Promise<void> {
    this.logger.info("sending prompt to agent");
    const response = pending.response;
    if (response === undefined) throw new Error("pending message must have a semantic Response");
    const router = state.router;
    if (router === null) throw new Error("semantic Response requires an ACP callback router");
    this.activeResponse = response;
    await response.prepare(
      sessionMetaFromSnapshot({
        ...state.sessionCapabilities,
        bridgePermissionMode: state.client.getPermissionMode(),
      }),
    );
    await response.activate();
    const batch = this.conversation.snapshot.pendingBatch;
    if (batch?.state === "collecting") {
      const carrierMessageId = batch.messages.at(-1)?.sourceMessageId;
      const carrier =
        carrierMessageId === undefined ? undefined : this.hydratedByMessageId.get(carrierMessageId);
      if (carrier !== undefined) {
        this.pendingCarrier = carrier;
        await this.interruptCurrentPromptForFollowup(state, carrier);
      }
    }
    const routeHandle = router.activate(response.responseToken as PromptToken, {
      sessionUpdate: async (params) => response.applyAgentUpdate(params.update),
      requestPermission: async (params) => response.requestPermission(params),
      cancelPendingPermissions: () => response.cancelPendingPermissions(),
    });

    let result: Awaited<ReturnType<typeof state.agent.connection.prompt>>;
    try {
      result = await this.promptOrDisconnect(state, pending);
    } finally {
      state.router?.close(routeHandle);
    }

    if (this.activeResponse === response) {
      this.activeResponse = null;
    }

    if (this.suppressPromptErrorNotice || this.aborted || this.state !== state) {
      this.logger.info("prompt completed after runtime was superseded; skipping session persist");
      return;
    }

    this.logger.info({ stopReason: result.stopReason, usage: result.usage ?? null }, "prompt done");
    const status = stopReasonToStatus(result.stopReason);
    if (this.topicCancelRequested) {
      await this.conversation.confirmTopicCancel();
    } else {
      await this.conversation.finishOwner(
        this.responseCancelRequested === response.responseId
          ? "cancelled"
          : this.permissionDisplayFailureResponse === response.responseId
            ? "failed"
            : this.followupInterruptRequested
              ? "interrupted"
              : status === "complete"
                ? "complete"
                : status === "failed"
                  ? "failed"
                  : "cancelled",
        (handoff) => this.commitPendingCarrier(handoff),
      );
    }
    await this.persistSession(state.agent.sessionId);
    const pendingControlsApplied = await this.applyPendingControlsBeforePrompt(
      state,
      pending.messageId,
    );
    if (pendingControlsApplied)
      await this.enqueuePendingTaskAfterControls(state, pending.messageId);
    await this.opts.onTurnComplete?.(pending.messageId);
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
    const topicCancelRequested = this.topicCancelRequested;
    const responseCancelRequested = this.responseCancelRequested === pending.response?.responseId;
    const permissionDisplayFailed =
      this.permissionDisplayFailureResponse === pending.response?.responseId;
    const followupInterruptRequested = this.followupInterruptRequested;
    const suppressNotice = this.suppressPromptErrorNotice || this.lifecycleIntent !== null;
    const exitCode = state.agent.process.exitCode;
    const signal = state.agent.process.signalCode;
    const stderrTail = procDead ? state.agent.getRecentStderr() : [];
    const terminalStatus: AgentStatus =
      (topicCancelRequested ||
        responseCancelRequested ||
        followupInterruptRequested ||
        suppressNotice) &&
      !isAuthError
        ? "cancelled"
        : "failed";

    if (topicCancelRequested) {
      await this.conversation.confirmTopicCancel();
    } else {
      const outcome = responseCancelRequested
        ? "cancelled"
        : permissionDisplayFailed
          ? "failed"
          : followupInterruptRequested || suppressNotice
            ? "interrupted"
            : "failed";
      await this.conversation.finishOwner(outcome, (handoff) => this.commitPendingCarrier(handoff));
    }

    if (suppressNotice) {
      this.suppressPromptErrorNotice = false;
      return;
    }

    // A follow-up interrupt may close the ACP connection instead of returning a
    // clean cancelled prompt. Preserve queued follow-ups, respawn the runtime on
    // the next queue iteration, and avoid surfacing a scary crash notice: the
    // user already saw the "interrupting" acknowledgement for this transition.
    if (followupInterruptRequested && !isAuthError && (procDead || disconnected)) {
      if (topicCancelRequested) {
        this.logger.info({ err, disconnected }, "agent closed while cancelling busy follow-up");
        state.queue.length = 0;
        this.queuedAfterRespawn.length = 0;
        this.state = null;
        this.followupInterruptRequested = false;
        return;
      }
      this.logger.info({ err, disconnected }, "agent closed after busy follow-up interrupt");
      const queuedFollowups = state.queue.splice(0);
      this.queuedAfterRespawn.push(...queuedFollowups);
      this.state = null;
      this.followupInterruptRequested = false;
      this.topicCancelRequested = false;
      return;
    }

    // A closed connection means the agent is gone even if the OS hasn't
    // surfaced an exit code yet — tear it down so the next message respawns.
    if (isAuthError || procDead || disconnected) {
      await this.shutdown(null);
      const title = isAuthError
        ? "⚠️ Agent 认证失败"
        : topicCancelRequested
          ? "⛔ Agent 已中断"
          : "⚠️ Agent 异常退出";
      const body = isAuthError
        ? formatExitBody(`Agent authentication failed: ${errMsg}`, stderrTail)
        : topicCancelRequested
          ? formatExitBody(
              `已请求中断，agent 连接已关闭。${formatExitCode(exitCode, signal)}`,
              stderrTail,
            )
          : formatExitBody(
              `Agent crashed: ${errMsg}. ${formatExitCode(exitCode, signal)}`,
              stderrTail,
            );
      this.logger.error({ err, isAuthError, disconnected, topicCancelRequested }, "agent died");
      await this.opts.presenter
        .replyNoticeCard(pending.messageId, {
          title,
          body,
          template: topicCancelRequested && !isAuthError ? "grey" : "red",
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

  private async persistSession(
    sessionId: string,
    controls?: SessionControlPatch,
  ): Promise<boolean> {
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
        ...(previous?.pendingControlsNoticeMessageId !== undefined
          ? { pendingControlsNoticeMessageId: previous.pendingControlsNoticeMessageId }
          : {}),
        ...(previous?.pendingTask !== undefined ? { pendingTask: previous.pendingTask } : {}),
        ...(previous?.pendingTargetProfile !== undefined
          ? { pendingTargetProfile: previous.pendingTargetProfile }
          : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      return true;
    } catch (err) {
      this.logger.warn({ err }, "session store save failed");
      return false;
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timed out after ");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
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
    haystack.includes("allow all") ||
    haystack.includes("allow_all") ||
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
    `• Controls：${displayControls(after, controls)}`,
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

function displayControls(
  snapshot: SessionCapabilitiesSnapshot,
  changed: SessionControlPatch,
): string {
  const configIds = Object.keys(changed.config ?? {});
  if (configIds.length === 0) return "—";
  return configIds
    .map((configId) => {
      const option = snapshot.configOptions?.find((candidate) => candidate.id === configId);
      return option
        ? `${option.name}: ${displayConfigCurrentValue(option)}`
        : `${configId}: ${displayStoredControlConfigValue(changed.config![configId]!)}`;
    })
    .join(" · ");
}

function displayStoredControlConfigValue(
  value: NonNullable<SessionControls["config"]>[string],
): string {
  if ("type" in value && value.type === "boolean") return value.value ? "on" : "off";
  return String(value.value);
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
    if (isCoreProfileConfigId(configId)) {
      throw new ControlApplyError(
        "Config",
        configId,
        `core profile field must be set with ${coreProfileConfigFieldHint(configId)}, not controls.config`,
      );
    }
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
    if (isCoreProfileConfigId(configId)) {
      ignored.push({
        kind: "Config",
        target: configId,
        reason: `core profile field must be set with ${coreProfileConfigFieldHint(configId)}, not controls.config`,
      });
      continue;
    }
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

function isCoreProfileConfigId(configId: string): boolean {
  const normalized = normalizeCoreProfileConfigId(configId);
  return normalized === "agent" || normalized === "mode" || normalized === "model";
}

function coreProfileConfigFieldHint(configId: string): string {
  switch (normalizeCoreProfileConfigId(configId)) {
    case "agent":
      return "PendingTargetProfile.agentLabel/agentCommand";
    case "mode":
      return "controls.modeId";
    case "model":
      return "controls.modelId";
    default:
      return "the matching top-level profile/control field";
  }
}

function normalizeCoreProfileConfigId(configId: string): string {
  return configId
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
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
