import { describe, expect, it, vi } from "vitest";
import {
  createWipNoticeCard,
  finalizeWipNoticeCard,
  type WipNoticePresenter,
} from "./notice-card-lifecycle.js";
import type { NoticeCardSpec } from "./presenter.js";

const WIP_NOTICE: NoticeCardSpec = {
  title: "处理中",
  body: "请稍候",
  template: "blue",
};
const TERMINAL_NOTICE: NoticeCardSpec = {
  title: "已完成",
  body: "处理完成",
  template: "green",
};

function presenter(
  replyNoticeCard: WipNoticePresenter["replyNoticeCard"],
  updateNoticeCard: NonNullable<WipNoticePresenter["updateNoticeCard"]>,
): WipNoticePresenter {
  return { replyNoticeCard, updateNoticeCard };
}

describe("notice card lifecycle", () => {
  it("retains the created WIP card id and patches it to a terminal state", async () => {
    const update = vi.fn(async () => true);
    const target = presenter(async () => "om_wip", update);
    const ref = await createWipNoticeCard(target, "om_user", WIP_NOTICE);
    const fallback = vi.fn(async () => {});

    expect(ref).toEqual({ messageId: "om_wip" });
    if (!ref) throw new Error("expected WIP card ref");
    await finalizeWipNoticeCard(target, ref, TERMINAL_NOTICE, fallback);

    expect(update).toHaveBeenCalledWith("om_wip", TERMINAL_NOTICE);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the terminal fallback when patching the WIP card fails", async () => {
    const target = presenter(
      async () => "om_wip",
      async () => false,
    );
    const fallback = vi.fn(async () => {});

    await finalizeWipNoticeCard(target, { messageId: "om_wip" }, TERMINAL_NOTICE, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
