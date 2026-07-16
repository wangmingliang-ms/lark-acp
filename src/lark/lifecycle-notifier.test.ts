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

function bodyElements(card: object): readonly { tag?: string; content?: string }[] {
  const rec = card as { body?: { elements?: readonly { tag?: string; content?: string }[] } };
  return rec.body?.elements ?? [];
}

describe("buildLifecycleNoticeCard", () => {
  it.each([
    ["started", "✅ Humming 已启动"],
    ["stopped", "⏹️ Humming 已停止"],
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
        codeRevision: {
          commit: "abc1234",
          message: "feat: show revision",
          time: "2026-07-05T09:08:07Z",
        },
      });

      expect(bodyMarkdown(card)).toContain("**Code Revision**");
      expect(bodyMarkdown(card)).toContain("• Commit: `abc1234`");
      expect(bodyMarkdown(card)).toContain("• Message: feat: show revision");
      expect(bodyMarkdown(card)).toContain("• Time: 2026-07-05 17:08:07 UTC+8");
    },
  );

  it.each(["started", "restarted"] as const)(
    "includes the effective global default configuration on %s notices",
    (kind) => {
      const card = buildLifecycleNoticeCard(kind, {
        pid: 123,
        now: new Date("2026-07-05T10:00:00Z"),
        defaultProfile: {
          agent: "claude",
          model: "claude-sonnet-4-5",
          mode: "plan",
          permissionMode: "alwaysAsk",
        },
      });

      expect(bodyMarkdown(card)).not.toContain("Default Configuration");
      expect(bodyElements(card)).toEqual([
        expect.objectContaining({ tag: "markdown" }),
        { tag: "hr" },
        {
          tag: "markdown",
          content:
            '<font color="grey">Agent: claude · Mode: plan · Model: claude-sonnet-4-5 · Permission: alwaysAsk</font>',
        },
      ]);
    },
  );

  it("leaves unset Model and Mode values blank in the profile footer", () => {
    const card = buildLifecycleNoticeCard("started", {
      defaultProfile: {
        agent: "claude",
        permissionMode: "alwaysAllow",
      },
    });

    expect(bodyElements(card).at(-1)?.content).toBe(
      '<font color="grey">Agent: claude · Mode:  · Model:  · Permission: alwaysAllow</font>',
    );
  });

  it("formats Runtime labels in English and time in fixed UTC+8", () => {
    const card = buildLifecycleNoticeCard("stopped", {
      pid: 123,
      now: new Date("2026-07-05T10:00:00Z"),
    });

    expect(bodyMarkdown(card)).toContain("• PID: 123");
    expect(bodyMarkdown(card)).toContain("• Time: 2026-07-05 18:00:00 UTC+8");
    expect(bodyMarkdown(card)).not.toContain("时间");
  });

  it("does not include code revision on stopped notices", () => {
    const card = buildLifecycleNoticeCard("stopped", {
      pid: 123,
      now: new Date("2026-07-05T10:00:00Z"),
      codeRevision: {
        commit: "abc1234",
        message: "feat: show revision",
        time: "2026-07-05T09:08:07Z",
      },
      defaultProfile: {
        agent: "claude",
        model: "claude-sonnet-4-5",
        mode: "plan",
        permissionMode: "alwaysAsk",
      },
    });

    expect(bodyMarkdown(card)).not.toContain("Commit");
    expect(bodyMarkdown(card)).not.toContain("Default Configuration");
    expect(bodyMarkdown(card)).toContain("**Runtime**");
    expect(bodyElements(card)).toHaveLength(1);
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
