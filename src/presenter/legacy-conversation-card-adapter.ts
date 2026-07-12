import type { SemanticCardDeliveryTransport } from "../acp/conversation-card-delivery.js";
import type { ConversationCardView } from "./conversation-card-view.js";
import type { LarkPresenter, UnifiedCardState } from "./presenter.js";

/**
 * Gate-off compatibility boundary. Production legacy conversation-card writes
 * must pass through this adapter so runtime/business code cannot become a
 * second transport writer while the semantic lifecycle is enabled in tests.
 */
export class LegacyConversationCardAdapter {
  constructor(private readonly presenter: LarkPresenter) {}

  send(replyToMessageId: string, state: UnifiedCardState): Promise<string | null> {
    return this.presenter.sendUnifiedCard(replyToMessageId, state);
  }

  update(cardMessageId: string, state: UnifiedCardState): Promise<boolean> {
    return this.presenter.updateUnifiedCard(cardMessageId, state);
  }
}

export function createSemanticConversationCardTransport(
  presenter: LarkPresenter,
  replyToMessageId: string,
): SemanticCardDeliveryTransport {
  return {
    sendView: (view: ConversationCardView) =>
      presenter.sendConversationCard(replyToMessageId, view),
    patchView: (cardMessageId: string, view: ConversationCardView) =>
      presenter.updateConversationCard(cardMessageId, view),
  };
}
