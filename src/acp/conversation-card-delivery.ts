import type { UnifiedCardState } from "../presenter/presenter.js";

export interface CardDeliveryTransport {
  send(state: UnifiedCardState): Promise<string | null>;
  patch(cardId: string, state: UnifiedCardState): Promise<boolean>;
}

export type CardDeliveryResult =
  | { outcome: "visible"; cardId: string }
  | { outcome: "superseded"; cardId: string }
  | { outcome: "pending" }
  | { outcome: "skipped" };

type DeliveryLifecycle = {
  activeCardId: string | null;
  queue: Promise<void>;
  lastSequence: number;
  pendingDeliveries: number;
  skipThroughSequence: number;
};

function lifecycle(activeCardId: string | null): DeliveryLifecycle {
  return {
    activeCardId,
    queue: Promise.resolve(),
    lastSequence: 0,
    pendingDeliveries: 0,
    skipThroughSequence: 0,
  };
}

export class ConversationCardDelivery {
  private current = lifecycle(null);

  constructor(private readonly transport: CardDeliveryTransport) {}

  deliver(state: UnifiedCardState): Promise<CardDeliveryResult> {
    const owner = this.current;
    const sequence = ++owner.lastSequence;
    owner.pendingDeliveries += 1;
    const delivery = owner.queue.then(() => this.applyState(owner, sequence, state));
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

  adopt(cardId: string): void {
    this.beginNewLifecycle(cardId);
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

  private async applyState(
    owner: DeliveryLifecycle,
    sequence: number,
    state: UnifiedCardState,
  ): Promise<CardDeliveryResult> {
    if (owner !== this.current || sequence <= owner.skipThroughSequence) {
      return { outcome: "skipped" };
    }
    if (owner.activeCardId === null) return this.sendAndInstall(owner, state);

    const cardId = owner.activeCardId;
    const accepted = await this.patchCard(cardId, state);
    if (owner !== this.current || owner.activeCardId !== cardId) return { outcome: "skipped" };
    if (accepted) return { outcome: "visible", cardId };

    owner.activeCardId = null;
    return this.sendAndInstall(owner, state);
  }

  private async sendAndInstall(
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

  private async patchCard(cardId: string, state: UnifiedCardState): Promise<boolean> {
    try {
      return await this.transport.patch(cardId, state);
    } catch {
      return false;
    }
  }

  private beginNewLifecycle(cardId: string | null): void {
    this.current = lifecycle(cardId);
  }
}
