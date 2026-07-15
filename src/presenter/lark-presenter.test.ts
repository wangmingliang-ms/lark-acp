import { describe, expect, it } from "vitest";
import {
  COMMAND_RESULT_BODY_BYTE_LIMIT,
  LarkCardPresenter,
  NOTICE_BODY_BYTE_LIMIT,
} from "./lark-presenter.js";
import { CARD_MARKDOWN_ROTATION_BYTE_LIMIT, utf8ByteLength } from "./card-text-budget.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import type {
  ActionToken,
  ConversationCardView,
  PermissionToken,
  PromptToken,
  SegmentToken,
} from "./conversation-card-view.js";
import type { PermissionCardView } from "./presenter.js";

interface CardElement {
  tag?: string;
  content?: string;
  elements?: CardElement[];
  text?: { content?: string };
  behaviors?: { type?: string; value?: Record<string, unknown> }[];
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

describe("LarkCardPresenter card summary", () => {
  it("accepts asynchronous active snapshots and renders Cancel", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const base = {
      profile: null,
      cancelAction: {
        p: "prompt" as PromptToken,
        s: "segment" as SegmentToken,
        a: "action" as ActionToken,
      },
      route: { c: "chat", th: "thread" },
    } as const;

    await expect(
      presenter.sendConversationCard("message", {
        kind: "active",
        header: "waiting",
        entries: [{ kind: "text", text: "已有内容" }],
        ...base,
      }),
    ).resolves.toBe("card_1");
    await expect(
      presenter.sendConversationCard("message", {
        kind: "active",
        header: "responding",
        entries: [],
        ...base,
      }),
    ).resolves.toBe("card_1");
    await expect(
      presenter.sendConversationCard("message", {
        kind: "active",
        header: "calling_tool",
        entries: [],
        ...base,
      }),
    ).resolves.toBe("card_1");

    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(
        card.body?.elements?.some(
          (element) => element.tag === "button" && element.text?.content === "中断当前任务",
        ),
      ).toBe(true);
    }
  });

  it("renders thinking as the current activity instead of exposing Thought text", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendConversationCard("message", {
      kind: "active",
      header: "thinking",
      entries: [{ kind: "thought", text: "内部推理细节" }],
      profile: null,
      route: { c: "chat", th: "thread" },
    });

    expect(cards[0]?.config?.summary?.content).toBe("💭 Agent 正在思考");
    expect(cards[0]?.config?.summary?.content).not.toContain("内部推理细节");
  });

  it("renders the current Tool Summary without a synthetic tool prefix", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendConversationCard("message", {
      kind: "active",
      header: "calling_tool",
      activityTitle: "Viewing AccountActions.java",
      entries: [
        {
          kind: "tool",
          toolCallId: "tool-1",
          title: "Viewing AccountActions.java",
          toolKind: "tool",
          status: "in_progress",
        },
      ],
      profile: null,
      route: { c: "chat", th: "thread" },
    });

    expect(cards[0]?.config?.summary?.content).toBe("🔄 Viewing AccountActions.java");
    expect(cards[0]?.config?.summary?.content).not.toContain("tool:");
  });

  it("groups consecutive Tool Calls without hiding visible Thought boundaries", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendConversationCard("message", {
      kind: "active",
      header: "calling_tool",
      entries: [
        {
          kind: "tool",
          toolCallId: "tool-1",
          title: "Read first file",
          toolKind: "tool",
          status: "completed",
        },
        {
          kind: "tool",
          toolCallId: "tool-2",
          title: "Read second file",
          toolKind: "tool",
          status: "completed",
        },
        { kind: "thought", text: "Reviewing the results" },
        {
          kind: "tool",
          toolCallId: "tool-3",
          title: "Run tests",
          toolKind: "tool",
          status: "in_progress",
        },
      ],
      profile: null,
      route: { c: "chat", th: "thread" },
    });

    expect(cards[0]?.body?.elements?.map((element) => element.tag)).toEqual([
      "markdown",
      "markdown",
      "hr",
      "collapsible_panel",
      "hr",
      "markdown",
    ]);
  });

  it("labels a newly received semantic Response as received, not queued behind prior work", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    await expect(
      presenter.sendConversationCard("message", {
        kind: "queued",
        header: "queued",
        entries: [],
        profile: null,
        route: { c: "chat", th: "thread" },
      }),
    ).resolves.toBe("card_1");
    expect(cards[0]?.header?.title?.content).toBe("📩 消息已收到");
    expect(cards[0]?.body?.elements?.[0]?.content).toContain("已收到消息");
    expect(JSON.stringify(cards[0])).not.toContain("前一任务仍在进行");
  });

  it("renders an interrupted Response with the lightning icon", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendConversationCard("message", {
      kind: "terminal",
      header: "interrupted",
      entries: [{ kind: "text", text: "任务被后续消息中断" }],
      profile: null,
      body: "content",
      route: { c: "chat", th: "thread" },
    });

    expect(cards[0]?.header?.title?.content).toBe("⚡ 已中断");
  });

  it("truncates oversized notice card bodies at the compact notice limit", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.replyNoticeCard("om_1", {
      title: "⚠️ Agent 异常退出",
      body: `Agent crashed\n\nstderr (最后 50 行):\n${"x".repeat(NOTICE_BODY_BYTE_LIMIT + 1_000)}`,
      template: "red",
    });

    const contents = (cards[0]?.body?.elements ?? [])
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content ?? "");
    const content = contents.join("");
    expect(NOTICE_BODY_BYTE_LIMIT).toBe(1_500);
    expect(content.length).toBeLessThanOrEqual(NOTICE_BODY_BYTE_LIMIT);
    expect(contents).toHaveLength(1);
    expect(content).toContain("内容过长，已截断");
    expect(content).toContain("bridge.log");
  });

  it("renders command result cards with the message-card 4096 character budget", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const body = `Capabilities\n\n${"model description\n".repeat(180)}`;

    await presenter.replyCommandResultCard("om_1", {
      title: "🧩 Agent capabilities",
      body,
      template: "blue",
    });

    const elements = cards[0]?.body?.elements ?? [];
    const rendered = elements
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content ?? "")
      .join("");
    expect(COMMAND_RESULT_BODY_BYTE_LIMIT).toBe(CARD_MARKDOWN_ROTATION_BYTE_LIMIT);
    expect(utf8ByteLength(rendered)).toBeLessThanOrEqual(COMMAND_RESULT_BODY_BYTE_LIMIT);
    expect(rendered).toBe(body);
    expect(rendered).not.toContain("内容过长，已截断");
    expect(elements.filter((element) => element.tag === "markdown").length).toBeGreaterThan(1);
  });

  it("truncates oversized command result card bodies at the message-card budget", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.replyCommandResultCard("om_1", {
      title: "🧩 Agent capabilities",
      body: `Capabilities\n\n${"x".repeat(COMMAND_RESULT_BODY_BYTE_LIMIT + 1_000)}`,
      template: "blue",
    });

    const contents = (cards[0]?.body?.elements ?? [])
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content ?? "");
    const content = contents.join("");
    expect(utf8ByteLength(content)).toBeLessThanOrEqual(COMMAND_RESULT_BODY_BYTE_LIMIT);
    expect(contents.every((chunk) => utf8ByteLength(chunk) <= 3_000)).toBe(true);
    expect(content).toContain("结果内容超过限制，已截断");
  });

  it("truncates multibyte command results with the shared UTF-8 budget", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const body = "界".repeat(
      Math.floor(COMMAND_RESULT_BODY_BYTE_LIMIT / utf8ByteLength("界")) + 1_000,
    );
    expect(body.length).toBeLessThan(COMMAND_RESULT_BODY_BYTE_LIMIT);
    expect(utf8ByteLength(body)).toBeGreaterThan(COMMAND_RESULT_BODY_BYTE_LIMIT);

    await presenter.replyCommandResultCard("om_1", {
      title: "🧩 Agent capabilities",
      body,
      template: "blue",
    });

    const content = (cards[0]?.body?.elements ?? [])
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content ?? "")
      .join("");
    expect(utf8ByteLength(content)).toBeLessThanOrEqual(COMMAND_RESULT_BODY_BYTE_LIMIT);
    expect(content).toContain("结果内容超过限制，已截断");
  });
});

describe("LarkCardPresenter semantic conversation cards", () => {
  const route = { c: "oc_semantic", th: "omt_semantic" } as const;
  const profile = {
    agent: "Claude",
    mode: "Plan Mode",
    model: "Claude Sonnet 5",
    permission: "Ask",
  } as const;
  const active: ConversationCardView = {
    kind: "active",
    header: "responding",
    entries: [{ kind: "text", text: "answer" }],
    profile,
    cancelAction: {
      p: "prompt_1" as PromptToken,
      s: "segment_1" as SegmentToken,
      a: "action_1" as ActionToken,
    },
    route,
  };

  it("renders an active card with the exact Cancel payload", async () => {
    const cards: CardWithConfig[] = [];
    const calls: ReplyCardCall[] = [];
    const presenter = makePresenter(cards, calls);

    expect(await presenter.sendConversationCard("om_1", active)).toBe("card_1");

    expect(calls[0]?.opts).toEqual({ replyInThread: true });
    expect(cards[0]?.header).toEqual({
      title: { tag: "plain_text", content: "✍️ 回复中..." },
      template: "blue",
    });
    expect(cards[0]?.config?.summary?.content).toBe("✍️ answer");
    expect(cards[0]?.body?.elements?.filter((element) => element.tag === "button")).toEqual([
      expect.objectContaining({
        text: { tag: "plain_text", content: "中断当前任务" },
        behaviors: [
          {
            type: "callback",
            value: {
              v: 2,
              c: "oc_semantic",
              th: "omt_semantic",
              cancel: true,
              p: "prompt_1",
              s: "segment_1",
              a: "action_1",
            },
          },
        ],
      }),
    ]);
  });

  it("renders semantic permission actions with prompt and permission authority", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const permission: PermissionCardView = {
      route,
      promptToken: "prompt_1" as PromptToken,
      permissionToken: "permission_1" as PermissionToken,
      requestId: "request_1",
      title: "Permission required",
      toolKind: "edit",
      toolTitle: "Edit file",
      options: [{ id: "allow", label: "允许", kind: "allow_once" }],
    };

    expect(await presenter.sendPermissionRequestCard("om_1", permission)).toBe("card_1");
    expect(cards[0]?.body?.elements?.filter((element) => element.tag === "button")).toEqual([
      expect.objectContaining({
        behaviors: [
          {
            type: "callback",
            value: {
              v: 2,
              c: "oc_semantic",
              th: "omt_semantic",
              p: "prompt_1",
              q: "permission_1",
              r: "request_1",
              o: "allow",
            },
          },
        ],
      }),
    ]);
  });

  it("renders every semantic view kind through the public send and patch methods", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);
    const views: ConversationCardView[] = [
      { kind: "queued", header: "queued", entries: [], profile, route },
      { kind: "interrupting", header: "interrupting", entries: [], profile, route },
      { kind: "starting", header: "preparing", entries: [], profile, route },
      {
        kind: "orphaned",
        header: "orphaned",
        entries: [{ kind: "text", text: "stale" }],
        reason: "stale_handoff",
        route,
      },
      active,
      {
        kind: "archived",
        entries: [{ kind: "text", text: "**history**" }],
        summary: "**history**",
        route,
      },
      {
        kind: "terminal",
        header: "complete",
        entries: [{ kind: "text", text: "done" }],
        profile,
        body: "content",
        route,
      },
      {
        kind: "supplement",
        entries: [{ kind: "text", text: "extra detail" }],
        route,
      },
    ];

    for (const [index, view] of views.entries()) {
      if (index % 2 === 0) await presenter.sendConversationCard("om_1", view);
      else await presenter.updateConversationCard("card_1", view);
    }

    expect(cards.map((card) => card.header?.title?.content)).toEqual([
      "📩 消息已收到",
      "⚡ 正在中断当前任务",
      "🔄 准备中...",
      "对话片段",
      "✍️ 回复中...",
      undefined,
      "✅ 已结束",
      "补充更新",
    ]);
    expect(cards.map((card) => card.config?.summary?.content)).toEqual([
      "📩 Humming 已收到消息",
      "⚡ 正在中断当前任务",
      "🔄 正在启动或连接 Agent",
      "对话片段",
      "✍️ answer",
      "history",
      "✅ 已结束",
      "extra detail",
    ]);
    const serialized = cards.map((card) => JSON.stringify(card));
    expect(serialized[0]).toContain("Agent: Claude");
    expect(serialized[1]).toContain("Agent: Claude");
    expect(serialized[2]).toContain("Agent: Claude");
    expect(serialized[3]).not.toContain("Agent:");
    expect(serialized[3]).not.toContain('"tag":"button"');
    expect(serialized[4]).toContain('"tag":"button"');
    expect(serialized[5]).not.toContain("Agent:");
    expect(serialized[5]).not.toContain('"tag":"button"');
    expect(serialized[6]).toContain("Agent: Claude");
    expect(serialized[6]).not.toContain('"tag":"button"');
    expect(serialized[7]).not.toContain("Agent:");
    expect(serialized[7]).not.toContain('"tag":"button"');
  });

  it("rejects and logs malformed external semantic fixtures without transport calls", async () => {
    const cards: CardWithConfig[] = [];
    const warnings: unknown[][] = [];
    const invalidLogger: LarkLogger = {
      ...logger,
      warn: (...args: unknown[]) => warnings.push(args),
      child: () => invalidLogger,
    } as LarkLogger;
    const http = {
      replyCard: async (_messageId: string, card: object): Promise<string> => {
        cards.push(card as CardWithConfig);
        return "unexpected";
      },
    } as unknown as LarkHttpClient;
    const presenter = new LarkCardPresenter({ http, logger: invalidLogger });
    const malformed = {
      kind: "archived",
      entries: [],
      summary: "",
      route: { c: "oc_semantic" },
      cancelAction: { p: "prompt", s: "segment", a: "action" },
    } as unknown as ConversationCardView;

    expect(await presenter.sendConversationCard("om_1", malformed)).toBeNull();
    expect(cards).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("oc_semantic");
    expect(JSON.stringify(warnings)).not.toContain("prompt");
  });

  it("rejects semantic invariant violations at the runtime boundary", async () => {
    const calls: object[] = [];
    const warnings: unknown[][] = [];
    const invalidLogger: LarkLogger = {
      ...logger,
      warn: (...args: unknown[]) => warnings.push(args),
      child: () => invalidLogger,
    } as LarkLogger;
    const http = {
      replyCard: async (_messageId: string, card: object): Promise<string> => {
        calls.push(card);
        return "unexpected";
      },
    } as unknown as LarkHttpClient;
    const presenter = new LarkCardPresenter({ http, logger: invalidLogger });
    const route = { c: "sensitive-chat" };
    const profile = null;
    const running = {
      kind: "tool",
      toolCallId: "tool",
      title: "Run",
      toolKind: "execute",
      status: "in_progress",
    };
    const malformed = [
      { kind: "archived", entries: [running], summary: "x", route },
      {
        kind: "terminal",
        header: "complete",
        entries: [],
        profile,
        body: "content",
        route,
      },
      { kind: "supplement", entries: [], profile, route },
    ] as unknown as ConversationCardView[];

    for (const view of malformed) {
      expect(await presenter.sendConversationCard("om_1", view)).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(malformed.length);
    expect(JSON.stringify(warnings)).not.toContain("sensitive-chat");
    expect(JSON.stringify(warnings)).not.toContain("unexpected");
  });
});
