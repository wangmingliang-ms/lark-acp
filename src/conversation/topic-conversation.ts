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

export type ResponseActivity =
  | { readonly kind: "thinking" }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "calling_tool";
      readonly toolCallId: string;
      readonly title: string | null;
    }
  | { readonly kind: "responding" };

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

type TextTimelineEntry = Extract<TimelineEntry, { readonly kind: "text" | "thought" }>;
type ToolTimelineEntry = Extract<TimelineEntry, { readonly kind: "tool" }>;

const DEFAULT_TOOL_TITLE = "Tool";

function hasMeaningfulToolTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized.length > 0 && normalized !== DEFAULT_TOOL_TITLE;
}

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
  readonly terminalToolCallIds: readonly string[];
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

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

function cloneRequest(message: RequestMessage): RequestMessage {
  return Object.freeze({
    id: message.id,
    sourceMessageId: message.sourceMessageId,
    content: cloneUnknown(message.content),
  });
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

  get isEmpty(): boolean {
    return this.timeline.length === 0;
  }

  append(entry: TimelineEntry): void {
    if (entry.kind === "text" || entry.kind === "thought") {
      const last = this.timeline.at(-1);
      if (last?.kind === entry.kind) {
        this.timeline[this.timeline.length - 1] = { ...last, text: last.text + entry.text };
        return;
      }
    }
    if (entry.kind === "tool") {
      const index = this.timeline.length - 1;
      const last = this.timeline[index];
      if (last?.kind === "tool" && !hasMeaningfulToolTitle(last.title)) {
        this.timeline[index] = entry;
        return;
      }
    }
    this.timeline.push(entry);
  }

  replaceLastText(kind: TextTimelineEntry["kind"], text: string): void {
    const index = this.timeline.length - 1;
    const last = this.timeline[index];
    if (last?.kind !== kind) throw new Error(`tail does not end with ${kind}`);
    this.timeline[index] = { kind, text };
  }

  updateTool(
    toolCallId: string,
    update: {
      readonly title?: string;
      readonly status?: ToolTimelineEntry["status"];
    },
  ): boolean {
    const index = this.timeline.findIndex(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    if (index < 0) return false;
    const current = this.timeline[index];
    if (current?.kind !== "tool") throw new Error("tool index no longer references a tool");
    this.timeline[index] = {
      ...current,
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.status === undefined ? {} : { status: update.status }),
    };
    return true;
  }

  sealRunningTools(status: "continued" | "interrupted" = "continued"): void {
    for (let index = 0; index < this.timeline.length; index += 1) {
      const entry = this.timeline[index];
      if (entry?.kind !== "tool") continue;
      if (
        entry.status !== "pending" &&
        entry.status !== "in_progress" &&
        entry.status !== "continued"
      )
        continue;
      this.timeline[index] = { ...entry, status };
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
  private readonly terminalToolIds = new Set<string>();
  private profileValue: SessionCardMeta | null;

  constructor(
    readonly id: ResponseId,
    readonly token: ResponseToken,
    profile: SessionCardMeta | null,
    initialCardId: ResponseCardId,
    phase: "received" | "interrupting",
  ) {
    this.profileValue = profile;
    this.stateValue = { kind: "in_progress", phase, activity: { kind: "thinking" } };
    this.responseCards = [new ResponseCard(initialCardId, "initial")];
  }

  static fromSnapshot(snapshot: ResponseSnapshot): ResponseLifecycle {
    const first = snapshot.cards[0];
    if (first === undefined) throw new Error("response snapshot has no Card");
    const response = new ResponseLifecycle(
      snapshot.id,
      snapshot.token,
      snapshot.profile,
      first.id,
      "received",
    );
    response.stateValue = cloneUnknown(snapshot.state);
    response.responseCards.splice(
      0,
      response.responseCards.length,
      ...snapshot.cards.map((card) => new ResponseCard(card.id, card.reason, card.entries)),
    );
    for (const toolCallId of snapshot.terminalToolCallIds) {
      response.terminalToolIds.add(toolCallId);
    }
    return response;
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
    this.stateValue = { kind: "in_progress", phase, activity: { kind: "thinking" } };
  }

  setProfile(profile: SessionCardMeta | null): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects profile");
    this.profileValue = profile;
  }

  setActivity(activity: ResponseActivity): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects activity");
    this.stateValue = { ...this.stateValue, activity: cloneUnknown(activity) };
  }

  seal(outcome: TerminalOutcome): void {
    if (this.stateValue.kind === "terminal") return;
    for (const card of this.responseCards) card.sealRunningTools("interrupted");
    this.stateValue = { kind: "terminal", outcome };
  }

  rotate(cardId: ResponseCardId, reason: ResponseCardReason): ResponseCard {
    if (this.stateValue.kind === "terminal") throw new Error("cannot rotate a terminal response");
    this.tail.sealRunningTools();
    const successor = new ResponseCard(cardId, reason);
    this.responseCards.push(successor);
    return successor;
  }

  evictIntermediate(cardId: ResponseCardId): boolean {
    const index = this.responseCards.findIndex((card) => card.id === cardId);
    if (index < 0 || index === this.responseCards.length - 1) return false;
    this.responseCards.splice(index, 1);
    return true;
  }

  append(entry: TimelineEntry): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects updates");
    if (entry.kind === "tool" && (entry.status === "completed" || entry.status === "failed")) {
      if (this.terminalToolIds.has(entry.toolCallId)) return;
      this.terminalToolIds.add(entry.toolCallId);
    }
    this.tail.append(entry);
  }

  replaceTailText(kind: TextTimelineEntry["kind"], text: string): void {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects updates");
    this.tail.replaceLastText(kind, text);
  }

  updateTool(
    toolCallId: string,
    update: {
      readonly title?: string;
      readonly status?: ToolTimelineEntry["status"];
    },
  ): boolean {
    if (this.stateValue.kind === "terminal") throw new Error("terminal response rejects updates");
    for (let index = this.responseCards.length - 1; index >= 0; index -= 1) {
      const card = this.responseCards[index];
      if (card === undefined) continue;
      if (!card.updateTool(toolCallId, update)) continue;
      if (update.status === "completed" || update.status === "failed") {
        this.terminalToolIds.add(toolCallId);
      }
      return true;
    }
    return this.terminalToolIds.has(toolCallId);
  }

  snapshot(): ResponseSnapshot {
    const tailId = this.tail.id;
    return Object.freeze({
      id: this.id,
      token: this.token,
      state: Object.freeze({ ...this.stateValue }),
      profile: this.profileValue === null ? null : Object.freeze({ ...this.profileValue }),
      cards: Object.freeze(this.responseCards.map((card) => card.snapshot(card.id === tailId))),
      terminalToolCallIds: Object.freeze([...this.terminalToolIds]),
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
      request: cloneRequest(this.request),
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

  static fromSnapshot(snapshot: TopicConversationSnapshot): TopicConversation {
    const topic = new TopicConversation();
    topic.turns.push(
      ...snapshot.turns.map(
        (turn) =>
          new Turn(
            turn.id,
            cloneRequest(turn.request),
            ResponseLifecycle.fromSnapshot(turn.response),
          ),
      ),
    );
    topic.executionOwner = snapshot.executionOwnerResponseId;
    topic.cancel = { ...snapshot.cancelAuthority };
    topic.currentPermission =
      snapshot.permission === null
        ? null
        : {
            ...snapshot.permission,
            allowedOptionIds: new Set(snapshot.permission.allowedOptionIds),
          };
    topic.pendingBatchValue =
      snapshot.pendingBatch === null
        ? null
        : {
            messages: snapshot.pendingBatch.messages.map(cloneRequest),
            carrierResponseId: snapshot.pendingBatch.carrierResponseId,
            state: snapshot.pendingBatch.state,
          };
    topic.assertInvariants();
    return topic;
  }

  accept(input: AcceptTurnInput): ResponseId {
    this.assertUnique(input);
    if (this.pendingBatchValue?.state === "collecting") {
      return this.appendCollectingBatch(input);
    }
    if (this.pendingBatchValue?.state === "sealed") {
      throw new Error("cannot accept a new turn while a sealed batch is committing");
    }
    const provisionalOwner =
      this.executionOwner ??
      this.turns.find((turn) => turn.response.state.kind === "in_progress")?.response.id ??
      null;
    const phase = provisionalOwner === null ? "received" : "interrupting";
    const request = cloneRequest(input.request);
    const response = new ResponseLifecycle(
      input.responseId,
      input.responseToken,
      input.profile,
      input.initialCardId,
      phase,
    );
    this.turns.push(new Turn(input.turnId, request, response));
    if (provisionalOwner !== null) {
      this.expireCurrentPermissionFor(provisionalOwner);
      this.pendingBatchValue = {
        messages: [request],
        carrierResponseId: input.responseId,
        state: "collecting",
      };
    }
    this.assertInvariants();
    return input.responseId;
  }

  appendToInterruptBatch(input: AppendToBatchInput): ResponseId {
    if (this.pendingBatchValue?.state !== "collecting") throw new Error("no collecting batch");
    this.assertUnique(input);
    return this.appendCollectingBatch(input);
  }

  prepare(responseId: ResponseId): void {
    if (this.executionOwner !== null) throw new Error("cannot prepare while execution is owned");
    const batch = this.pendingBatchValue;
    if (batch !== null) {
      const provisionalOwner = this.turns.find((turn) => turn.response.state.kind === "in_progress")
        ?.response.id;
      const allowed =
        (batch.state === "sealed" && batch.carrierResponseId === responseId) ||
        (batch.state === "collecting" && provisionalOwner === responseId);
      if (!allowed) throw new Error("only the provisional owner or sealed carrier may prepare");
    }
    const response = this.response(responseId);
    if (response.state.kind !== "in_progress") throw new Error("terminal response cannot prepare");
    if (response.state.phase !== "received" && response.state.phase !== "interrupting") {
      throw new Error("response is not waiting to prepare");
    }
    response.transition("preparing");
    this.assertInvariants();
  }

  activate(responseId: ResponseId, token: ActionToken): void {
    if (this.executionOwner !== null) throw new Error("execution is already owned");
    const response = this.response(responseId);
    if (response.state.kind !== "in_progress" || response.state.phase !== "preparing") {
      throw new Error("only a preparing response may activate");
    }
    const batch = this.pendingBatchValue;
    if (batch !== null) {
      const provisionalOwner = this.turns.find(
        (turn) =>
          turn.response.state.kind === "in_progress" &&
          turn.response.id !== batch.carrierResponseId,
      )?.response.id;
      const allowed =
        (batch.state === "sealed" && batch.carrierResponseId === responseId) ||
        (batch.state === "collecting" && provisionalOwner === responseId);
      if (!allowed)
        throw new Error("only the provisional owner or sealed batch carrier may activate");
    }
    response.transition("active");
    this.executionOwner = responseId;
    this.cancel = { kind: "cancel", responseId, cardId: response.tail.id, token };
    this.collectPreActivationFollowups(responseId);
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

  evictSettledIntermediate(responseId: ResponseId, cardId: ResponseCardId): boolean {
    const response = this.response(responseId);
    const evicted = response.evictIntermediate(cardId);
    if (evicted) this.assertInvariants();
    return evicted;
  }

  /**
   * Compacts a terminal Response after the delivery layer has proved its final
   * tail settled. Domain guards still reject owned, permission-bound, or batch-
   * carrying Responses; callers must supply the delivery-settled precondition.
   */
  evictTerminalAfterDeliverySettled(responseId: ResponseId): boolean {
    if (this.executionOwner === responseId) return false;
    if (this.pendingBatchValue?.carrierResponseId === responseId) return false;
    if (this.currentPermission?.responseId === responseId) return false;
    const index = this.turns.findIndex((turn) => turn.response.id === responseId);
    if (index < 0) return false;
    const turn = this.turns[index];
    if (turn?.response.state.kind !== "terminal") return false;
    this.turns.splice(index, 1);
    this.assertInvariants();
    return true;
  }

  setProfile(responseId: ResponseId, profile: SessionCardMeta | null): void {
    this.response(responseId).setProfile(profile);
    this.assertInvariants();
  }

  setActivity(responseId: ResponseId, activity: ResponseActivity): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner has activity");
    this.response(responseId).setActivity(activity);
    this.assertInvariants();
  }

  startToolActivity(responseId: ResponseId, toolCallId: string, title: string | null): void {
    this.setActivity(responseId, { kind: "calling_tool", toolCallId, title });
  }

  updateToolActivity(responseId: ResponseId, toolCallId: string, title?: string): void {
    const response = this.response(responseId);
    const state = response.state;
    if (state.kind !== "in_progress") return;
    if (state.activity.kind === "calling_tool") {
      if (state.activity.toolCallId !== toolCallId) return;
      if (title === undefined) return;
      response.setActivity({ kind: "calling_tool", toolCallId, title });
    } else {
      response.setActivity({ kind: "calling_tool", toolCallId, title: title ?? null });
    }
    this.assertInvariants();
  }

  finishToolActivity(responseId: ResponseId, toolCallId: string): void {
    const response = this.response(responseId);
    const state = response.state;
    if (
      state.kind !== "in_progress" ||
      state.activity.kind !== "calling_tool" ||
      state.activity.toolCallId !== toolCallId
    )
      return;
    response.setActivity({ kind: "thinking" });
    this.assertInvariants();
  }

  append(responseId: ResponseId, entry: TimelineEntry): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner accepts updates");
    this.response(responseId).append(entry);
  }

  replaceTailText(responseId: ResponseId, kind: TextTimelineEntry["kind"], text: string): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner accepts updates");
    this.response(responseId).replaceTailText(kind, text);
  }

  updateTool(
    responseId: ResponseId,
    toolCallId: string,
    update: {
      readonly title?: string;
      readonly status?: ToolTimelineEntry["status"];
    },
  ): boolean {
    if (this.executionOwner !== responseId) throw new Error("only execution owner accepts updates");
    return this.response(responseId).updateTool(toolCallId, update);
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
    if (response.tail.isEmpty) {
      response.append({ kind: "notice", text: "等待权限处理完成。" });
    }
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

  expirePermission(permissionToken: PermissionToken): "accepted" | "stale" {
    const permission = this.currentPermission;
    if (
      permission === null ||
      permission.status !== "current" ||
      permission.token !== permissionToken
    ) {
      return "stale";
    }
    this.currentPermission = { ...permission, status: "expired" };
    const response = this.response(permission.responseId);
    if (response.state.kind === "in_progress" && response.state.phase === "awaiting_permission") {
      response.transition("active");
    }
    this.assertInvariants();
    return "accepted";
  }

  beginPermissionDisplayFailure(responseId: ResponseId): void {
    const permission = this.currentPermission;
    if (permission !== null && permission.responseId === responseId) {
      this.currentPermission = { ...permission, status: "display_failed" };
    }
    const response = this.response(responseId);
    response.append({
      kind: "notice",
      text: "权限请求无法显示，正在停止本次执行。",
    });
    this.revokeCancelFor(responseId);
    this.assertInvariants();
  }

  failWaiting(responseId: ResponseId, text: string): void {
    if (this.executionOwner === responseId)
      throw new Error("execution owner must use the owner terminal path");
    const response = this.response(responseId);
    if (response.state.kind === "terminal") return;
    response.append({ kind: "notice", text });
    response.seal("failed");
    const batch = this.pendingBatchValue;
    if (batch?.carrierResponseId === responseId) this.pendingBatchValue = null;
    this.assertInvariants();
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
    if (
      this.currentPermission?.status === "current" &&
      this.currentPermission.responseId === input.responseId
    ) {
      this.currentPermission = { ...this.currentPermission, status: "expired" };
    }
    this.assertInvariants();
    return "accepted";
  }

  dropMergedBatchMember(responseId: ResponseId): void {
    const batch = this.pendingBatchValue;
    if (batch === null) return;
    if (batch.carrierResponseId === responseId) {
      throw new Error("cannot drop the current pending batch carrier");
    }
    const turn = this.turns.find((candidate) => candidate.response.id === responseId);
    if (turn === undefined) throw new Error(`unknown response ${responseId}`);
    if (turn.response.state.kind !== "terminal" || turn.response.state.outcome !== "merged") {
      throw new Error("only a merged pending batch member may be dropped");
    }
    const index = batch.messages.findIndex((request) => request.id === turn.request.id);
    if (index < 0) return;
    batch.messages.splice(index, 1);
    this.assertInvariants();
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

  sealOwnerForPendingBatch(
    outcome: Exclude<TerminalOutcome, "merged">,
  ): PendingRequestBatchSnapshot {
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

  interruptTopic(): readonly ResponseId[] {
    const interrupted: ResponseId[] = [];
    this.pendingBatchValue = null;
    this.cancel = { kind: "none" };
    for (const response of this.turns.map((turn) => turn.response)) {
      if (response.state.kind !== "in_progress") continue;
      response.seal("interrupted");
      interrupted.push(response.id);
    }
    this.executionOwner = null;
    if (this.currentPermission?.status === "current") {
      this.currentPermission = { ...this.currentPermission, status: "expired" };
    }
    this.assertInvariants();
    return Object.freeze(interrupted);
  }

  beginTopicCancel(): ResponseId | null {
    const owner = this.executionOwner;
    const unfinishedWaiting = this.turns
      .map((turn) => turn.response)
      .filter((response) => response.id !== owner && response.state.kind === "in_progress");
    this.pendingBatchValue = null;
    this.cancel = { kind: "none" };
    for (const response of unfinishedWaiting) response.seal("cancelled");
    if (this.currentPermission?.status === "current") {
      this.currentPermission = { ...this.currentPermission, status: "expired" };
    }
    this.assertInvariants();
    return owner;
  }

  confirmTopicCancel(): void {
    const owner = this.executionOwner;
    if (owner !== null) this.seal(owner, "cancelled");
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
      messages: Object.freeze(batch.messages.map(cloneRequest)),
      carrierResponseId: batch.carrierResponseId,
      state: batch.state,
    });
  }

  private collectPreActivationFollowups(ownerId: ResponseId): void {
    if (this.pendingBatchValue !== null) return;
    const ownerIndex = this.turns.findIndex((turn) => turn.response.id === ownerId);
    if (ownerIndex < 0) return;
    const waiting = this.turns.slice(ownerIndex + 1).filter((turn) => {
      const state = turn.response.state;
      return state.kind === "in_progress" && state.phase === "received";
    });
    if (waiting.length === 0) return;
    for (let index = 0; index < waiting.length; index += 1) {
      const turn = waiting[index];
      if (turn === undefined) continue;
      turn.response.transition("interrupting");
      if (index < waiting.length - 1) turn.response.seal("merged");
    }
    this.pendingBatchValue = {
      messages: waiting.map((turn) => cloneRequest(turn.request)),
      carrierResponseId: waiting.at(-1)!.response.id,
      state: "collecting",
    };
  }

  private appendCollectingBatch(input: AppendToBatchInput): ResponseId {
    const batch = this.pendingBatchValue;
    if (batch === null || batch.state !== "collecting") throw new Error("no collecting batch");
    const previousCarrier = this.response(batch.carrierResponseId);
    previousCarrier.seal("merged");
    const request = cloneRequest(input.request);
    const response = new ResponseLifecycle(
      input.responseId,
      input.responseToken,
      input.profile,
      input.initialCardId,
      "interrupting",
    );
    this.turns.push(new Turn(input.turnId, request, response));
    batch.messages.push(request);
    batch.carrierResponseId = input.responseId;
    this.assertInvariants();
    return input.responseId;
  }

  private expireCurrentPermissionFor(responseId: ResponseId): void {
    const permission = this.currentPermission;
    if (
      permission === null ||
      permission.responseId !== responseId ||
      permission.status !== "current"
    ) {
      return;
    }
    this.currentPermission = { ...permission, status: "expired" };
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
