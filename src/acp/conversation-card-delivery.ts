import {
  cloneCardView,
  type ConversationCardView,
  type OwnershipToken,
  type PermissionToken,
  type PromptToken,
  type SegmentToken,
} from "../presenter/conversation-card-view.js";
import type { UnifiedCardState } from "../presenter/presenter.js";
import type {
  DeliveryLifecycleDiagnostic,
  DiagnosticCorrelation,
  LifecycleDiagnosticSink,
} from "./lifecycle-diagnostics.js";

export interface CardDeliveryTransport {
  send(state: UnifiedCardState): Promise<string | null>;
  patch(cardId: string, state: UnifiedCardState): Promise<boolean>;
}

export interface SemanticCardDeliveryTransport {
  sendView(view: ConversationCardView): Promise<string | null>;
  patchView(cardId: string, view: ConversationCardView): Promise<boolean>;
}

export interface PermissionCardTransport<
  Request extends PermissionHandoffRequest = PermissionHandoffRequest,
> {
  sendPermission(request: Request): Promise<string | null>;
  patchPermission(cardId: string, request: Request): Promise<boolean>;
  reconcilePermissionArtifact(cardId: string, request: Request): Promise<void>;
}

export type CardDeliveryContext = Readonly<Record<string, unknown>>;

export interface PermissionHandoffRequest {
  readonly promptToken: PromptToken;
  readonly segmentToken: SegmentToken;
  readonly permissionToken: PermissionToken;
  readonly permission: unknown;
  readonly isCurrent: () => boolean;
  readonly reuseCard?: boolean;
}

export type PermissionArtifactReconciliation = {
  readonly type: "reconcile_permission_artifact";
  readonly cardId: string;
  readonly promptToken: PromptToken;
  readonly permissionToken: PermissionToken;
  readonly reason: "stale_handoff";
};

export type PermissionHandoffResult =
  | { outcome: "reused"; permissionCardId: string }
  | { outcome: "sent_fresh"; permissionCardId: string }
  | {
      outcome: "superseded";
      permissionCardId: string;
      reconciliation: PermissionArtifactReconciliation;
    }
  | { outcome: "failed" };

export type CardDeliveryResult =
  | { outcome: "visible"; cardId: string }
  | { outcome: "superseded"; cardId: string }
  | { outcome: "pending" }
  | { outcome: "failed" }
  | { outcome: "skipped" };

type DeliveryLifecycle = {
  activeCardId: string | null;
  queue: Promise<void>;
  lastSequence: number;
  pendingDeliveries: number;
  skipThroughSequence: number;
};

type SemanticOwner = DeliveryLifecycle & {
  readonly token: OwnershipToken;
  readonly context: CardDeliveryContext;
  readonly correlation: DiagnosticCorrelation;
  accepting: boolean;
  closeSequence: number | null;
};

const NO_DIAGNOSTICS: LifecycleDiagnosticSink = { record: () => undefined };

function lifecycle(activeCardId: string | null): DeliveryLifecycle {
  return {
    activeCardId,
    queue: Promise.resolve(),
    lastSequence: 0,
    pendingDeliveries: 0,
    skipThroughSequence: 0,
  };
}

function cardSnapshot(view: ConversationCardView): ConversationCardView {
  return cloneCardView(view) as ConversationCardView;
}

function immutableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  if (process.env.NODE_ENV !== "production") freezeRecursively(snapshot);
  return snapshot;
}

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeRecursively(nested);
  Object.freeze(value);
}

/**
 * Owns transport serialization only. The one-argument methods below are an isolated
 * compatibility surface for the disabled semantic-card feature gate.
 */
export class ConversationCardDelivery {
  private current = lifecycle(null);
  private readonly owners = new Map<OwnershipToken, SemanticOwner>();
  private readonly cardOwners = new Map<string, OwnershipToken>();

  constructor(
    private readonly transport: CardDeliveryTransport,
    private readonly diagnostics: LifecycleDiagnosticSink = NO_DIAGNOSTICS,
    private readonly tokenFactory: () => OwnershipToken = () =>
      crypto.randomUUID() as OwnershipToken,
    private readonly semanticTransport?: SemanticCardDeliveryTransport,
    private readonly permissionTransport?: PermissionCardTransport,
  ) {}

  createOwner(
    context: CardDeliveryContext,
    correlation: DiagnosticCorrelation,
    suppliedToken: OwnershipToken = this.tokenFactory(),
  ): OwnershipToken {
    if (this.owners.has(suppliedToken))
      throw new Error("ownership token has already been registered");
    this.owners.set(suppliedToken, {
      ...lifecycle(null),
      token: suppliedToken,
      context,
      correlation,
      accepting: true,
      closeSequence: null,
    });
    return suppliedToken;
  }

  deliver(owner: OwnershipToken, view: ConversationCardView): Promise<CardDeliveryResult>;
  deliver(state: UnifiedCardState): Promise<CardDeliveryResult>;
  deliver(
    ownerOrState: OwnershipToken | UnifiedCardState,
    semanticView?: ConversationCardView,
  ): Promise<CardDeliveryResult> {
    if (semanticView !== undefined) {
      return this.deliverSemantic(ownerOrState as OwnershipToken, semanticView);
    }
    return this.deliverLegacy(ownerOrState as UnifiedCardState);
  }

  adopt(owner: OwnershipToken, cardId: string): "adopted" | "skipped" | "rejected";
  adopt(cardId: string): void;
  adopt(
    ownerOrCardId: OwnershipToken | string,
    semanticCardId?: string,
  ): "adopted" | "skipped" | "rejected" | void {
    if (semanticCardId !== undefined) {
      return this.adoptSemantic(ownerOrCardId as OwnershipToken, semanticCardId);
    }
    this.beginNewLifecycle(ownerOrCardId as string);
  }

  close(
    token: OwnershipToken,
    view: Extract<ConversationCardView, { kind: "archived" | "terminal" }>,
    nextCorrelation: DiagnosticCorrelation,
    nextOwnerToken: OwnershipToken = this.tokenFactory(),
  ): OwnershipToken {
    const owner = this.owners.get(token);
    const nextOwner = this.createOwner(
      owner?.context ?? { messageSequence: 0 },
      nextCorrelation,
      nextOwnerToken,
    );
    if (owner === undefined || !owner.accepting || this.semanticTransport === undefined)
      return nextOwner;

    owner.accepting = false;
    const snapshot = cardSnapshot(view);
    const sequence = ++owner.lastSequence;
    owner.closeSequence = sequence;
    const priorQueue = owner.queue;
    const supersededCardId = owner.pendingDeliveries > 0 ? owner.activeCardId : null;
    if (supersededCardId !== null) {
      this.cardOwners.delete(supersededCardId);
      owner.activeCardId = null;
    }
    owner.pendingDeliveries += 1;
    this.record(owner, "close", "pending");
    const closing = this.applySemanticView(owner, sequence, snapshot, true);
    owner.queue = closing.then(
      () => undefined,
      () => undefined,
    );
    void closing.then(
      (result) => {
        owner.pendingDeliveries -= 1;
        this.record(owner, "close", this.deliveryDiagnosticOutcome(result));
      },
      () => {
        owner.pendingDeliveries -= 1;
        this.record(owner, "close", "failed");
      },
    );
    if (supersededCardId !== null) {
      void priorQueue.then(() => this.reassertClosedView(owner, supersededCardId, snapshot));
    }
    return nextOwner;
  }

  async handoffToPermission(
    token: OwnershipToken,
    request: PermissionHandoffRequest,
  ): Promise<PermissionHandoffResult> {
    const owner = this.owners.get(token);
    if (owner === undefined || !owner.accepting || this.permissionTransport === undefined)
      return { outcome: "failed" };
    const snapshot = {
      ...immutableSnapshot({
        promptToken: request.promptToken,
        segmentToken: request.segmentToken,
        permissionToken: request.permissionToken,
        permission: request.permission,
        ...(request.reuseCard === undefined ? {} : { reuseCard: request.reuseCard }),
      }),
      isCurrent: request.isCurrent,
    };
    const reusableCardId =
      request.reuseCard === false || owner.pendingDeliveries > 0 ? null : owner.activeCardId;
    this.closeOwnerSynchronously(owner);

    if (reusableCardId !== null) {
      this.cardOwners.delete(reusableCardId);
      this.record(owner, "permission_reuse", "pending");
      let accepted = false;
      let patchFailed = false;
      try {
        accepted = await this.permissionTransport.patchPermission(reusableCardId, snapshot);
      } catch {
        patchFailed = true;
      }
      if (accepted) {
        if (!request.isCurrent())
          return this.supersededPermission(owner, reusableCardId, snapshot, "permission_reuse");
        this.record(owner, "permission_reuse", "reused");
        return { outcome: "reused", permissionCardId: reusableCardId };
      }
      this.record(owner, "permission_reuse", patchFailed ? "failed" : "rejected");
      if (!request.isCurrent()) return { outcome: "failed" };
    }

    this.record(owner, "permission_send", "pending");
    let permissionCardId: string | null;
    try {
      permissionCardId = await this.permissionTransport.sendPermission(snapshot);
    } catch {
      this.record(owner, "permission_send", "failed");
      return { outcome: "failed" };
    }
    if (permissionCardId === null) {
      this.record(owner, "permission_send", "failed");
      return { outcome: "failed" };
    }
    if (!request.isCurrent())
      return this.supersededPermission(owner, permissionCardId, snapshot, "permission_send");
    this.record(owner, "permission_send", "visible");
    return { outcome: "sent_fresh", permissionCardId };
  }

  async reconcileSuperseded(
    token: OwnershipToken,
    cardId: string,
    view: Extract<ConversationCardView, { kind: "orphaned" }>,
  ): Promise<void> {
    const owner = this.owners.get(token);
    if (owner === undefined || this.semanticTransport === undefined) return;
    this.record(owner, "reconcile", "pending");
    try {
      const accepted = await this.semanticTransport.patchView(cardId, cardSnapshot(view));
      this.record(owner, "reconcile", accepted ? "visible" : "rejected");
    } catch {
      this.record(owner, "reconcile", "failed");
    }
  }

  detach(): void {
    this.beginNewLifecycle(null);
  }

  reset(): void {
    this.beginNewLifecycle(null);
  }

  hasCard(): boolean {
    return this.current.activeCardId !== null;
  }

  hasCardOrPendingDelivery(): boolean {
    return this.hasCard() || this.current.pendingDeliveries > 0;
  }

  takeActiveCardId(): string | null {
    const cardId = this.current.activeCardId;
    this.beginNewLifecycle(null);
    return cardId;
  }

  private deliverLegacy(state: UnifiedCardState): Promise<CardDeliveryResult> {
    const owner = this.current;
    const sequence = ++owner.lastSequence;
    owner.pendingDeliveries += 1;
    const delivery = owner.queue.then(() => this.applyLegacyState(owner, sequence, state));
    owner.queue = delivery.then(
      () => undefined,
      () => undefined,
    );
    void delivery.then(
      () => (owner.pendingDeliveries -= 1),
      () => (owner.pendingDeliveries -= 1),
    );
    return delivery;
  }

  private async applyLegacyState(
    owner: DeliveryLifecycle,
    sequence: number,
    state: UnifiedCardState,
  ): Promise<CardDeliveryResult> {
    if (owner !== this.current || sequence <= owner.skipThroughSequence) {
      return { outcome: "skipped" };
    }
    if (owner.activeCardId === null) return this.sendLegacyAndInstall(owner, state);

    const cardId = owner.activeCardId;
    const accepted = await this.patchLegacyCard(cardId, state);
    if (owner !== this.current || owner.activeCardId !== cardId) return { outcome: "skipped" };
    if (accepted) return { outcome: "visible", cardId };

    owner.activeCardId = null;
    return this.sendLegacyAndInstall(owner, state);
  }

  private async sendLegacyAndInstall(
    owner: DeliveryLifecycle,
    state: UnifiedCardState,
  ): Promise<CardDeliveryResult> {
    let cardId: string | null;
    try {
      cardId = await this.transport.send(state);
    } catch (error) {
      owner.skipThroughSequence = owner.lastSequence;
      throw error;
    }
    if (owner !== this.current) {
      return cardId === null ? { outcome: "skipped" } : { outcome: "superseded", cardId };
    }
    if (cardId === null) {
      owner.skipThroughSequence = owner.lastSequence;
      return { outcome: "pending" };
    }

    owner.activeCardId = cardId;
    return { outcome: "visible", cardId };
  }

  private async patchLegacyCard(cardId: string, state: UnifiedCardState): Promise<boolean> {
    try {
      return await this.transport.patch(cardId, state);
    } catch {
      return false;
    }
  }

  private deliverSemantic(
    token: OwnershipToken,
    view: ConversationCardView,
  ): Promise<CardDeliveryResult> {
    const owner = this.owners.get(token);
    if (owner === undefined || !owner.accepting || this.semanticTransport === undefined) {
      return Promise.resolve({ outcome: "skipped" });
    }
    const snapshot = cardSnapshot(view);
    const sequence = ++owner.lastSequence;
    owner.pendingDeliveries += 1;
    const delivery = owner.queue.then(() =>
      this.applySemanticView(owner, sequence, snapshot, false),
    );
    owner.queue = delivery.then(
      () => undefined,
      () => undefined,
    );
    void delivery.then(
      () => (owner.pendingDeliveries -= 1),
      () => (owner.pendingDeliveries -= 1),
    );
    return delivery;
  }

  private adoptSemantic(token: OwnershipToken, cardId: string): "adopted" | "skipped" | "rejected" {
    const owner = this.owners.get(token);
    if (owner === undefined || !owner.accepting) return "skipped";
    const existingOwner = this.cardOwners.get(cardId);
    if (existingOwner !== undefined && existingOwner !== token) return "rejected";
    if (owner.activeCardId !== null && owner.activeCardId !== cardId) {
      this.cardOwners.delete(owner.activeCardId);
    }
    owner.activeCardId = cardId;
    this.cardOwners.set(cardId, token);
    this.record(owner, "adopt", "visible");
    return "adopted";
  }

  private async applySemanticView(
    owner: SemanticOwner,
    sequence: number,
    view: ConversationCardView,
    closing: boolean,
  ): Promise<CardDeliveryResult> {
    if (
      (!owner.accepting && (!closing || owner.closeSequence !== sequence)) ||
      sequence <= owner.skipThroughSequence
    ) {
      return { outcome: "skipped" };
    }
    if (owner.activeCardId === null) return this.sendSemanticAndInstall(owner, view, closing);

    const cardId = owner.activeCardId;
    this.record(owner, "patch", "pending");
    let accepted = false;
    let patchFailed = false;
    try {
      accepted = await this.semanticTransport!.patchView(cardId, cardSnapshot(view));
    } catch {
      patchFailed = true;
    }
    if ((!owner.accepting && !closing) || owner.activeCardId !== cardId)
      return { outcome: "skipped" };
    if (accepted) {
      this.record(owner, "patch", "visible");
      return { outcome: "visible", cardId };
    }

    this.record(owner, "patch", patchFailed ? "failed" : "rejected");
    this.cardOwners.delete(cardId);
    owner.activeCardId = null;
    return this.sendSemanticAndInstall(owner, view, closing);
  }

  private async sendSemanticAndInstall(
    owner: SemanticOwner,
    view: ConversationCardView,
    closing: boolean,
  ): Promise<CardDeliveryResult> {
    this.record(owner, "send", "pending");
    let cardId: string | null;
    try {
      cardId = await this.semanticTransport!.sendView(cardSnapshot(view));
    } catch {
      owner.skipThroughSequence = owner.lastSequence;
      this.record(owner, "send", "failed");
      return { outcome: "failed" };
    }
    if (!owner.accepting && !closing) {
      if (cardId === null) return { outcome: "skipped" };
      this.record(owner, "send", "superseded");
      return { outcome: "superseded", cardId };
    }
    if (closing && owner.closeSequence !== null && owner.lastSequence > owner.closeSequence) {
      if (cardId === null) return { outcome: "skipped" };
      this.record(owner, "send", "superseded");
      return { outcome: "superseded", cardId };
    }
    if (cardId === null) {
      owner.skipThroughSequence = owner.lastSequence;
      this.record(owner, "send", "failed");
      return { outcome: "pending" };
    }

    owner.activeCardId = cardId;
    this.cardOwners.set(cardId, owner.token);
    this.record(owner, "send", "visible");
    return { outcome: "visible", cardId };
  }

  private closeOwnerSynchronously(owner: SemanticOwner): void {
    owner.accepting = false;
    if (owner.activeCardId !== null) this.cardOwners.delete(owner.activeCardId);
    owner.activeCardId = null;
  }

  private async reassertClosedView(
    owner: SemanticOwner,
    cardId: string,
    view: Extract<ConversationCardView, { kind: "archived" | "terminal" }>,
  ): Promise<void> {
    this.record(owner, "reconcile", "pending");
    try {
      const accepted = await this.semanticTransport!.patchView(cardId, cardSnapshot(view));
      this.record(owner, "reconcile", accepted ? "visible" : "rejected");
    } catch {
      this.record(owner, "reconcile", "failed");
    }
  }

  private async supersededPermission(
    owner: SemanticOwner,
    cardId: string,
    request: PermissionHandoffRequest,
    operation: "permission_reuse" | "permission_send",
  ): Promise<PermissionHandoffResult> {
    this.record(owner, operation, "superseded");
    this.record(owner, "reconcile", "pending");
    const reconciliation: PermissionArtifactReconciliation = {
      type: "reconcile_permission_artifact",
      cardId,
      promptToken: request.promptToken,
      permissionToken: request.permissionToken,
      reason: "stale_handoff",
    };
    try {
      await this.permissionTransport!.reconcilePermissionArtifact(cardId, request);
      this.record(owner, "reconcile", "visible");
    } catch {
      this.record(owner, "reconcile", "failed");
    }
    return { outcome: "superseded", permissionCardId: cardId, reconciliation };
  }

  private deliveryDiagnosticOutcome(
    result: CardDeliveryResult,
  ): DeliveryLifecycleDiagnostic["outcome"] {
    switch (result.outcome) {
      case "visible":
        return "visible";
      case "superseded":
        return "superseded";
      case "failed":
        return "failed";
      case "pending":
      case "skipped":
        return "failed";
    }
  }

  private record(
    owner: SemanticOwner,
    operation: DeliveryLifecycleDiagnostic["operation"],
    outcome: DeliveryLifecycleDiagnostic["outcome"],
  ): void {
    this.diagnostics.record({
      category: "delivery",
      correlation: owner.correlation,
      operation,
      outcome,
    });
  }

  private beginNewLifecycle(cardId: string | null): void {
    this.current = lifecycle(cardId);
  }
}
