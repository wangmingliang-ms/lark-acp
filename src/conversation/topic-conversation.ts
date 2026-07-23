import type { SessionCardMeta } from "../presenter/presenter.js";

export type TurnId = string & { readonly __brand: "TurnId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type ResponseId = string & { readonly __brand: "ResponseId" };
export type ResponseCardId = string & { readonly __brand: "ResponseCardId" };
export type SupplementCardId = string & { readonly __brand: "SupplementCardId" };
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
  /** Agent is busy but has produced no displayable content yet (just after a
   *  prompt is sent, or between a finished tool call and the next output).
   *  Distinct from {@link "thinking"}, which requires real thought content. */
  | { readonly kind: "processing" }
  /** Agent is streaming reasoning/thought content — only set when a non-empty
   *  thought chunk actually arrives, so the "思考中" status never lies. */
  | { readonly kind: "thinking" }
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

export type ImageEntryStatus = "uploading" | "ready" | "failed";

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
  | {
      /** An inline image rendered as a Lark card `img` element. `imgKey` is set
       *  once the bytes are uploaded (status "ready"); until then it renders a
       *  placeholder, and "failed" renders a text fallback. */
      readonly kind: "image";
      readonly imageId: string;
      readonly status: ImageEntryStatus;
      readonly imgKey?: string;
      readonly alt?: string;
      /** Text fallback shown when status is "failed" (never leaks local paths). */
      readonly fallback?: string;
    }
  | { readonly kind: "notice"; readonly text: string };

type TextTimelineEntry = Extract<TimelineEntry, { readonly kind: "text" | "thought" }>;
type ToolTimelineEntry = Extract<TimelineEntry, { readonly kind: "tool" }>;
type ImageTimelineEntry = Extract<TimelineEntry, { readonly kind: "image" }>;

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

/**
 * A neutral, ownerless post-turn Card. Supplement Cards are a Response-owned
 * collection separate from the primary `cards` tail chain: they never carry
 * Title/Metadata/Cancel semantics and never turn a terminal primary Card back
 * into an intermediate one. Only the last Supplement Card is writable; earlier
 * ones are frozen the same way an intermediate primary Card is frozen.
 */
export interface SupplementCardSnapshot {
  readonly id: SupplementCardId;
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
  readonly supplements: readonly SupplementCardSnapshot[];
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
  /**
   * The Response currently allowed to receive out-of-turn Supplement Card
   * updates, or `null` if no Response owns that window. Only a Response that
   * reached the `complete` terminal outcome may hold this; accepting any new
   * Turn revokes it synchronously.
   */
  readonly supplementOwnerResponseId: ResponseId | null;
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

/**
 * A Supplement Card projection never carries Title/Metadata/Cancel; it is a
 * fixed neutral projection of its entries only.
 */
export interface SupplementCardProjection {
  readonly responseId: ResponseId;
  readonly cardId: SupplementCardId;
  readonly entries: readonly TimelineEntry[];
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

interface CardSnapshot<Id extends string> {
  readonly id: Id;
  readonly reason: ResponseCardReason;
  readonly entries: readonly TimelineEntry[];
  readonly isTail: boolean;
}

/**
 * A single Card-local content segment. Both primary Response Cards and
 * Supplement Cards reuse this class for text-chunk coalescing, tool-status
 * monotonicity, and running-tool sealing; only the branded id type and the
 * collection they belong to differ.
 */
class ResponseCard<Id extends string = ResponseCardId> {
  private readonly timeline: TimelineEntry[];

  constructor(
    readonly id: Id,
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

  updateImage(
    imageId: string,
    update: {
      readonly status?: ImageTimelineEntry["status"];
      readonly imgKey?: string;
      readonly fallback?: string;
    },
  ): boolean {
    const index = this.timeline.findIndex(
      (entry) => entry.kind === "image" && entry.imageId === imageId,
    );
    if (index < 0) return false;
    const current = this.timeline[index];
    if (current?.kind !== "image") throw new Error("image index no longer references an image");
    this.timeline[index] = {
      ...current,
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.imgKey === undefined ? {} : { imgKey: update.imgKey }),
      ...(update.fallback === undefined ? {} : { fallback: update.fallback }),
    };
    return true;
  }

  /**
   * Replace this card's whole timeline with the result of `transform`, which
   * receives the current entries. Lets callers apply budget-aware, whole-card
   * rewrites (e.g. expand text around images while capping element count).
   * Mutates in place.
   */
  mapTimeline(transform: (entries: readonly TimelineEntry[]) => readonly TimelineEntry[]): void {
    const next = transform(this.timeline);
    this.timeline.splice(0, this.timeline.length, ...next);
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

  snapshot(isTail: boolean): CardSnapshot<Id> {
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
  private readonly supplementCards: ResponseCard<SupplementCardId>[] = [];
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
    this.stateValue = { kind: "in_progress", phase, activity: { kind: "processing" } };
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
    response.supplementCards.push(
      ...snapshot.supplements.map(
        (card) => new ResponseCard<SupplementCardId>(card.id, card.reason, card.entries),
      ),
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
    this.stateValue = { kind: "in_progress", phase, activity: { kind: "processing" } };
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

  /**
   * Append an inline image placeholder without the owner/terminal strictness of
   * {@link append}. A late ACP image block can arrive after ownership clears or
   * the response seals; rather than throw (crashing the update dispatch), drop
   * it silently when the response is terminal. Returns whether it was appended.
   */
  appendImageTolerant(entry: ImageTimelineEntry): boolean {
    if (this.stateValue.kind === "terminal") return false;
    this.tail.append(entry);
    return true;
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

  /**
   * Patch an inline image entry by id. Unlike {@link updateTool} this is allowed
   * after the response has sealed: image bytes upload asynchronously and the
   * `img_key` often arrives after the turn's terminal seal, so the placeholder
   * must still be replaceable to render the final picture. Searches response and
   * supplement cards.
   */
  updateImage(
    imageId: string,
    update: {
      readonly status?: ImageTimelineEntry["status"];
      readonly imgKey?: string;
      readonly fallback?: string;
    },
  ): boolean {
    for (let index = this.responseCards.length - 1; index >= 0; index -= 1) {
      const card = this.responseCards[index];
      if (card?.updateImage(imageId, update)) return true;
    }
    for (let index = this.supplementCards.length - 1; index >= 0; index -= 1) {
      const card = this.supplementCards[index];
      if (card?.updateImage(imageId, update)) return true;
    }
    return false;
  }

  /** Apply a budget-aware whole-card timeline transform to every response card.
   *  Owner-free: runs at finalize to expand text entries into interleaved
   *  text/image entries once image positions are known. */
  mapTimeline(transform: (entries: readonly TimelineEntry[]) => readonly TimelineEntry[]): void {
    for (const card of this.responseCards) card.mapTimeline(transform);
  }

  snapshot(): ResponseSnapshot {
    const tailId = this.tail.id;
    const supplementTailId = this.supplementTail?.id ?? null;
    return Object.freeze({
      id: this.id,
      token: this.token,
      state: Object.freeze({ ...this.stateValue }),
      profile: this.profileValue === null ? null : Object.freeze({ ...this.profileValue }),
      cards: Object.freeze(this.responseCards.map((card) => card.snapshot(card.id === tailId))),
      terminalToolCallIds: Object.freeze([...this.terminalToolIds]),
      supplements: Object.freeze(
        this.supplementCards.map((card) => card.snapshot(card.id === supplementTailId)),
      ),
    });
  }

  get supplementTail(): ResponseCard<SupplementCardId> | null {
    return this.supplementCards.at(-1) ?? null;
  }

  private assertSupplementEligible(): void {
    if (this.stateValue.kind !== "terminal" || this.stateValue.outcome !== "complete") {
      throw new Error("only a normally completed response may hold Supplement Cards");
    }
  }

  createSupplementCard(cardId: SupplementCardId): void {
    this.assertSupplementEligible();
    if (this.supplementTail !== null) throw new Error("a supplement card already exists");
    this.supplementCards.push(new ResponseCard<SupplementCardId>(cardId, "initial"));
  }

  rotateSupplementCard(cardId: SupplementCardId): void {
    this.assertSupplementEligible();
    const tail = this.supplementTail;
    if (tail === null) throw new Error("no supplement card to rotate");
    tail.sealRunningTools();
    this.supplementCards.push(new ResponseCard<SupplementCardId>(cardId, "content_rotation"));
  }

  appendSupplement(entry: TimelineEntry): void {
    this.assertSupplementEligible();
    const tail = this.supplementTail;
    if (tail === null) throw new Error("no supplement card to append to");
    tail.append(entry);
  }

  replaceSupplementTailText(kind: TextTimelineEntry["kind"], text: string): void {
    this.assertSupplementEligible();
    const tail = this.supplementTail;
    if (tail === null) throw new Error("no supplement card to replace");
    tail.replaceLastText(kind, text);
  }

  updateSupplementTool(
    toolCallId: string,
    update: {
      readonly title?: string;
      readonly status?: ToolTimelineEntry["status"];
    },
  ): boolean {
    this.assertSupplementEligible();
    for (let index = this.supplementCards.length - 1; index >= 0; index -= 1) {
      const card = this.supplementCards[index];
      if (card === undefined) continue;
      if (card.updateTool(toolCallId, update)) return true;
    }
    return false;
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
  private supplementOwner: ResponseId | null = null;

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
    topic.supplementOwner = snapshot.supplementOwnerResponseId;
    topic.assertInvariants();
    return topic;
  }

  accept(input: AcceptTurnInput): ResponseId {
    this.assertUnique(input);
    // A new Request always synchronously revokes any Supplement Card
    // ownership before any of the remaining (still synchronous) domain work
    // runs, so no out-of-turn update racing this call can attach afterwards.
    this.supplementOwner = null;
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
    this.supplementOwner = null;
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
    if (
      response.state.kind !== "in_progress" ||
      (response.state.phase !== "received" &&
        response.state.phase !== "interrupting" &&
        response.state.phase !== "preparing")
    ) {
      throw new Error("only a waiting or preparing response may activate");
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
    if (this.supplementOwner === responseId) return false;
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
    response.setActivity({ kind: "processing" });
    this.assertInvariants();
  }

  append(responseId: ResponseId, entry: TimelineEntry): void {
    if (this.executionOwner !== responseId) throw new Error("only execution owner accepts updates");
    this.response(responseId).append(entry);
  }

  /**
   * Append an inline image placeholder, owner-free and terminal-tolerant. A late
   * ACP image block may arrive after ownership clears or the response seals;
   * appending it must never throw. Returns whether it was appended.
   */
  appendImage(responseId: ResponseId, entry: ImageTimelineEntry): boolean {
    return this.response(responseId).appendImageTolerant(entry);
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

  /**
   * Patch an inline image entry. No execution-owner guard: image uploads settle
   * asynchronously and may land after the turn sealed and ownership moved on, so
   * any response's image placeholder must remain patchable to its final key.
   */
  updateImage(
    responseId: ResponseId,
    imageId: string,
    update: {
      readonly status?: ImageTimelineEntry["status"];
      readonly imgKey?: string;
      readonly fallback?: string;
    },
  ): boolean {
    return this.response(responseId).updateImage(imageId, update);
  }

  /** Apply a budget-aware whole-card timeline transform to a response's cards. */
  mapResponseTimeline(
    responseId: ResponseId,
    transform: (entries: readonly TimelineEntry[]) => readonly TimelineEntry[],
  ): void {
    this.response(responseId).mapTimeline(transform);
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
    if (
      outcome === "complete" &&
      this.pendingBatchValue === null &&
      !this.hasOtherActiveResponse(responseId)
    ) {
      this.supplementOwner = responseId;
    } else if (this.supplementOwner === responseId) {
      this.supplementOwner = null;
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
    this.supplementOwner = null;
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
    this.supplementOwner = null;
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
      supplementOwnerResponseId: this.supplementOwner,
    };
    return Object.freeze(snapshot);
  }

  /**
   * Creates the first Supplement Card for the current out-of-turn ownership
   * window.
   *
   * @throws when `responseId` does not currently hold Supplement Card
   *         ownership, or when a Supplement Card already exists.
   */
  createSupplementCard(responseId: ResponseId, cardId: SupplementCardId): void {
    this.assertSupplementOwner(responseId);
    this.response(responseId).createSupplementCard(cardId);
    this.assertInvariants();
  }

  /**
   * Rotates the current Supplement Card once the existing tail hits the
   * shared Conversation Card byte budget, freezing the old tail and starting
   * a new writable one anchored to the same Request.
   *
   * @throws when `responseId` does not currently hold Supplement Card
   *         ownership, or when no Supplement Card exists yet.
   */
  rotateSupplementCard(responseId: ResponseId, cardId: SupplementCardId): void {
    this.assertSupplementOwner(responseId);
    this.response(responseId).rotateSupplementCard(cardId);
    this.assertInvariants();
  }

  /**
   * @throws when `responseId` does not currently hold Supplement Card
   *         ownership, or when no Supplement Card exists yet.
   */
  appendSupplement(responseId: ResponseId, entry: TimelineEntry): void {
    this.assertSupplementOwner(responseId);
    this.response(responseId).appendSupplement(entry);
    this.assertInvariants();
  }

  /**
   * @throws when `responseId` does not currently hold Supplement Card
   *         ownership, or when no Supplement Card exists yet.
   */
  replaceSupplementTailText(
    responseId: ResponseId,
    kind: TextTimelineEntry["kind"],
    text: string,
  ): void {
    this.assertSupplementOwner(responseId);
    this.response(responseId).replaceSupplementTailText(kind, text);
    this.assertInvariants();
  }

  /**
   * @throws when `responseId` does not currently hold Supplement Card
   *         ownership, or when no Supplement Card exists yet.
   */
  updateSupplementTool(
    responseId: ResponseId,
    toolCallId: string,
    update: {
      readonly title?: string;
      readonly status?: ToolTimelineEntry["status"];
    },
  ): boolean {
    this.assertSupplementOwner(responseId);
    const updated = this.response(responseId).updateSupplementTool(toolCallId, update);
    this.assertInvariants();
    return updated;
  }

  /**
   * Reports whether `responseId` currently owns the Supplement Card window:
   * it must be the topic's recorded supplement owner and must have reached
   * the `complete` terminal outcome. This is a pure read used by the
   * application layer to decide "attached" vs "discarded" for an out-of-turn
   * ACP update without throwing on the common discard path.
   */
  isSupplementOwner(responseId: ResponseId): boolean {
    if (this.supplementOwner !== responseId) return false;
    const response = this.response(responseId).state;
    return response.kind === "terminal" && response.outcome === "complete";
  }

  hasSupplementCard(responseId: ResponseId): boolean {
    return this.response(responseId).supplementTail !== null;
  }

  private assertSupplementOwner(responseId: ResponseId): void {
    if (!this.isSupplementOwner(responseId)) {
      throw new Error("response does not currently own the Supplement Card window");
    }
  }

  private hasOtherActiveResponse(excluding: ResponseId): boolean {
    return this.turns.some(
      (turn) => turn.response.id !== excluding && turn.response.state.kind === "in_progress",
    );
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
      if (
        response.supplements.length > 0 &&
        response.supplements.filter((card) => card.isTail).length !== 1
      ) {
        throw new Error("response must have exactly one Supplement Card tail when any exist");
      }
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
    if (this.supplementOwner !== null) {
      const owner = this.response(this.supplementOwner);
      if (owner.state.kind !== "terminal" || owner.state.outcome !== "complete") {
        throw new Error("Supplement Card owner must be a normally completed response");
      }
      if (this.executionOwner !== null) throw new Error("Supplement ownership requires no owner");
      if (this.pendingBatchValue !== null) {
        throw new Error("Supplement ownership requires no pending batch");
      }
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

  /**
   * Projects a Supplement Card. Unlike {@link project}, this never derives
   * Title, Metadata, or Cancel: Supplement Cards have no execution authority
   * regardless of tail position or Response state.
   *
   * @throws when `responseId` or `cardId` is unknown.
   */
  projectSupplement(
    topic: TopicConversationSnapshot,
    responseId: ResponseId,
    cardId: SupplementCardId,
  ): SupplementCardProjection {
    const response = topic.turns.find((turn) => turn.response.id === responseId)?.response;
    if (response === undefined) throw new Error(`unknown response: ${responseId}`);
    const card = response.supplements.find((candidate) => candidate.id === cardId);
    if (card === undefined) throw new Error(`unknown supplement card: ${cardId}`);
    return Object.freeze({
      responseId,
      cardId,
      entries: card.entries,
    });
  }
}
