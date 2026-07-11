import type { LarkPresenter, NoticeCardSpec } from "./presenter.js";

export type WipNoticeCardRef = {
  readonly messageId: string;
};

export type WipNoticePresenter = Pick<LarkPresenter, "replyNoticeCard" | "updateNoticeCard">;

/**
 * Create a notice card whose contents will be replaced by a terminal state.
 *
 * @throws when the presenter rejects while creating the card.
 */
export async function createWipNoticeCard(
  presenter: WipNoticePresenter,
  replyToMessageId: string,
  notice: NoticeCardSpec,
): Promise<WipNoticeCardRef | null> {
  const messageId = await presenter.replyNoticeCard(replyToMessageId, notice);
  return messageId ? { messageId } : null;
}

export function restoreWipNoticeCard(
  messageId: string | null | undefined,
): WipNoticeCardRef | null {
  return messageId ? { messageId } : null;
}

/**
 * Replace a WIP card without ending its lifecycle.
 *
 * @throws when the presenter rejects while patching the card.
 */
export async function updateWipNoticeCard(
  presenter: WipNoticePresenter,
  ref: WipNoticeCardRef,
  notice: NoticeCardSpec,
): Promise<boolean> {
  return presenter.updateNoticeCard?.(ref.messageId, notice) ?? false;
}

/**
 * Replace a WIP card with its terminal state. If PATCH is unavailable or
 * rejected, invoke the supplied fallback so the terminal outcome is still
 * visible as a new card.
 *
 * @throws when the presenter or fallback rejects.
 */
export async function finalizeWipNoticeCard(
  presenter: WipNoticePresenter,
  ref: WipNoticeCardRef,
  notice: NoticeCardSpec,
  fallback: () => Promise<void>,
): Promise<void> {
  if (await updateWipNoticeCard(presenter, ref, notice)) return;
  await fallback();
}
