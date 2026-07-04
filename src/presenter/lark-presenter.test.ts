import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkCardPresenter } from "./lark-presenter.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";

interface CardWithConfig {
  config?: { summary?: { content?: string } };
  header?: { title?: { content?: string } };
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
      status: "thinking",
      entries: [],
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
      "🔄 处理中…",
      "⏳ 等待确认",
      "✅ 已完成",
    ]);
    expect(cards[1]?.header?.title?.content).toBe("⏳ 待确认");
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

    expect(cards[0]?.header?.title?.content).toBe("🔄 进行当中");
    expect(cards[0]?.config?.summary?.content).toBe("🔄 处理中…");
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
});
