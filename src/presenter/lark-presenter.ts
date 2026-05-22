import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import type {
  AgentStatus,
  LarkPresenter,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "./presenter.js";

const STATUS_MARKS: Record<ToolStatus, string> = {
  pending: "⏸",
  in_progress: "⏳",
  completed: "✅",
  failed: "❌",
};

const HEADER_TEMPLATE_PERMISSION = "blue";
const HEADER_TEMPLATE_RESOLVED = "green";
const HEADER_TEMPLATE_EXPIRED = "grey";

const STATUS_HEADER: Record<AgentStatus, { content: string; template: string }> = {
  thinking: { content: "💭 思考中...", template: "wathet" },
  calling_tool: { content: "🛠 调用工具...", template: "blue" },
  responding: { content: "✍️ 回复中...", template: "blue" },
  complete: { content: "✅ 已完成", template: "green" },
  cancelled: { content: "⛔ 已取消", template: "grey" },
  failed: { content: "⚠️ 出错", template: "red" },
};

const CANCEL_BUTTON_TEXT = "中断当前任务";

function buttonTypeForKind(kind: string): "primary" | "danger" | "default" {
  if (kind === "allow_always") return "primary";
  if (kind === "reject_once" || kind === "reject_always") return "danger";
  return "default";
}

function buildPermissionCard(
  params: acp.RequestPermissionRequest,
  requestId: string,
  chatId: string,
): object {
  const toolTitle = params.toolCall?.title ?? "unknown";
  const toolKind = params.toolCall?.kind ?? "tool";

  const elements: object[] = [{ tag: "markdown", content: `**${toolKind}**: ${toolTitle}` }];

  for (const opt of params.options) {
    elements.push({
      tag: "action",
      layout: "flow",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: opt.name },
          type: buttonTypeForKind(opt.kind),
          value: {
            r: requestId,
            o: opt.optionId,
            n: opt.name,
            k: toolKind,
            t: toolTitle,
            c: chatId,
          },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "Agent 需要确认" },
      template: HEADER_TEMPLATE_PERMISSION,
    },
    elements,
  };
}

function buildResolvedCard(toolKind: string, toolTitle: string, selectedName: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "已确认" },
      template: HEADER_TEMPLATE_RESOLVED,
    },
    elements: [
      {
        tag: "markdown",
        content: `**${toolKind}**: ${toolTitle}\n\n已选择: **${selectedName}**`,
      },
    ],
  };
}

function buildExpiredCard(reason: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "已失效" },
      template: HEADER_TEMPLATE_EXPIRED,
    },
    elements: [{ tag: "markdown", content: reason }],
  };
}

/** Render one timeline entry to a markdown snippet. Each snippet becomes
 *  its own card element; consecutive entries are separated by `hr`. */
function entryToMarkdown(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "text":
      return entry.text;
    case "thought":
      // Use blockquote so thoughts visually group differently from output.
      return entry.text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "tool": {
      const mark = STATUS_MARKS[entry.status];
      const head = `${mark} **${entry.toolKind}**: ${entry.title}`;
      return entry.detail ? `${head}\n\n${entry.detail}` : head;
    }
  }
}

function buildUnifiedCard(state: UnifiedCardState): object {
  const elements: object[] = [];

  if (state.entries.length === 0) {
    elements.push({ tag: "markdown", content: "_准备中..._" });
  } else {
    state.entries.forEach((entry, i) => {
      if (i > 0) elements.push({ tag: "hr" });
      elements.push({ tag: "markdown", content: entryToMarkdown(entry) });
    });
  }

  if (state.cancellable) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      layout: "flow",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: CANCEL_BUTTON_TEXT },
          type: "danger",
          value: { cancel: true, c: state.chatId },
        },
      ],
    });
  }

  const header = STATUS_HEADER[state.status];
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: header.content },
      template: header.template,
    },
    elements,
  };
}

export interface LarkCardPresenterOptions {
  http: LarkHttpClient;
  logger: LarkLogger;
}

/**
 * Default {@link LarkPresenter} implementation using Lark / Feishu
 * interactive cards via {@link LarkHttpClient}.
 */
export class LarkCardPresenter implements LarkPresenter {
  private readonly http: LarkHttpClient;
  private readonly logger: LarkLogger;

  constructor(opts: LarkCardPresenterOptions) {
    this.http = opts.http;
    this.logger = opts.logger.child({ name: "presenter" });
  }

  async replyText(messageId: string, text: string): Promise<void> {
    for (const chunk of splitMarkdown(text)) {
      const post = markdownToPost(chunk);
      await this.http.replyPost(messageId, post);
    }
  }

  async addReaction(messageId: string, emoji?: string): Promise<string | null> {
    return this.http.addReaction(messageId, emoji);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.http.removeReaction(messageId, reactionId);
  }

  async sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
  ): Promise<string | null> {
    return this.http.replyCard(messageId, buildPermissionCard(params, requestId, chatId));
  }

  async updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
  ): Promise<void> {
    await this.http.patchCard(messageId, buildResolvedCard(toolKind, toolTitle, selectedName));
  }

  async expirePermissionCard(messageId: string, reason: string): Promise<void> {
    try {
      await this.http.patchCard(messageId, buildExpiredCard(reason));
    } catch (err) {
      this.logger.warn({ err, messageId }, "expirePermissionCard failed");
    }
  }

  async sendUnifiedCard(replyToMessageId: string, state: UnifiedCardState): Promise<string | null> {
    try {
      return await this.http.replyCard(replyToMessageId, buildUnifiedCard(state));
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "sendUnifiedCard failed");
      return null;
    }
  }

  async updateUnifiedCard(cardMessageId: string, state: UnifiedCardState): Promise<void> {
    try {
      await this.http.patchCard(cardMessageId, buildUnifiedCard(state));
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, "updateUnifiedCard failed");
    }
  }
}
