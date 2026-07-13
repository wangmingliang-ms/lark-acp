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

function bodyMarkdown(card: object): string | undefined {
  const rec = card as { body?: { elements?: readonly [{ content?: string }] } };
  return rec.body?.elements?.[0]?.content;
}

describe("buildLifecycleNoticeCard", () => {
  it.each([
    ["started", "✅ Humming 已启动"],
    ["stopping", "⛔ Humming 正在停止"],
    ["restarting", "🔄 Humming 正在重启"],
    ["restarted", "✅ Humming 已重启"],
    ["restartFailed", "❌ Humming 重启失败"],
    ["crashed", "⚠️ Humming 发生未捕获错误"],
  ] satisfies readonly [LifecycleNoticeKind, string][])("renders %s", (kind, title) => {
    const card = buildLifecycleNoticeCard(kind, {
      pid: 123,
      now: new Date("2026-07-05T10:00:00Z"),
    });
    expect(headerTitle(card)).toBe(title);
    expect(summary(card)).toBe(title);
    expect(JSON.stringify(card)).toContain("123");
  });

  it.each(["started", "restarted"] as const)(
    "includes the current code revision on %s notices",
    (kind) => {
      const card = buildLifecycleNoticeCard(kind, {
        pid: 123,
        now: new Date("2026-07-05T10:00:00Z"),
        codeRevision: { commit: "abc1234", message: "feat: show revision" },
      });

      expect(bodyMarkdown(card)).toContain("• Commit：`abc1234`");
      expect(bodyMarkdown(card)).toContain("• Message：feat: show revision");
    },
  );

  it("does not include code revision on stopping notices", () => {
    const card = buildLifecycleNoticeCard("stopping", {
      pid: 123,
      now: new Date("2026-07-05T10:00:00Z"),
      codeRevision: { commit: "abc1234", message: "feat: show revision" },
    });

    expect(bodyMarkdown(card)).not.toContain("Commit");
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

  it("patches restarting cards to restarted and falls back to send only when needed", async () => {
    const sent: string[] = [];
    const patched: Array<{ messageId: string; title: string | undefined }> = [];
    const http = {
      async sendCardToChat(chatId: string): Promise<string> {
        sent.push(chatId);
        return `om_${chatId}`;
      },
      async patchCard(messageId: string, card: object): Promise<void> {
        patched.push({ messageId, title: headerTitle(card) });
      },
    };

    const restarting = await sendLifecycleNotice({
      http,
      chatIds: ["oc_A"],
      kind: "restarting",
      logger: silentLogger,
    });
    const restarted = await sendLifecycleNotice({
      http,
      chatIds: ["oc_A"],
      kind: "restarted",
      logger: silentLogger,
      replace: restarting,
    });

    expect(sent).toEqual(["oc_A"]);
    expect(patched).toEqual([{ messageId: "om_oc_A", title: "✅ Humming 已重启" }]);
    expect(restarted).toEqual([{ chatId: "oc_A", messageId: "om_oc_A" }]);
  });

  it("patches restarting cards to restartFailed", async () => {
    const patched: string[] = [];
    const http = {
      async sendCardToChat(): Promise<string> {
        return "om_restart";
      },
      async patchCard(_messageId: string, card: object): Promise<void> {
        patched.push(headerTitle(card) ?? "");
      },
    };
    const restarting = await sendLifecycleNotice({
      http,
      chatIds: ["oc_A"],
      kind: "restarting",
      logger: silentLogger,
    });
    await sendLifecycleNotice({
      http,
      chatIds: ["oc_A"],
      kind: "restartFailed",
      logger: silentLogger,
      replace: restarting,
    });
    expect(patched).toEqual(["❌ Humming 重启失败"]);
  });
});
