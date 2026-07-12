import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  COMMAND_RESULT_BODY_BYTE_LIMIT,
  LarkCardPresenter,
  NOTICE_BODY_BYTE_LIMIT,
} from "./lark-presenter.js";
import { CARD_MARKDOWN_ROTATION_BYTE_LIMIT, utf8ByteLength } from "./card-text-budget.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import type { ConversationCardFeatureGate } from "../bridge/conversation-card-feature.js";
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

function makePresenter(
  captured: CardWithConfig[],
  calls: ReplyCardCall[] = [],
  feature?: ConversationCardFeatureGate,
): LarkCardPresenter {
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
  return new LarkCardPresenter({ http, logger, feature });
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
      "📩 Humming 已收到消息",
      "🔄 正在启动或连接 Agent",
      "💭 Agent 正在思考",
      "🔄 read: Read file",
      "⏳ 待确认",
      "✅ 已结束",
    ]);
    expect(cards[0]?.body?.elements?.[0]?.content).toContain("已收到消息");
    expect(cards[1]?.body?.elements?.[0]?.content).toContain("正在启动或连接 Agent");
    expect(cards[2]?.body?.elements?.[0]?.content).toContain("已转发给 Agent");
    expect(cards[3]?.header?.title?.content).toBe("🔄 处理中...");
    expect(cards[4]?.header?.title?.content).toBe("⏳ 待确认");
  });

  it("surfaces the latest thought in a thinking summary", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendUnifiedCard("om_1", {
      status: "thinking",
      entries: [{ kind: "thought", text: "**Inspecting** the request" }],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
    });

    expect(cards[0]?.config?.summary?.content).toBe("💭 Inspecting the request");
  });

  it("renders sealed conversation fragments without a status-colored header", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.sendUnifiedCard("om_1", {
      status: "sealed",
      entries: [{ kind: "text", text: "before approve" }],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
      meta: {
        agent: "Claude",
        mode: "Plan Mode",
        model: "Claude Sonnet 5",
        permission: "Edit Automatically: on",
      },
    });

    expect(cards[0]?.header).toBeUndefined();
    expect(cards[0]?.config?.summary?.content).toBe("before approve");
    expect(JSON.stringify(cards[0])).not.toContain("Agent: Claude");
  });

  it("renders completed conversation cards as ended and mirrors that status in summaries", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    await presenter.updateUnifiedCard("card_1", {
      status: "complete",
      entries: [
        {
          kind: "text",
          text: "**第一条消息** 这里是一个很长的 conversation card 开头，用来做外层 summary，不能再显示成功态勾选。".repeat(
            3,
          ),
        },
        { kind: "text", text: "second message should not drive the summary" },
      ],
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

  it("renders session metadata on running and titled terminal conversation cards", async () => {
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
  const enabled = Object.freeze({ v2Enabled: true });
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

  it("keeps semantic methods transport-inert by default", async () => {
    const cards: CardWithConfig[] = [];
    const presenter = makePresenter(cards);

    expect(await presenter.sendConversationCard("om_1", active)).toBeNull();
    expect(await presenter.updateConversationCard("card_1", active)).toBe(false);
    expect(cards).toEqual([]);
  });

  it("renders an explicitly enabled active card with the exact Cancel V2 payload", async () => {
    const cards: CardWithConfig[] = [];
    const calls: ReplyCardCall[] = [];
    const presenter = makePresenter(cards, calls, enabled);

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
    const presenter = makePresenter(cards, [], enabled);
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
    const presenter = makePresenter(cards, [], enabled);
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
    ];

    for (const [index, view] of views.entries()) {
      if (index % 2 === 0) await presenter.sendConversationCard("om_1", view);
      else await presenter.updateConversationCard("card_1", view);
    }

    expect(cards.map((card) => card.header?.title?.content)).toEqual([
      "⏳ 消息已排队",
      "⚡ 正在中断当前任务",
      "🔄 准备中...",
      "对话片段",
      "✍️ 回复中...",
      undefined,
      "✅ 已结束",
    ]);
    expect(cards.map((card) => card.config?.summary?.content)).toEqual([
      "⏳ 等待处理",
      "⚡ 正在中断当前任务",
      "🔄 正在启动或连接 Agent",
      "对话片段",
      "✍️ answer",
      "history",
      "✅ 已结束",
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
    const presenter = new LarkCardPresenter({ http, logger: invalidLogger, feature: enabled });
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
    const presenter = new LarkCardPresenter({ http, logger: invalidLogger, feature: enabled });
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
      { kind: "active", header: "responding", entries: [], profile, route },
      { kind: "active", header: "calling_tool", entries: [], profile, route },
      {
        kind: "active",
        header: "waiting",
        entries: [{ kind: "text", text: "unexpected" }],
        profile,
        route,
      },
      { kind: "archived", entries: [running], summary: "x", route },
      {
        kind: "terminal",
        header: "failed",
        entries: [running],
        profile,
        body: "content",
        route,
      },
      {
        kind: "terminal",
        header: "complete",
        entries: [],
        profile,
        body: "content",
        route,
      },
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
