import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkCardPresenter } from "./lark-presenter.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";

interface CardWithConfig {
  config?: { summary?: { content?: string } };
  header?: { title?: { content?: string } };
}

interface PostPayload {
  content?: Array<Array<{ tag?: string; text?: string }>>;
}

interface ReplyCardCall {
  card: CardWithConfig;
  opts?: { replyInThread?: boolean };
}

interface ReplyPostCall {
  post: PostPayload;
  opts?: { replyInThread?: boolean };
}

interface UpdatePostCall {
  messageId: string;
  post: PostPayload;
}

const logger: LarkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function postText(post: PostPayload | undefined): string {
  return post?.content?.flatMap((row) => row.map((item) => item.text ?? "")).join("\n") ?? "";
}

function makePresenter(captured: {
  cards?: ReplyCardCall[];
  posts?: ReplyPostCall[];
  updates?: UpdatePostCall[];
}): LarkCardPresenter {
  const http = {
    replyCard: async (
      _messageId: string,
      card: object,
      opts?: { replyInThread?: boolean },
    ): Promise<string> => {
      captured.cards?.push({ card: card as CardWithConfig, opts });
      return "card_1";
    },
    patchCard: async (_messageId: string, card: object): Promise<void> => {
      captured.cards?.push({ card: card as CardWithConfig });
    },
    replyPost: async (
      _messageId: string,
      post: object,
      opts?: { replyInThread?: boolean },
    ): Promise<string> => {
      captured.posts?.push({ post: post as PostPayload, opts });
      return "post_1";
    },
    updatePost: async (messageId: string, post: object): Promise<void> => {
      captured.updates?.push({ messageId, post: post as PostPayload });
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

describe("LarkCardPresenter Hermes-style rendering", () => {
  it("renders agent output as rich-text post messages instead of interactive cards", async () => {
    const cards: ReplyCardCall[] = [];
    const posts: ReplyPostCall[] = [];
    const presenter = makePresenter({ cards, posts });

    await presenter.sendUnifiedCard("om_1", {
      status: "responding",
      entries: [
        { kind: "text", text: "Hello **world**" },
        { kind: "thought", text: "Need to inspect files" },
        {
          kind: "tool",
          toolCallId: "tool_read",
          title: "Read file",
          toolKind: "read",
          status: "completed",
        },
      ],
      cancellable: true,
      chatId: "oc_1",
      threadId: null,
    });

    expect(cards).toHaveLength(0);
    expect(posts).toHaveLength(1);
    const text = postText(posts[0]?.post);
    expect(text).toContain("Hello **world**");
    expect(text).toContain("💭 思考");
    expect(text).toContain("Need to inspect files");
    expect(text).toContain("✅ **read**: Read file");
    expect(text).not.toContain("中断当前任务");
  });

  it("patches existing agent output by updating the post message", async () => {
    const updates: UpdatePostCall[] = [];
    const presenter = makePresenter({ updates });

    await presenter.updateUnifiedCard("post_1", {
      status: "complete",
      entries: [{ kind: "text", text: "done" }],
      cancellable: false,
      chatId: "oc_1",
      threadId: null,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe("post_1");
    expect(postText(updates[0]?.post)).toContain("done");
  });

  it("keeps approval prompts as interactive cards with waiting summary", async () => {
    const cards: ReplyCardCall[] = [];
    const presenter = makePresenter({ cards });

    await presenter.sendInterruptCard("om_1", permissionRequest(), "req_1", "oc_1", null);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.card.config?.summary?.content).toBe("⏳ 等待确认");
    expect(cards[0]?.card.header?.title?.content).toBe("⏳ 待确认");
  });

  it("sends both post output and approval cards as in-thread replies", async () => {
    const cards: ReplyCardCall[] = [];
    const posts: ReplyPostCall[] = [];
    const presenter = makePresenter({ cards, posts });

    await presenter.sendUnifiedCard("om_1", {
      status: "thinking",
      entries: [{ kind: "text", text: "Working" }],
      cancellable: true,
      chatId: "oc_1",
      threadId: "omt_1",
    });
    await presenter.sendInterruptCard("om_1", permissionRequest(), "req_1", "oc_1", "omt_1");

    expect(posts.map((call) => call.opts?.replyInThread)).toEqual([true]);
    expect(cards.map((call) => call.opts?.replyInThread)).toEqual([true]);
  });
});
