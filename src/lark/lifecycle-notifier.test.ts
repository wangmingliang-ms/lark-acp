import { describe, expect, it } from "vitest";
import {
  buildLifecycleNoticeCard,
  sendLifecycleNotice,
  type LifecycleNoticeKind,
} from "./lifecycle-notifier.js";
import type { LarkLogger } from "../logger/logger.js";

const silentLogger: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return silentLogger;
  },
};

function headerTitle(card: object): string | undefined {
  const rec = card as { header?: { title?: { content?: string } } };
  return rec.header?.title?.content;
}

function summary(card: object): string | undefined {
  const rec = card as { config?: { summary?: { content?: string } } };
  return rec.config?.summary?.content;
}

describe("buildLifecycleNoticeCard", () => {
  it.each([
    ["started", "✅ Humming 已启动"],
    ["stopping", "⛔ Humming 正在停止"],
    ["restarting", "🔄 Humming 正在重启"],
    ["restarted", "✅ Humming 已重启"],
  ] satisfies readonly [LifecycleNoticeKind, string][])("renders %s", (kind, title) => {
    const card = buildLifecycleNoticeCard(kind, {
      pid: 123,
      now: new Date("2026-07-05T10:00:00Z"),
    });
    expect(headerTitle(card)).toBe(title);
    expect(summary(card)).toBe(title);
    expect(JSON.stringify(card)).toContain("123");
  });
});

describe("sendLifecycleNotice", () => {
  it("deduplicates empty/repeated chat ids before sending", async () => {
    const sent: string[] = [];
    await sendLifecycleNotice({
      http: {
        async sendCardToChat(chatId: string): Promise<string | null> {
          sent.push(chatId);
          return "om_test";
        },
      },
      chatIds: [" oc_A ", "", "oc_A", "oc_B"],
      kind: "started",
      logger: silentLogger,
    });

    expect(sent).toEqual(["oc_A", "oc_B"]);
  });
});
