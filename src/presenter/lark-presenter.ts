import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import type {
  LarkPresenter,
  NoticeCardSpec,
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

// Card JSON 2.0 — used only for interactive approval / notice cards now that
// ordinary agent output follows Hermes-style rich-text post messages.
// https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;

function buildV2Card(
  headerContent: string,
  headerTemplate: string,
  elements: readonly object[],
  summaryContent: string,
): object {
  return {
    schema: CARD_SCHEMA_V2,
    config: { ...CARD_CONFIG_V2, summary: { content: summaryContent } },
    header: {
      title: { tag: "plain_text" as const, content: headerContent },
      template: headerTemplate,
    },
    body: { elements },
  };
}

function buttonTypeForKind(kind: string): "primary" | "danger" | "default" {
  if (kind === "allow_always") return "primary";
  if (kind === "reject_once" || kind === "reject_always") return "danger";
  return "default";
}

/** v2 buttons live directly in `elements`; the v1 `tag: "action"` wrapper
 *  was removed in schema 2.0. Custom payload goes into a `callback`
 *  behavior — top-level `value` on the button is deprecated. */
function buildCallbackButton(
  text: string,
  type: "primary" | "danger" | "default",
  value: object,
): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function buildPermissionCard(
  params: acp.RequestPermissionRequest,
  requestId: string,
  chatId: string,
  threadId: string | null,
): object {
  const toolTitle = params.toolCall?.title ?? "unknown";
  const toolKind = params.toolCall?.kind ?? "tool";

  const elements: object[] = [{ tag: "markdown", content: `**${toolKind}**: ${toolTitle}` }];

  for (const opt of params.options) {
    elements.push(
      buildCallbackButton(opt.name, buttonTypeForKind(opt.kind), {
        r: requestId,
        o: opt.optionId,
        n: opt.name,
        k: toolKind,
        t: toolTitle,
        c: chatId,
        // Omit `th` for the main (non-topic) conversation so those cards stay
        // byte-identical to the pre-topic payload; the bridge reads a missing
        // `th` as null. Topic cards carry their thread id explicitly.
        ...(threadId !== null ? { th: threadId } : {}),
      }),
    );
  }

  return buildV2Card("⏳ 待确认", HEADER_TEMPLATE_PERMISSION, elements, "⏳ 等待确认");
}

function buildResolvedCard(toolKind: string, toolTitle: string, selectedName: string): object {
  return buildV2Card(
    "已确认",
    HEADER_TEMPLATE_RESOLVED,
    [
      {
        tag: "markdown",
        content: `**${toolKind}**: ${toolTitle}\n\n已选择: **${selectedName}**`,
      },
    ],
    "✅ 已完成",
  );
}

function buildNoticeCard(notice: NoticeCardSpec): object {
  return buildV2Card(
    notice.title,
    notice.template,
    [{ tag: "markdown", content: notice.body }],
    notice.title,
  );
}

function buildExpiredCard(reason: string): object {
  return buildV2Card(
    "已失效",
    HEADER_TEMPLATE_EXPIRED,
    [{ tag: "markdown", content: reason }],
    "⛔ 已取消",
  );
}

function assertNever(x: never): never {
  throw new Error(`unexpected timeline entry: ${String(x)}`);
}

/** Render one non-thought timeline entry to a markdown snippet. Thought
 *  entries take a separate path (a collapsible panel) since Lark's
 *  markdown element does not render blockquote styling. */
function nonThoughtEntryToMarkdown(entry: Exclude<TimelineEntry, { kind: "thought" }>): string {
  switch (entry.kind) {
    case "text":
      return entry.text;
    case "tool": {
      const mark = STATUS_MARKS[entry.status];
      return `${mark} **${entry.toolKind}**: ${entry.title}`;
    }
    default:
      return assertNever(entry);
  }
}

function thoughtToMarkdown(text: string): string {
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> 💭 思考\n${quoted}`;
}

function timelineEntryToMarkdown(entry: TimelineEntry): string {
  if (entry.kind === "thought") return thoughtToMarkdown(entry.text);
  return nonThoughtEntryToMarkdown(entry);
}

function buildUnifiedPostMarkdown(state: UnifiedCardState): string {
  if (state.entries.length === 0) return "_准备中..._";
  return state.entries.map(timelineEntryToMarkdown).join("\n\n---\n\n");
}

export interface LarkCardPresenterOptions {
  http: LarkHttpClient;
  logger: LarkLogger;
}

/**
 * Default {@link LarkPresenter} implementation using Lark
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

  async sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<string | null> {
    return this.http.replyCard(
      messageId,
      buildPermissionCard(params, requestId, chatId, threadId),
      {
        replyInThread: threadId !== null,
      },
    );
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

  async replyNoticeCard(replyToMessageId: string, notice: NoticeCardSpec): Promise<void> {
    try {
      await this.http.replyCard(replyToMessageId, buildNoticeCard(notice));
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "replyNoticeCard failed");
    }
  }

  async sendUnifiedCard(replyToMessageId: string, state: UnifiedCardState): Promise<string | null> {
    try {
      return await this.http.replyPost(
        replyToMessageId,
        markdownToPost(buildUnifiedPostMarkdown(state)),
        {
          replyInThread: state.threadId !== null,
        },
      );
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "sendUnifiedPost failed");
      return null;
    }
  }

  async updateUnifiedCard(cardMessageId: string, state: UnifiedCardState): Promise<void> {
    try {
      await this.http.updatePost(cardMessageId, markdownToPost(buildUnifiedPostMarkdown(state)));
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, "updateUnifiedPost failed");
    }
  }
}
