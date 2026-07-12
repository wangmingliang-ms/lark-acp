import type { SessionCardMeta } from "../presenter/presenter.js";

export type TurnId = string & { readonly __brand: "TurnId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type ResponseId = string & { readonly __brand: "ResponseId" };
export type ResponseCardId = string & { readonly __brand: "ResponseCardId" };
export type ResponseToken = string & { readonly __brand: "ResponseToken" };
export type ActionToken = string & { readonly __brand: "ActionToken" };
export type PermissionToken = string & { readonly __brand: "PermissionToken" };

export interface RequestMessage {
  readonly id: RequestId;
  readonly sourceMessageId: string;
  readonly content: unknown;
}

export type ResponsePhase =
  "received" | "interrupting" | "preparing" | "active" | "awaiting_permission";

export type TerminalOutcome = "complete" | "failed" | "interrupted" | "cancelled" | "merged";

export type ResponseActivity = "thinking" | "waiting" | "calling_tool" | "responding";

export type ResponseState =
  | {
      readonly kind: "in_progress";
      readonly phase: ResponsePhase;
      readonly activity: ResponseActivity;
    }
  | { readonly kind: "terminal"; readonly outcome: TerminalOutcome };

export type ResponseCardReason =
  | "initial"
  | "content_rotation"
  | "idle_rotation"
  | "permission_continuation"
  | "transport_replacement";

export type TimelineEntry =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly title: string;
      readonly status:
        "pending" | "in_progress" | "continued" | "completed" | "failed" | "interrupted";
    }
  | { readonly kind: "notice"; readonly text: string };

export interface PermissionArtifact {
  readonly token: PermissionToken;
  readonly responseId: ResponseId;
  readonly requestId: string;
  readonly allowedOptionIds: ReadonlySet<string>;
  readonly status: "current" | "resolved" | "expired" | "display_failed";
}

export interface ResponseCardSnapshot {
  readonly id: ResponseCardId;
  readonly reason: ResponseCardReason;
  readonly entries: readonly TimelineEntry[];
  readonly isTail: boolean;
}

export interface ResponseSnapshot {
  readonly id: ResponseId;
  readonly token: ResponseToken;
  readonly state: ResponseState;
  readonly profile: SessionCardMeta | null;
  readonly cards: readonly ResponseCardSnapshot[];
}

export interface TurnSnapshot {
  readonly id: TurnId;
  readonly request: RequestMessage;
  readonly response: ResponseSnapshot;
}

export type CancelAuthority =
  | { readonly kind: "none" }
  | {
      readonly kind: "cancel";
      readonly responseId: ResponseId;
      readonly cardId: ResponseCardId;
      readonly token: ActionToken;
    };

export interface PendingRequestBatchSnapshot {
  readonly messages: readonly RequestMessage[];
  readonly carrierResponseId: ResponseId;
  readonly state: "collecting" | "sealed";
}

export interface TopicConversationSnapshot {
  readonly turns: readonly TurnSnapshot[];
  readonly executionOwnerResponseId: ResponseId | null;
  readonly cancelAuthority: CancelAuthority;
  readonly permission: PermissionArtifact | null;
  readonly pendingBatch: PendingRequestBatchSnapshot | null;
}

export interface CardProjection {
  readonly responseId: ResponseId;
  readonly cardId: ResponseCardId;
  readonly kind: "intermediate" | "tail";
  readonly state: ResponseState;
  readonly entries: readonly TimelineEntry[];
  readonly titleVisible: boolean;
  readonly metadata: SessionCardMeta | null;
  readonly cancelAction: null | {
    readonly responseToken: ResponseToken;
    readonly cardId: ResponseCardId;
    readonly actionToken: ActionToken;
  };
}

class ResponseCard {
  private readonly timeline: TimelineEntry[];

  constructor(
    readonly id: ResponseCardId,
    readonly reason: ResponseCardReason,
    entries: readonly TimelineEntry[] = [],
  ) {
    this.timeline = [...entries];
  }

  append(entry: TimelineEntry): void {
    this.timeline.push(entry);
  }

  sealRunningTools(): void {
    for (let index = 0; index < this.timeline.length; index += 1) {
      const entry = this.timeline[index];
      if (entry?.kind !== "tool") continue;
      if (entry.status !== "pending" && entry.status !== "in_progress") continue;
      this.timeline[index] = { ...entry, status: "continued" };
    }
  }

  snapshot(isTail: boolean): ResponseCardSnapshot {
    return Object.freeze({
      id: this.id,
      reason: this.reason,
      entries: Object.freeze(this.timeline.map((entry) => Object.freeze({ ...entry }))),
      isTail,
    });
  }
}

class ResponseLifecycle {
  private stateValue: ResponseState;
  private readonly responseCards: ResponseCard[];

  constructor(
    readonly id: ResponseId,
    readonly token: ResponseToken,
    readonly profile: SessionCardMeta | null,
    initialCardId: ResponseCardId,
    phase: "received" | "interrupting",
  ) {
    this.stateValue = { kind: "in_progress", phase, activity: "thinking" };
    this.responseCards = [new ResponseCard(initialCardId, "initial")];
  }

  get state(): ResponseState {
    return this.stateValue;
  }

  get tail(): ResponseCard {
    const card = this.responseCards.at(-1);
    if (card === undefined) throw new Error("response must have a tail card");
    return card;
  }

  transition(phase: ResponsePhase): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response is absorbing");
    this.stateValue = { kind: "in_progress", phase, activity: "thinking" };
  }

  setActivity(activity: ResponseActivity): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects activity");
    this.stateValue = { ...this.stateValue, activity };
  }

  seal(outcome: TerminalOutcome): void {
    if (this.stateValue.kind === "terminal") return;
    this.stateValue = { kind: "terminal", outcome };
  }

  rotate(cardId: ResponseCardId, reason: ResponseCardReason): ResponseCard {
    if (this.stateValue.kind === "terminal") throw new Error("cannot rotate a terminal response");
    this.tail.sealRunningTools();
    const successor = new ResponseCard(cardId, reason);
    this.responseCards.push(successor);
    return successor;
  }

  append(entry: TimelineEntry): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects updates");
    this.tail.append(entry);
  }

  snapshot(): ResponseSnapshot {
    const tailId = this.tail.id;
    return Object.freeze({
      id: this.id,
      token: this.token,
      state: Object.freeze({ ...this.stateValue }),
      profile: this.profile === null ? null : Object.freeze({ ...this.profile }),
      cards: Object.freeze(this.responseCards.map((card) => card.snapshot(card.id === tailId))),
    });
  }
}

class Turn {
  constructor(
    readonly id: TurnId,
    readonly request: RequestMessage,
    readonly response: ResponseLifecycle,
  ) {}

  snapshot(): TurnSnapshot {
    return Object.freeze({
      id: this.id,
      request: Object.freeze({ ...this.request }),
      response: this.response.snapshot(),
    });
  }
}

export interface AcceptTurnInput {
  readonly turnId: TurnId;
  readonly request: RequestMessage;
  readonly responseId: ResponseId;
  readonly responseToken: ResponseToken;
  readonly initialCardId: ResponseCardId;
  readonly profile: SessionCardMeta | null;
}

export interface AppendToBatchInput extends AcceptTurnInput {}

export class TopicConversation {
  private readonly turns: Turn[] = [];
  private executionOwner: ResponseId | null = null;
  private cancel: CancelAuthority = { kind: "none" };
  private currentPermission: PermissionArtifact | null = null;
  private pendingBatchValue: {
    messages: RequestMessage[];
    carrierResponseId: ResponseId;
    state: "collecting" | "sealed";
  } | null = null;

  accept(input: AcceptTurnInput): ResponseId {
    this.assertUnique(input);
    const phase = this.executionOwner === null ? "received" : "interrupting";
    const response = new ResponseLifecycle(
      input.responseId,
      input.responseToken,
      input.profile,
      input.initialCardId,
      phase,
    );
    this.turns.push(new Turn(input.turnId, input.request, response));
    if (this.executionOwner !== null) {
      this.pendingBatchValue = {
        messages: [input.request],
        carrierResponseId: input.responseId,
        state: "collecting",
      };
    }
    this.assertInvariants();
    return input.responseId;
  }

  appendToInterruptBatch(input: AppendToBatchInput): ResponseId {
    const batch = this.pendingBatchValue;
    if (batch === null || batch.state !== "collecting") throw new Error("no collecting batch");
    const previousCarrier = this.response(batch.carrierResponseId);
    previousCarrier.seal("merged");
    const response = new ResponseLifecycle(
      input.responseId,
      input.responseToken,
      input.profile,
      input.initialCardId,
      "interrupting",
    );
    this.turns.push(new Turn(input.turnId, input.request, response));
    batch.messages.push(input.request);
    batch.carrierResponseId = input.responseId;
    this.assertInvariants();
    return input.responseId;
  }

  prepare(responseId: ResponseId): void {
    if (this.executionOwner !== null) throw new Error("cannot prepare while execution is owned");
    this.response(responseId).transition("preparing");
    this.assertInvariants();
  }

  activate(responseId: ResponseId, token: ActionToken): void {
    if (this.executionOwner !== null) throw new Error("execution is already owned");
    const response = this.response(responseId);
    response.transition("active");
    this.executionOwner = responseId;
    this.cancel = { kind: "cancel", responseId, cardId: response.tail.id, token };
    this.assertInvariants();
  }

  rotateTail(
    responseId: ResponseId,
    cardId: ResponseCardId,
    reason: ResponseCardReason,
    nextActionToken: ActionToken | null,
  ): void {
    const response = this.response(responseId);
    this.revokeCancelFor(responseId);
    response.rotate(cardId, reason);
    if (
      nextActionToken !== null &&
      this.executionOwner === responseId &&
      response.state.kind === "in_progress" &&
      (response.state.phase === "active" || response.state.phase === "awaiting_permission")
    ) {
      this.cancel = { kind: "cancel", responseId, cardId, token: nextActionToken };
    }
    this.assertInvariants();
  }

  setActivity(responseId: ResponseId, activity: ResponseActivity): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner has activity");
    this.response(responseId).setActivity(activity);
    this.assertInvariants();
  }

  append(responseId: ResponseId, entry: TimelineEntry): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner accepts updates");
    this.response(responseId).append(entry);
  }

  requestPermission(input: {
    responseId: ResponseId;
    permissionToken: PermissionToken;
    requestId: string;
    allowedOptionIds: ReadonlySet<string>;
    continuationCardId: ResponseCardId;
    continuationActionToken: ActionToken;
  }): void {
    if (this.executionOwner !== input.responseId) throw new Error("permission requires owner");
    if (this.currentPermission?.status === "current") throw new Error("permission already current");
    const response = this.response(input.responseId);
    this.rotateTail(input.responseId, input.continuationCardId, "permission_continuation", null);
    response.transition("awaiting_permission");
    this.currentPermission = {
      token: input.permissionToken,
      responseId: input.responseId,
      requestId: input.requestId,
      allowedOptionIds: new Set(input.allowedOptionIds),
      status: "current",
    };
    this.cancel = {
      kind: "cancel",
      responseId: input.responseId,
      cardId: response.tail.id,
      token: input.continuationActionToken,
    };
    this.assertInvariants();
  }

  resolvePermission(permissionToken: PermissionToken, optionId: string): "accepted" | "stale" {
    const permission = this.currentPermission;
    if (
      permission === null ||
      permission.status !== "current" ||
      permission.token !== permissionToken ||
      !permission.allowedOptionIds.has(optionId)
    ) {
      return "stale";
    }
    this.currentPermission = { ...permission, status: "resolved" };
    this.response(permission.responseId).transition("active");
    return "accepted";
  }

  revokePermissionForInterrupt(responseId: ResponseId): void {
    const permission = this.currentPermission;
    if (
      permission === null ||
      permission.responseId !== responseId ||
      permission.status !== "current"
    )
      return;
    this.currentPermission = { ...permission, status: "expired" };
    this.assertInvariants();
  }

  permissionDisplayFailed(responseId: ResponseId): void {
    const permission = this.currentPermission;
    if (permission !== null && permission.responseId === responseId) {
      this.currentPermission = { ...permission, status: "display_failed" };
    }
    this.seal(responseId, "failed");
  }

  seal(responseId: ResponseId, outcome: TerminalOutcome): void {
    const response = this.response(responseId);
    response.seal(outcome);
    this.revokeCancelFor(responseId);
    if (this.executionOwner === responseId) this.executionOwner = null;
    if (
      this.currentPermission?.responseId === responseId &&
      this.currentPermission.status === "current"
    ) {
      this.currentPermission = { ...this.currentPermission, status: "expired" };
    }
    this.assertInvariants();
  }

  consumeCardCancel(input: {
    responseId: ResponseId;
    cardId: ResponseCardId;
    token: ActionToken;
  }): "accepted" | "stale" {
    const authority = this.cancel;
    if (
      authority.kind !== "cancel" ||
      authority.responseId !== input.responseId ||
      authority.cardId !== input.cardId ||
      authority.token !== input.token
    ) {
      return "stale";
    }
    this.cancel = { kind: "none" };
    this.assertInvariants();
    return "accepted";
  }

  commitPendingBatchAfterOwnerEnded(): PendingRequestBatchSnapshot {
    if (this.executionOwner !== null) throw new Error("execution owner has not ended");
    const batch = this.pendingBatchValue;
    if (batch === null || batch.state !== "collecting") {
      throw new Error("collecting batch is not pending");
    }
    batch.state = "sealed";
    this.assertInvariants();
    return this.batchSnapshot(batch);
  }

  sealOwnerForPendingBatch(outcome: "interrupted" | "cancelled"): PendingRequestBatchSnapshot {
    const owner = this.executionOwner;
    const batch = this.pendingBatchValue;
    if (owner === null || batch === null || batch.state !== "collecting") {
      throw new Error("interrupt handoff is not pending");
    }
    this.seal(owner, outcome);
    return this.commitPendingBatchAfterOwnerEnded();
  }

  clearSealedBatch(): void {
    if (this.pendingBatchValue?.state !== "sealed") throw new Error("batch is not sealed");
    this.pendingBatchValue = null;
  }

  cancelTopic(): void {
    const unfinished = this.turns
      .map((turn) => turn.response)
      .filter((response) => response.state.kind === "in_progress");
    this.pendingBatchValue = null;
    this.cancel = { kind: "none" };
    this.executionOwner = null;
    for (const response of unfinished) response.seal("cancelled");
    if (this.currentPermission?.status === "current") {
      this.currentPermission = { ...this.currentPermission, status: "expired" };
    }
    this.assertInvariants();
  }

  snapshot(): TopicConversationSnapshot {
    const snapshot: TopicConversationSnapshot = {
      turns: Object.freeze(this.turns.map((turn) => turn.snapshot())),
      executionOwnerResponseId: this.executionOwner,
      cancelAuthority: Object.freeze({ ...this.cancel }),
      permission:
        this.currentPermission === null
          ? null
          : Object.freeze({
              ...this.currentPermission,
              allowedOptionIds: new Set(this.currentPermission.allowedOptionIds),
            }),
      pendingBatch:
        this.pendingBatchValue === null ? null : this.batchSnapshot(this.pendingBatchValue),
    };
    return Object.freeze(snapshot);
  }

  private batchSnapshot(batch: {
    messages: RequestMessage[];
    carrierResponseId: ResponseId;
    state: "collecting" | "sealed";
  }): PendingRequestBatchSnapshot {
    return Object.freeze({
      messages: Object.freeze(batch.messages.map((message) => Object.freeze({ ...message }))),
      carrierResponseId: batch.carrierResponseId,
      state: batch.state,
    });
  }

  private response(id: ResponseId): ResponseLifecycle {
    const response = this.turns.find((turn) => turn.response.id === id)?.response;
    if (response === undefined) throw new Error(`unknown response: ${id}`);
    return response;
  }

  private revokeCancelFor(responseId: ResponseId): void {
    if (this.cancel.kind === "cancel" && this.cancel.responseId === responseId) {
      this.cancel = { kind: "none" };
    }
  }

  private assertUnique(input: AcceptTurnInput): void {
    if (this.turns.some((turn) => turn.id === input.turnId)) throw new Error("duplicate turn id");
    if (this.turns.some((turn) => turn.response.id === input.responseId))
      throw new Error("duplicate response id");
  }

  private assertInvariants(): void {
    const snapshots = this.turns.map((turn) => turn.response.snapshot());
    for (const response of snapshots) {
      if (response.cards.length === 0) throw new Error("response has no Card");
      if (response.cards.filter((card) => card.isTail).length !== 1)
        throw new Error("response must have exactly one tail Card");
    }
    if (this.executionOwner !== null) {
      const owner = this.response(this.executionOwner);
      if (owner.state.kind !== "in_progress") throw new Error("terminal response owns execution");
      if (owner.state.phase !== "active" && owner.state.phase !== "awaiting_permission") {
        throw new Error("execution owner is not active");
      }
    }
    if (this.cancel.kind === "cancel") {
      const response = this.response(this.cancel.responseId);
      if (this.executionOwner !== response.id)
        throw new Error("Cancel owner is not execution owner");
      if (response.tail.id !== this.cancel.cardId)
        throw new Error("Cancel is not bound to tail Card");
      if (response.state.kind !== "in_progress") throw new Error("terminal response owns Cancel");
    }
    const batch = this.pendingBatchValue;
    if (batch !== null) {
      const carrier = this.response(batch.carrierResponseId);
      if (carrier.state.kind === "terminal") throw new Error("terminal Response carries batch");
      if (batch.messages.length === 0) throw new Error("pending batch is empty");
    }
  }
}

export class ResponseCardProjector {
  project(
    topic: TopicConversationSnapshot,
    responseId: ResponseId,
    cardId: ResponseCardId,
  ): CardProjection {
    const response = topic.turns.find((turn) => turn.response.id === responseId)?.response;
    if (response === undefined) throw new Error(`unknown response: ${responseId}`);
    const card = response.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined) throw new Error(`unknown card: ${cardId}`);
    const authority = topic.cancelAuthority;
    const cancelAction =
      card.isTail &&
      response.state.kind === "in_progress" &&
      (response.state.phase === "active" || response.state.phase === "awaiting_permission") &&
      topic.executionOwnerResponseId === response.id &&
      authority.kind === "cancel" &&
      authority.responseId === response.id &&
      authority.cardId === card.id
        ? {
            responseToken: response.token,
            cardId: card.id,
            actionToken: authority.token,
          }
        : null;
    return Object.freeze({
      responseId,
      cardId,
      kind: card.isTail ? "tail" : "intermediate",
      state: response.state,
      entries: card.entries,
      titleVisible: card.isTail,
      metadata: card.isTail ? response.profile : null,
      cancelAction,
    });
  }
}
