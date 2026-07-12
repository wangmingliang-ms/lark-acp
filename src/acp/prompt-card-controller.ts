import type * as acp from "@agentclientprotocol/sdk";
import type {
  ActionToken,
  CardRoute,
  ConversationCardView,
  OwnershipToken,
  PermissionToken,
  PromptToken,
  SegmentToken,
} from "../presenter/conversation-card-view.js";
import type { SessionCardMeta } from "../presenter/presenter.js";
import type {
  CardDeliveryContext,
  CardDeliveryResult,
  PermissionHandoffRequest,
  PermissionHandoffResult,
} from "./conversation-card-delivery.js";
import type { DiagnosticCorrelation, LifecycleDiagnosticSink } from "./lifecycle-diagnostics.js";
import {
  createPromptLifecycle,
  reducePromptLifecycle,
  type CardEffect,
  type ConversationCardEvent,
  type PermissionViewData,
  type PromptLifecycleState,
  type TerminalOutcome,
  type ToolEvent,
} from "./prompt-card-lifecycle.js";

export interface PendingPermission {
  readonly promptToken: PromptToken;
  readonly permissionToken: PermissionToken;
  readonly requestId: string;
  readonly allowedOptionIds: ReadonlySet<string>;
  readonly response: Promise<acp.RequestPermissionResponse>;
}

export interface PromptCardTokenFactory {
  prompt(): PromptToken;
  segment(): SegmentToken;
  action(): ActionToken;
  permission(): PermissionToken;
  ownership(): OwnershipToken;
}

export interface PromptCardControllerDelivery {
  createOwner(
    context: CardDeliveryContext,
    correlation: DiagnosticCorrelation,
    suppliedToken: OwnershipToken,
  ): OwnershipToken;
  deliver(owner: OwnershipToken, view: ConversationCardView): Promise<CardDeliveryResult>;
  close(
    owner: OwnershipToken,
    view: Extract<ConversationCardView, { kind: "archived" | "terminal" }>,
    nextCorrelation: DiagnosticCorrelation,
    nextOwnerToken: OwnershipToken,
  ): OwnershipToken;
  handoffToPermission(
    owner: OwnershipToken,
    request: PermissionHandoffRequest,
  ): Promise<PermissionHandoffResult>;
  reconcileSuperseded(
    owner: OwnershipToken,
    cardId: string,
    view: Extract<ConversationCardView, { kind: "orphaned" }>,
  ): Promise<void>;
}

export interface AcknowledgementPort {
  add(messageId: string): Promise<string | null>;
  remove(messageId: string, reactionId: string): Promise<boolean>;
}

export interface PromptCardTimerPort {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PromptCardControllerOptions {
  readonly initialPhase: "queued" | "interrupting" | "starting";
  readonly profile: SessionCardMeta | null;
  readonly route: CardRoute;
  readonly correlation: Pick<DiagnosticCorrelation, "runtimeSequence" | "promptSequence">;
  readonly tokens: PromptCardTokenFactory;
  readonly delivery: PromptCardControllerDelivery;
  readonly diagnostics: LifecycleDiagnosticSink;
  readonly deliveryContext?: CardDeliveryContext;
  readonly acknowledgement?: AcknowledgementPort;
  readonly cancel?: () => void;
  readonly revokeAction?: (actionToken: ActionToken) => void;
  readonly expirePermission?: (
    promptToken: PromptToken,
    permissionToken: PermissionToken,
    reason: TerminalOutcome,
  ) => Promise<void>;
  readonly reconcilePermissionArtifact?: (
    cardId: string,
    promptToken: PromptToken,
    permissionToken: PermissionToken,
    reason: string,
  ) => Promise<void>;
  readonly timers?: PromptCardTimerPort;
  readonly now?: () => number;
  readonly flushDelayMs?: number;
  readonly permissionTimeoutMs?: number;
}

type MutablePendingPermission = PendingPermission & {
  settled: boolean;
  resolve(response: acp.RequestPermissionResponse): void;
  timeoutHandle?: unknown;
};

const CANCELLED_PERMISSION: acp.RequestPermissionResponse = {
  outcome: { outcome: "cancelled" },
};

const SYSTEM_TIMERS: PromptCardTimerPort = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PromptCardController {
  private state: PromptLifecycleState;
  private readonly promptToken: PromptToken;
  private readonly timers: PromptCardTimerPort;
  private readonly flushDelayMs: number;
  private flushHandle: unknown | undefined;
  private readonly effects = new Set<Promise<void>>();
  private readonly pendingPermissions = new Map<PermissionToken, MutablePendingPermission>();
  private currentPermission: MutablePendingPermission | undefined;
  private readonly consumedActions = new Set<ActionToken>();
  private authoritativeRenderSubmitted = false;
  private visibleCardObserved = false;
  private readonly handoffSuccessors = new Map<OwnershipToken, OwnershipToken>();
  private segmentSequence = 1;
  private ownerSequence = 1;

  constructor(private readonly options: PromptCardControllerOptions) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.flushDelayMs = options.flushDelayMs ?? 100;
    this.promptToken = options.tokens.prompt();
    const segmentToken = options.tokens.segment();
    const ownershipToken = options.tokens.ownership();
    this.state = createPromptLifecycle({
      promptToken: this.promptToken,
      initialSegmentToken: segmentToken,
      ownershipToken,
      initialPhase: options.initialPhase,
      profile: options.profile,
      route: options.route,
      correlation: {
        ...options.correlation,
        segmentSequence: this.segmentSequence,
      },
    });
    options.delivery.createOwner(
      options.deliveryContext ?? {},
      this.correlation(this.segmentSequence, this.ownerSequence),
      ownershipToken,
    );
  }

  acknowledge(input: { messageId: string; reactionId?: string }): void {
    if (input.reactionId !== undefined) {
      if (this.state.phase === "terminal") {
        this.removeAcknowledgement(input.messageId, input.reactionId);
        return;
      }
      this.dispatch({
        type: "prompt_acknowledged",
        promptToken: this.promptToken,
        messageId: input.messageId,
        reactionId: input.reactionId,
      });
      return;
    }
    if (this.options.acknowledgement === undefined) return;
    this.track(
      this.options.acknowledgement.add(input.messageId).then((reactionId) => {
        this.recordAcknowledgement("add", reactionId === null ? "failed" : "attached");
        if (reactionId !== null) {
          if (this.state.phase === "terminal") {
            this.removeAcknowledgement(input.messageId, reactionId);
          } else {
            this.dispatch({
              type: "prompt_acknowledged",
              promptToken: this.promptToken,
              messageId: input.messageId,
              reactionId,
            });
          }
        }
      }),
    );
  }

  markQueued(): void {
    this.dispatch({ type: "queued", promptToken: this.promptToken });
  }

  markInterrupting(): void {
    this.dispatch({ type: "interrupting", promptToken: this.promptToken });
  }

  markPreparing(profile: SessionCardMeta | null): void {
    const segmentToken = this.currentSegment();
    if (segmentToken === null) return;
    this.dispatch({ type: "preparing", promptToken: this.promptToken, segmentToken, profile });
  }

  markForwarded(): {
    promptToken: PromptToken;
    segmentToken: SegmentToken;
    actionToken: ActionToken;
  } {
    const segmentToken = this.currentSegment();
    if (segmentToken === null) throw new Error("cannot forward without a current segment");
    const actionToken = this.options.tokens.action();
    this.dispatch({
      type: "forwarded",
      promptToken: this.promptToken,
      segmentToken,
      actionToken,
    });
    return { promptToken: this.promptToken, segmentToken, actionToken };
  }

  applyAgentUpdate(update: acp.SessionNotification["update"]): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const segmentToken = this.currentSegment();
        if (segmentToken === null) return;
        this.dispatch({
          type: update.sessionUpdate === "agent_message_chunk" ? "agent_text" : "agent_thought",
          promptToken: this.promptToken,
          segmentToken,
          text: update.content.text,
        });
        return;
      }
      case "tool_call":
        this.applyToolUpdate("tool_started", update);
        return;
      case "tool_call_update":
        this.applyToolUpdate("tool_updated", update);
        return;
      default:
        return;
    }
  }

  requestPermission(input: {
    requestId: string;
    params: acp.RequestPermissionRequest;
  }): PendingPermission {
    this.validatePermissionRequest(input);
    if (this.currentPermission !== undefined && !this.currentPermission.settled) {
      this.settlePermission(this.currentPermission, CANCELLED_PERMISSION, true);
    }
    if (this.state.phase !== "active") throw new Error("permission requires an active prompt");

    const permissionToken = this.options.tokens.permission();
    let resolve!: (response: acp.RequestPermissionResponse) => void;
    const response = new Promise<acp.RequestPermissionResponse>((settle) => {
      resolve = settle;
    });
    const allowedOptionIds = immutableSet(input.params.options.map((option) => option.optionId));
    const pending: MutablePendingPermission = {
      promptToken: this.promptToken,
      permissionToken,
      requestId: input.requestId,
      allowedOptionIds,
      response,
      settled: false,
      resolve,
    };
    this.pendingPermissions.set(permissionToken, pending);
    this.currentPermission = pending;
    if (this.options.permissionTimeoutMs !== undefined) {
      pending.timeoutHandle = this.timers.setTimeout(() => {
        if (this.settlePermission(pending, CANCELLED_PERMISSION, true)) {
          this.recordController("permission_timeout", "timeout");
        }
      }, this.options.permissionTimeoutMs);
    }

    const permission: PermissionViewData = {
      requestId: input.requestId,
      title: input.params.toolCall.title ?? "Permission required",
      toolKind: input.params.toolCall.kind ?? "other",
      toolTitle: input.params.toolCall.title ?? "Tool",
      options: input.params.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
    };
    this.dispatch({
      type: "permission_requested",
      promptToken: this.promptToken,
      segmentToken: this.state.segmentToken,
      permissionToken,
      permission,
    });
    return pending;
  }

  consumePermission(input: {
    promptToken: PromptToken;
    permissionToken: PermissionToken;
    requestId: string;
    optionId: string;
  }): "accepted" | "stale" | "duplicate" | "invalid_option" {
    const pending = this.pendingPermissions.get(input.permissionToken);
    if (
      pending === undefined ||
      input.promptToken !== this.promptToken ||
      pending.requestId !== input.requestId
    ) {
      return "stale";
    }
    if (pending.settled) return "duplicate";
    if (!pending.allowedOptionIds.has(input.optionId)) return "invalid_option";
    this.settlePermission(
      pending,
      { outcome: { outcome: "selected", optionId: input.optionId } },
      true,
    );
    return "accepted";
  }

  consumeCancel(input: {
    promptToken: PromptToken;
    segmentToken: SegmentToken;
    actionToken: ActionToken;
  }): "accepted" | "stale" | "duplicate" {
    if (this.consumedActions.has(input.actionToken)) return "duplicate";
    if (
      this.state.phase !== "active" ||
      input.promptToken !== this.promptToken ||
      input.segmentToken !== this.state.segmentToken ||
      input.actionToken !== this.state.actionToken
    ) {
      return "stale";
    }
    this.consumedActions.add(input.actionToken);
    this.cancelPendingPermissions("prompt_cancelled");
    this.options.cancel?.();
    return "accepted";
  }

  cancelPendingPermissions(
    _reason: "prompt_cancelled" | "route_closed" | "connection_shutdown",
  ): void {
    for (const pending of this.pendingPermissions.values()) {
      this.settlePermission(pending, CANCELLED_PERMISSION, false);
    }
  }

  finish(outcome: TerminalOutcome): void {
    this.cancelPendingPermissions(outcome === "cancelled" ? "prompt_cancelled" : "route_closed");
    this.dispatch({ type: "finish", promptToken: this.promptToken, outcome });
  }

  async awaitEffects(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new RangeError("timeout must be non-negative");
    const now = this.options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    while (this.effects.size > 0) {
      const remaining = Math.max(0, deadline - now());
      let timeoutHandle: unknown;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = this.timers.setTimeout(() => resolve("timeout"), remaining);
      });
      const outcome = await Promise.race([
        Promise.allSettled([...this.effects]).then(() => "settled" as const),
        timeout,
      ]);
      this.timers.clearTimeout(timeoutHandle);
      if (outcome === "timeout") {
        this.recordController("await_effects", "timeout");
        return;
      }
    }
  }

  private dispatch(event: ConversationCardEvent): void {
    const previous = this.state;
    const transition = reducePromptLifecycle(previous, event);
    this.state = transition.next;
    this.options.diagnostics.record({
      category: "transition",
      correlation: this.currentCorrelation(),
      from: transition.diagnostic.from,
      to: transition.diagnostic.to,
      event: transition.diagnostic.event,
      entryCount: transition.diagnostic.entryCount,
      utf8Bytes: transition.diagnostic.utf8Bytes,
      actionRevoked: transition.diagnostic.actionRevoked,
      ...(transition.diagnostic.staleReason === undefined
        ? {}
        : { staleReason: transition.diagnostic.staleReason }),
    });
    if (!this.state.render.flushScheduled) this.clearFlushTimer();
    for (const effect of transition.effects) this.runEffect(effect, previous);
  }

  private runEffect(effect: CardEffect, previous: PromptLifecycleState): void {
    switch (effect.type) {
      case "render":
        this.track(this.handleDelivery(effect.ownershipToken, effect.view));
        return;
      case "close": {
        const nextOwner =
          this.state.phase !== "terminal" && this.state.ownershipToken !== effect.ownershipToken
            ? this.state.ownershipToken
            : this.options.tokens.ownership();
        this.ownerSequence += 1;
        const successor = this.options.delivery.close(
          effect.ownershipToken,
          effect.view,
          this.correlation(this.segmentSequence, this.ownerSequence),
          nextOwner,
        );
        if (previous.phase === "active" && this.state.phase === "awaiting_permission") {
          this.handoffSuccessors.set(effect.ownershipToken, successor);
        }
        return;
      }
      case "schedule_flush":
        if (this.flushHandle === undefined) {
          this.flushHandle = this.timers.setTimeout(() => {
            this.flushHandle = undefined;
            this.dispatch({
              type: "flush_due",
              promptToken: effect.promptToken,
              segmentToken: effect.segmentToken,
            });
          }, this.flushDelayMs);
        }
        return;
      case "begin_permission_handoff":
        this.track(this.handlePermissionHandoff(effect));
        return;
      case "remove_acknowledgement":
        this.removeAcknowledgement(effect.messageId, effect.reactionId);
        return;
      case "expire_permission": {
        const pending = this.pendingPermissions.get(effect.permissionToken);
        if (pending !== undefined) this.settlePermission(pending, CANCELLED_PERMISSION, false);
        if (this.options.expirePermission !== undefined) {
          this.track(
            this.options.expirePermission(
              effect.promptToken,
              effect.permissionToken,
              effect.reason,
            ),
          );
        }
        return;
      }
      case "reconcile_permission_artifact":
        if (this.options.reconcilePermissionArtifact !== undefined) {
          this.track(
            this.options.reconcilePermissionArtifact(
              effect.cardId,
              effect.promptToken,
              effect.permissionToken,
              effect.reason,
            ),
          );
        }
        return;
      case "revoke_action":
        this.consumedActions.add(effect.actionToken);
        this.options.revokeAction?.(effect.actionToken);
        return;
    }
  }

  private async handleDelivery(owner: OwnershipToken, view: ConversationCardView): Promise<void> {
    const result = await this.options.delivery.deliver(owner, view);
    if (result.outcome === "visible") {
      this.dispatch({
        type: "acknowledgement_visible",
        promptToken: this.promptToken,
        cardId: result.cardId,
      });
    } else if (result.outcome === "superseded") {
      await this.options.delivery.reconcileSuperseded(owner, result.cardId, {
        kind: "orphaned",
        header: "orphaned",
        entries: view.entries,
        reason: "superseded_send",
        route: view.route,
      });
    }
  }

  private async handlePermissionHandoff(
    effect: Extract<CardEffect, { type: "begin_permission_handoff" }>,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(effect.permissionToken);
    if (pending === undefined) return;
    const handoffOwner = this.handoffSuccessors.get(effect.ownershipToken) ?? effect.ownershipToken;
    const result = await this.options.delivery.handoffToPermission(handoffOwner, {
      promptToken: effect.promptToken,
      segmentToken: effect.segmentToken,
      permissionToken: effect.permissionToken,
      permission: effect.permission,
      reuseCard: previousEntriesEmpty(this.state),
      isCurrent: () =>
        !pending.settled &&
        this.state.phase === "awaiting_permission" &&
        this.state.permissionToken === effect.permissionToken,
    });
    if (result.outcome === "failed") this.settlePermission(pending, CANCELLED_PERMISSION, true);
    this.handoffSuccessors.delete(effect.ownershipToken);
  }

  private settlePermission(
    pending: MutablePendingPermission,
    response: acp.RequestPermissionResponse,
    resume: boolean,
  ): boolean {
    if (pending.settled) return false;
    pending.settled = true;
    if (pending.timeoutHandle !== undefined) this.timers.clearTimeout(pending.timeoutHandle);
    pending.resolve(response);
    if (
      resume &&
      this.state.phase === "awaiting_permission" &&
      this.state.permissionToken === pending.permissionToken
    ) {
      const nextSegmentToken = this.options.tokens.segment();
      const nextActionToken = this.options.tokens.action();
      const nextOwnershipToken = this.options.tokens.ownership();
      this.segmentSequence += 1;
      this.ownerSequence += 1;
      this.options.delivery.createOwner(
        this.options.deliveryContext ?? {},
        this.correlation(this.segmentSequence, this.ownerSequence),
        nextOwnershipToken,
      );
      this.dispatch({
        type: "permission_resolved",
        promptToken: this.promptToken,
        permissionToken: pending.permissionToken,
        nextSegmentToken,
        nextActionToken,
        nextOwnershipToken,
        nextProfile: this.options.profile,
      });
    }
    return true;
  }

  private applyToolUpdate(
    type: "tool_started" | "tool_updated",
    update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  ): void {
    const current = this.state.toolLedger[update.toolCallId];
    const status =
      update.status ?? current?.status ?? (type === "tool_started" ? "pending" : undefined);
    if (status === undefined) return;
    const tool: ToolEvent = {
      toolCallId: update.toolCallId,
      title: update.title ?? current?.title ?? "Tool",
      toolKind: update.kind ?? current?.toolKind ?? "other",
      status,
    };
    const displaySegmentToken = this.state.phase === "active" ? this.state.segmentToken : null;
    if (type === "tool_started") {
      if (displaySegmentToken === null) return;
      this.dispatch({ type, promptToken: this.promptToken, displaySegmentToken, tool });
    } else {
      this.dispatch({ type, promptToken: this.promptToken, displaySegmentToken, tool });
    }
  }

  private removeAcknowledgement(messageId: string, reactionId: string): void {
    const port = this.options.acknowledgement;
    if (port === undefined) {
      this.dispatch({ type: "acknowledgement_remove_failed", promptToken: this.promptToken });
      return;
    }
    this.recordAcknowledgement("remove", "pending");
    this.track(
      port.remove(messageId, reactionId).then((removed) => {
        this.recordAcknowledgement("remove", removed ? "removed" : "failed");
        this.dispatch({
          type: removed ? "acknowledgement_removed" : "acknowledgement_remove_failed",
          promptToken: this.promptToken,
        });
      }),
    );
  }

  private track(effect: Promise<unknown>): void {
    let tracked!: Promise<void>;
    tracked = effect
      .then(
        () => undefined,
        () => {
          this.recordController("effect", "rejected");
        },
      )
      .finally(() => {
        this.effects.delete(tracked);
      });
    this.effects.add(tracked);
  }

  private validatePermissionRequest(input: {
    requestId: string;
    params: acp.RequestPermissionRequest;
  }): void {
    if (input.requestId.length === 0) throw new TypeError("permission requestId must not be empty");
    if (input.params.options.length === 0)
      throw new TypeError("permission options must not be empty");
    const ids = input.params.options.map((option) => option.optionId);
    if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
      throw new TypeError("permission option ids must be non-empty and unique");
    }
  }

  private currentSegment(): SegmentToken | null {
    return this.state.phase === "awaiting_permission" || this.state.phase === "terminal"
      ? null
      : this.state.segmentToken;
  }

  private clearFlushTimer(): void {
    if (this.flushHandle === undefined) return;
    this.timers.clearTimeout(this.flushHandle);
    this.flushHandle = undefined;
  }

  private correlation(
    segmentSequence: number | null,
    ownerSequence: number | null,
  ): DiagnosticCorrelation {
    return { ...this.options.correlation, segmentSequence, ownerSequence };
  }

  private currentCorrelation(): DiagnosticCorrelation {
    return this.correlation(
      this.state.phase === "awaiting_permission" ? null : this.segmentSequence,
      this.ownerSequence,
    );
  }

  private recordAcknowledgement(
    operation: "add" | "remove",
    outcome: "pending" | "attached" | "removed" | "failed" | "skipped",
  ): void {
    this.options.diagnostics.record({
      category: "acknowledgement",
      correlation: this.currentCorrelation(),
      operation,
      outcome,
    });
  }

  private recordController(
    operation: "effect" | "await_effects" | "permission_timeout",
    outcome: "rejected" | "timeout",
  ): void {
    this.options.diagnostics.record({
      category: "controller",
      correlation: this.currentCorrelation(),
      operation,
      outcome,
    });
  }
}

function immutableSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  Object.defineProperties(set, {
    add: { value: undefined },
    delete: { value: undefined },
    clear: { value: undefined },
  });
  return Object.freeze(set);
}

function previousEntriesEmpty(state: PromptLifecycleState): boolean {
  if (state.phase !== "awaiting_permission") return false;
  const latest = state.archived.at(-1);
  return latest === undefined || latest.reason !== "permission_boundary";
}
