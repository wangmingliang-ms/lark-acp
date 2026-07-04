import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import type {
  AgentStatus,
  LarkPresenter,
  NoticeCardSpec,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "./presenter.js";

const STATUS_MARKS: Record<ToolStatus, string> = {
  pending: ":OneSecond:",
  in_progress: ":OnIt:",
  completed: ":CheckMark:",
  failed: ":ERROR:",
};

const HEADER_TEMPLATE_PERMISSION = "blue";
const HEADER_TEMPLATE_RESOLVED = "green";
const HEADER_TEMPLATE_EXPIRED = "grey";

const STATUS_HEADER: Record<AgentStatus, { content: string; template: string }> = {
  thinking: { content: ":Thinking: 思考中...", template: "wathet" },
  calling_tool: { content: ":OnIt: 调用工具...", template: "blue" },
  responding: { content: ":Writing: 回复中...", template: "blue" },
  sealed: { content: ":OnIt: 进行当中", template: "blue" },
  complete: { content: ":CheckMark: 已完成", template: "green" },
  cancelled: { content: ":CrossMark: 已取消", template: "grey" },
  failed: { content: ":ERROR: 出错", template: "red" },
};

const CANCEL_BUTTON_TEXT = "中断当前任务";

// Card JSON 2.0 — required for the `collapsible_panel` element used by
// thought entries. v1.0 cards silently degrade unknown components to
// plaintext, which is why thoughts previously rendered uncollapsed.
// https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;

function summaryForStatus(status: AgentStatus): string {
  switch (status) {
    case "complete":
      return ":CheckMark: 已完成";
    case "cancelled":
      return ":CrossMark: 已取消";
    case "failed":
      return ":ERROR: 出错";
    case "thinking":
    case "calling_tool":
    case "responding":
    case "sealed":
      return ":OnIt: 处理中…";
    default:
      return assertNeverStatus(status);
  }
}

function assertNeverStatus(x: never): never {
  throw new Error(`unexpected agent status: ${String(x)}`);
}

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

  return buildV2Card(
    ":OneSecond: 待确认",
    HEADER_TEMPLATE_PERMISSION,
    elements,
    ":OneSecond: 等待确认",
  );
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
    ":CheckMark: 已完成",
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
    ":CrossMark: 已取消",
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
      const head = `${mark} **${entry.toolKind}**: ${entry.title}`;
      return entry.detail ? `${head}\n\n${entry.detail}` : head;
    }
    default:
      return assertNever(entry);
  }
}

function buildThoughtPanel(text: string): object {
  // Aligned with the canonical v2 sample (plain_text title, icon_position
  // "right"). Lark's v2 renderer falls back to plaintext when any field on
  // collapsible_panel is unrecognized — so deviate from the sample only
  // when necessary.
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "plain_text", content: ":Thinking: 思考" },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: text }],
  };
}

function entryToCardElement(entry: TimelineEntry): object {
  if (entry.kind === "thought") return buildThoughtPanel(entry.text);
  return { tag: "markdown", content: nonThoughtEntryToMarkdown(entry) };
}

function buildUnifiedCard(state: UnifiedCardState): object {
  const elements: object[] = [];

  if (state.entries.length === 0) {
    elements.push({ tag: "markdown", content: "_准备中..._" });
  } else {
    state.entries.forEach((entry, i) => {
      // Don't draw a divider directly above a collapsible panel — the
      // panel already has its own border and the extra hr looks noisy.
      if (i > 0 && entry.kind !== "thought") elements.push({ tag: "hr" });
      elements.push(entryToCardElement(entry));
    });
  }

  if (state.cancellable) {
    elements.push({ tag: "hr" });
    elements.push(
      buildCallbackButton(CANCEL_BUTTON_TEXT, "danger", {
        cancel: true,
        c: state.chatId,
        // See buildPermissionCard: `th` omitted for the main conversation.
        ...(state.threadId !== null ? { th: state.threadId } : {}),
      }),
    );
  }

  const header = STATUS_HEADER[state.status];
  return buildV2Card(header.content, header.template, elements, summaryForStatus(state.status));
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
      return await this.http.replyCard(replyToMessageId, buildUnifiedCard(state), {
        replyInThread: state.threadId !== null,
      });
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
