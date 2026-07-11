import type { UnifiedCardState } from "../presenter/presenter.js";

export interface CardDeliveryTransport {
  send(state: UnifiedCardState): Promise<string | null>;
  patch(cardId: string, state: UnifiedCardState): Promise<boolean>;
}

export type CardDeliveryResult =
  { outcome: "visible"; cardId: string } | { outcome: "pending" } | { outcome: "skipped" };

export class ConversationCardDelivery {
  private activeCardId: string | null = null;
  private lifecycleEpoch = 0;
  private deliveryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly transport: CardDeliveryTransport) {}

  deliver(state: UnifiedCardState): Promise<CardDeliveryResult> {
    const epoch = this.lifecycleEpoch;
    const delivery = this.deliveryQueue.then(() => this.applyState(state, epoch));
    this.deliveryQueue = delivery.then(
      () => undefined,
      () => undefined,
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
    return this.activeCardId !== null;
  }

  takeActiveCardId(): string | null {
    const cardId = this.activeCardId;
    this.beginNewLifecycle(null);
    return cardId;
  }

  private async applyState(state: UnifiedCardState, epoch: number): Promise<CardDeliveryResult> {
    if (!this.isCurrent(epoch)) return { outcome: "skipped" };
    if (this.activeCardId === null) return this.sendAndInstall(state, epoch);

    const cardId = this.activeCardId;
    const accepted = await this.patchCard(cardId, state);
    if (!this.isCurrent(epoch) || this.activeCardId !== cardId) return { outcome: "skipped" };
    if (accepted) return { outcome: "visible", cardId };

    this.activeCardId = null;
    return this.sendAndInstall(state, epoch);
  }

  private async sendAndInstall(
    state: UnifiedCardState,
    epoch: number,
  ): Promise<CardDeliveryResult> {
    const cardId = await this.transport.send(state);
    if (!this.isCurrent(epoch)) return { outcome: "skipped" };
    if (cardId === null) return { outcome: "pending" };

    this.activeCardId = cardId;
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
    this.lifecycleEpoch += 1;
    this.activeCardId = cardId;
  }

  private isCurrent(epoch: number): boolean {
    return this.lifecycleEpoch === epoch;
  }
}
