import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkCardPresenter, NOTICE_BODY_CHAR_LIMIT } from "./lark-presenter.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";

interface CardElement {
  tag?: string;
  content?: string;
  elements?: CardElement[];
  text?: { content?: string };
}

interface CardWithConfig {
  config?: { summary?: { content?: string } };
  header?: { title?: { content?: string }; template?: string };
  body?: { elements?: CardElement[] };
}

interface ReplyCardCall {
  card: CardWithConfig;
  opts?: { replyInThread?: boolean };
}

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function makePresenter(captured: CardWithConfig[], calls: ReplyCardCall[] = []): LarkCardPresenter {
  const http = {
    replyCard: async (
      _messageId: string,
      card: object,
      opts?: { replyInThread?: boolean },
    ): Promise<string> => {
      const typed = card as CardWithConfig;
      captured.push(typed);
      calls.push({ card: typed, opts });
      return "card_1";
    },
    patchCard: async (_messageId: string, card: object): Promise<void> => {
      captured.push(card as CardWithConfig);
    },
  } as unknown as LarkHttpClient;
  return new LarkCardPresenter({ http, logger });
}

function permissionRequest(): acp.RequestPermissionRequest {
  return {
    sessionId: "sess_1",
    toolCall: { toolCallId: "tool_1", title: "Edit file", kind: "edit", status: "pending" },
    options: [{ kind: "allow_once", name: "允许", optionId: "allow" }],
  };
}

describe("LarkCardPresenter card summary", () => {
  it("adds processing / waiting / terminal summaries for home-list status", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendUnifiedCard("om_1", {
      status: "received",
      entries: [],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
    });
    await presenter.updateUnifiedCard("card_1", {
      status: "preparing",
      entries: [],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });
    await presenter.updateUnifiedCard("card_1", {
      status: "thinking",
      entries: [],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
    });
    await presenter.updateUnifiedCard("card_1", {
      status: "calling_tool",
      entries: [
        {
          kind: "tool",
          toolCallId: "tool_1",
          title: "Read file",
          toolKind: "read",
          status: "pending",
        },
      ],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
    });
    await presenter.sendInterruptCard("om_1", permissionRequest(), "req_1", "oc_1", null);
    await presenter.updateUnifiedCard("card_1", {
      status: "complete",
      entries: [{ kind: "text", text: "done" }],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });

    expect(cards.map((card) => card.config?.summary?.content)).toEqual([
      "📩 消息已收到",
      "🔄 准备中...",
      "💭 思考中...",
      "🔄 处理中...",
      "⏳ 待确认",
      "✅ 已结束",
    ]);
    expect(cards[0]?.body?.elements?.[0]?.content).toContain("已收到消息");
    expect(cards[1]?.body?.elements?.[0]?.content).toContain("正在启动或连接 Agent");
    expect(cards[2]?.body?.elements?.[0]?.content).toContain("已转发给 Agent");
    expect(cards[3]?.header?.title?.content).toBe("🔄 处理中...");
    expect(cards[4]?.header?.title?.content).toBe("⏳ 待确认");
  });

  it("renders sealed message cards as still-in-progress", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendUnifiedCard("om_1", {
      status: "sealed",
      entries: [{ kind: "text", text: "before approve" }],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });

    expect(cards[0]?.header?.title?.content).toBe("✅ 已结束");
    expect(cards[0]?.header?.template).toBe("blue");
    expect(cards[0]?.config?.summary?.content).toBe("✅ 已结束");
  });

  it("renders an explicit empty-output warning for terminal cards with no entries", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.updateUnifiedCard("card_1", {
      status: "complete",
      entries: [],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });

    const content = cards[0]?.body?.elements?.[0]?.content ?? "";
    expect(cards[0]?.header?.title?.content).toBe("⚠️ 空回复");
    expect(cards[0]?.header?.template).toBe("orange");
    expect(cards[0]?.config?.summary?.content).toBe("⚠️ 空回复");
    expect(content).toContain("Agent 本轮结束了，但没有产生任何可显示内容");
    expect(content).not.toContain("准备中");
  });

  it("keeps empty failed cards visibly failed instead of using the empty-output warning", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.updateUnifiedCard("card_1", {
      status: "failed",
      entries: [],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });

    const content = cards[0]?.body?.elements?.[0]?.content ?? "";
    expect(cards[0]?.header?.title?.content).toBe("⚠️ 出错");
    expect(cards[0]?.header?.template).toBe("red");
    expect(cards[0]?.config?.summary?.content).toBe("⚠️ 出错");
    expect(content).toContain("本轮任务出错");
  });

  it("always renders session metadata at the bottom of conversation cards", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const meta = {
      agent: "Claude",
      mode: "Plan Mode",
      model: "Claude Sonnet 5",
      permission: "Edit Automatically: on",
    };

    await presenter.sendUnifiedCard("om_1", {
      status: "responding",
      entries: [{ kind: "text", text: "working" }],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
      meta,
    });
    await presenter.updateUnifiedCard("card_1", {
      status: "complete",
      entries: [{ kind: "text", text: "done" }],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
      meta,
    });

    for (const card of cards) {
      const elements = card.body?.elements ?? [];
      expect(elements.at(-1)).toMatchObject({
        tag: "markdown",
        content:
          '<font color="grey">Agent: Claude · Mode: Plan Mode · Model: Claude Sonnet 5 · Permission: Edit Automatically: on</font>',
      });
    }

    const runningElements = cards[0]?.body?.elements ?? [];
    expect(runningElements.at(-3)).toMatchObject({ tag: "button" });
    expect(runningElements.at(-1)).toMatchObject({ tag: "markdown" });
  });

  it("distinguishes approved and rejected permission cards", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.updatePermissionCard(
      "card_approve_once",
      "edit",
      "config.json",
      "允许本次",
      "allow_once",
    );
    await presenter.updatePermissionCard(
      "card_approve_always",
      "edit",
      "config.json",
      "总是允许",
      "allow_always",
    );
    await presenter.updatePermissionCard(
      "card_reject_once",
      "edit",
      "config.json",
      "拒绝本次",
      "reject_once",
    );
    await presenter.updatePermissionCard(
      "card_reject_always",
      "edit",
      "config.json",
      "总是拒绝",
      "reject_always",
    );

    expect(cards[0]?.header?.title?.content).toBe("✅ 已批准（本次）");
    expect(cards[0]?.header?.template).toBe("green");
    expect(cards[0]?.config?.summary?.content).toBe("✅ 已批准（本次）");
    expect(cards[1]?.header?.title?.content).toBe("✅ 已批准（永久）");
    expect(cards[1]?.header?.template).toBe("green");
    expect(cards[1]?.config?.summary?.content).toBe("✅ 已批准（永久）");
    expect(cards[2]?.header?.title?.content).toBe("❌ 已拒绝（本次）");
    expect(cards[2]?.header?.template).toBe("red");
    expect(cards[2]?.config?.summary?.content).toBe("❌ 已拒绝（本次）");
    expect(cards[3]?.header?.title?.content).toBe("❌ 已拒绝（永久）");
    expect(cards[3]?.header?.template).toBe("red");
    expect(cards[3]?.config?.summary?.content).toBe("❌ 已拒绝（永久）");
  });

  it("sends topic cards as in-thread replies", async () => {
    const cards: CardWithConfig[] = [];
    const calls: ReplyCardCall[] = [];
    const presenter = makePresenter(cards, calls);

    await presenter.sendUnifiedCard("om_1", {
      status: "thinking",
      entries: [],
      cancellable: true,
      chatId: "oc_1",
      threadId: "omt_1",
    });
    await presenter.sendInterruptCard("om_1", permissionRequest(), "req_1", "oc_1", "omt_1");

    expect(calls.map((call) => call.opts?.replyInThread)).toEqual([true, true]);
  });

  it("truncates oversized notice card bodies", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.replyNoticeCard("om_1", {
      title: "⚠️ Agent 异常退出",
      body: `Agent crashed\n\nstderr (最后 50 行):\n${"x".repeat(NOTICE_BODY_CHAR_LIMIT + 1_000)}`,
      template: "red",
    });

    const content = cards[0]?.body?.elements?.[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(NOTICE_BODY_CHAR_LIMIT);
    expect(content).toContain("内容过长，已截断");
    expect(content).toContain("bridge.log");
  });
});
