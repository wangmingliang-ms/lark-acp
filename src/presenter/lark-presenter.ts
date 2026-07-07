import type * as acp from "@agentclientprotocol/sdk";
import { CARD_MARKDOWN_SOFT_CHAR_LIMIT } from "../acp/humming-client.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import type {
  AgentStatus,
  CommandResultCardSpec,
  LarkPresenter,
  NoticeCardSpec,
  TimelineEntry,
  UnifiedCardState,
} from "./presenter.js";

const HEADER_TEMPLATE_PERMISSION = "blue";
const HEADER_TEMPLATE_APPROVED = "green";
const HEADER_TEMPLATE_REJECTED = "red";
const HEADER_TEMPLATE_EXPIRED = "grey";

const STATUS_HEADER: Record<AgentStatus, { content: string; template: string }> = {
  received: { content: "📩 消息已收到", template: "wathet" },
  preparing: { content: "🔄 准备中...", template: "blue" },
  thinking: { content: "💭 思考中...", template: "wathet" },
  waiting: { content: "⏳ 等待中...", template: "wathet" },
  calling_tool: { content: "🔄 处理中...", template: "blue" },
  responding: { content: "✍️ 回复中...", template: "blue" },
  sealed: { content: "✅ 已结束", template: "blue" },
  complete: { content: "✅ 已结束", template: "blue" },
  cancelled: { content: "⛔ 已取消", template: "grey" },
  failed: { content: "⚠️ 出错", template: "red" },
};

const EMPTY_OUTPUT_HEADER = { content: "⚠️ 空回复", template: "orange" } as const;
const EMPTY_OUTPUT_BODY =
  "Agent 本轮结束了，但没有产生任何可显示内容。可能是 resumed session 空转、上下文过长导致输出被截断，或 agent 只返回了不可渲染的元数据。请重试；如果持续出现，建议新开 session 后继续。";

const CANCEL_BUTTON_TEXT = "中断当前任务";

// Card JSON 2.0 — required for the `collapsible_panel` element used by
// thought entries. v1.0 cards silently degrade unknown components to
// plaintext, which is why thoughts previously rendered uncollapsed.
// https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;
// Notices are deliberately compact. Slash-command output has a separate path
// below so result listings do not force lifecycle/control notices to grow.
export const NOTICE_BODY_CHAR_LIMIT = 1_500;
export const COMMAND_RESULT_BODY_CHAR_LIMIT = CARD_MARKDOWN_SOFT_CHAR_LIMIT;
const COMMAND_RESULT_MARKDOWN_ELEMENT_CHAR_LIMIT = 3_000;
const NOTICE_TRUNCATION_SUFFIX =
  "\n\n…\n\n_内容过长，已截断；完整细节请查看 bridge.log 或本地日志。_";
const COMMAND_RESULT_TRUNCATION_SUFFIX =
  "\n\n…\n\n_结果内容超过 4096 字符，已截断；完整细节请查看 bridge.log 或本地日志。_";

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

function conciseError(err: unknown): {
  message: string;
  name?: string;
  code?: string;
  status?: number;
} {
  if (!(err instanceof Error)) return { message: String(err) };
  const maybe = err as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  return {
    message: err.message,
    name: err.name,
    ...(typeof maybe.code === "string" ? { code: maybe.code } : {}),
    ...(typeof maybe.status === "number"
      ? { status: maybe.status }
      : typeof maybe.response?.status === "number"
        ? { status: maybe.response.status }
        : {}),
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
        ok: opt.kind,
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

  return buildV2Card("⏳ 待确认", HEADER_TEMPLATE_PERMISSION, elements, "⏳ 待确认");
}

function resolvedPermissionHeader(selectedKind: string | undefined): {
  readonly title: string;
  readonly template: string;
  readonly summary: string;
} {
  if (selectedKind === "reject_once") {
    return {
      title: "❌ 已拒绝（本次）",
      template: HEADER_TEMPLATE_REJECTED,
      summary: "❌ 已拒绝（本次）",
    };
  }
  if (selectedKind === "reject_always") {
    return {
      title: "❌ 已拒绝（永久）",
      template: HEADER_TEMPLATE_REJECTED,
      summary: "❌ 已拒绝（永久）",
    };
  }
  if (selectedKind?.startsWith("reject_")) {
    return { title: "❌ 已拒绝", template: HEADER_TEMPLATE_REJECTED, summary: "❌ 已拒绝" };
  }
  if (selectedKind === "allow_once") {
    return {
      title: "✅ 已批准（本次）",
      template: HEADER_TEMPLATE_APPROVED,
      summary: "✅ 已批准（本次）",
    };
  }
  if (selectedKind === "allow_always") {
    return {
      title: "✅ 已批准（永久）",
      template: HEADER_TEMPLATE_APPROVED,
      summary: "✅ 已批准（永久）",
    };
  }
  return { title: "✅ 已批准", template: HEADER_TEMPLATE_APPROVED, summary: "✅ 已批准" };
}

function buildResolvedCard(
  toolKind: string,
  toolTitle: string,
  selectedName: string,
  selectedKind?: string,
): object {
  const resolved = resolvedPermissionHeader(selectedKind);
  return buildV2Card(
    resolved.title,
    resolved.template,
    [
      {
        tag: "markdown",
        content: `**${toolKind}**: ${toolTitle}\n\n已选择: **${selectedName}**`,
      },
    ],
    resolved.summary,
  );
}

function truncateBody(body: string, limit: number, suffix: string): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

function splitCardMarkdownBody(body: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt > 0) splitAt += 2;
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", limit);
      if (splitAt > 0) splitAt += 1;
    }
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildMarkdownBodyElements(body: string, elementLimit: number): object[] {
  return splitCardMarkdownBody(body, elementLimit).flatMap((chunk, index) => [
    ...(index > 0 ? [{ tag: "hr" }] : []),
    { tag: "markdown", content: chunk },
  ]);
}

function buildNoticeCard(notice: NoticeCardSpec): object {
  return buildV2Card(
    notice.title,
    notice.template,
    [
      {
        tag: "markdown",
        content: truncateBody(notice.body, NOTICE_BODY_CHAR_LIMIT, NOTICE_TRUNCATION_SUFFIX),
      },
    ],
    notice.title,
  );
}

function buildCommandResultCard(result: CommandResultCardSpec): object {
  const body = truncateBody(
    result.body,
    COMMAND_RESULT_BODY_CHAR_LIMIT,
    COMMAND_RESULT_TRUNCATION_SUFFIX,
  );
  return buildV2Card(
    result.title,
    result.template,
    buildMarkdownBodyElements(body, COMMAND_RESULT_MARKDOWN_ELEMENT_CHAR_LIMIT),
    result.title,
  );
}

function buildExpiredCard(reason: string): object {
  return buildV2Card(
    "⛔ 已失效",
    HEADER_TEMPLATE_EXPIRED,
    [{ tag: "markdown", content: reason }],
    "⛔ 已失效",
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
      const head = `**${entry.toolKind}**: ${entry.title}`;
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
      title: { tag: "plain_text", content: "💭 思考" },
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

function buildSessionMetaElement(state: UnifiedCardState): object | null {
  const meta = state.meta;
  if (!meta) return null;
  return {
    tag: "markdown",
    content: `<font color=\"grey\">${[
      `Agent: ${meta.agent}`,
      `Mode: ${meta.mode}`,
      `Model: ${meta.model}`,
      `Permission: ${meta.permission}`,
    ].join(" · ")}</font>`,
  };
}

function isEmptyTerminalState(state: UnifiedCardState): boolean {
  return state.entries.length === 0 && !state.cancellable && state.status === "complete";
}

function emptyStateMessage(status: AgentStatus): string {
  switch (status) {
    case "received":
      return "_Humming 已收到消息，正在处理…_";
    case "preparing":
      return "_正在启动或连接 Agent，请稍候…_";
    case "thinking":
      return "_消息已转发给 Agent，正在等待回复…_";
    case "waiting":
      return "_Agent 仍在处理，暂时没有新的可展示内容…_";
    case "calling_tool":
      return "_Agent 正在处理…_";
    case "responding":
      return "_Agent 正在回复…_";
    case "sealed":
      return "_当前阶段已结束，等待确认或后续输出…_";
    case "complete":
      return "_Agent 本轮没有返回可展示内容。_";
    case "cancelled":
      return "_本轮任务已取消。_";
    case "failed":
      return "_本轮任务出错。_";
    default:
      return assertNeverStatus(status);
  }
}

function assertNeverStatus(x: never): never {
  throw new Error(`unexpected agent status: ${String(x)}`);
}

function buildUnifiedCard(state: UnifiedCardState): object {
  const elements: object[] = [];
  const emptyTerminal = isEmptyTerminalState(state);

  if (emptyTerminal) {
    elements.push({ tag: "markdown", content: EMPTY_OUTPUT_BODY });
  } else if (state.entries.length === 0) {
    elements.push({ tag: "markdown", content: emptyStateMessage(state.status) });
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

  const metaElement = buildSessionMetaElement(state);
  if (metaElement) {
    elements.push({ tag: "hr" });
    elements.push(metaElement);
  }

  const header = emptyTerminal ? EMPTY_OUTPUT_HEADER : STATUS_HEADER[state.status];
  return buildV2Card(header.content, header.template, elements, header.content);
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

  async updateInterruptCard(
    cardMessageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<boolean> {
    try {
      await this.http.patchCard(
        cardMessageId,
        buildPermissionCard(params, requestId, chatId, threadId),
      );
      return true;
    } catch (err) {
      this.logger.warn({ err: conciseError(err), cardMessageId }, "updateInterruptCard failed");
      return false;
    }
  }

  async updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
    selectedKind?: string,
  ): Promise<void> {
    await this.http.patchCard(
      messageId,
      buildResolvedCard(toolKind, toolTitle, selectedName, selectedKind),
    );
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

  async replyCommandResultCard(
    replyToMessageId: string,
    result: CommandResultCardSpec,
  ): Promise<void> {
    try {
      await this.http.replyCard(replyToMessageId, buildCommandResultCard(result));
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "replyCommandResultCard failed");
    }
  }

  async sendNoticeCard(chatId: string, notice: NoticeCardSpec): Promise<string | null> {
    try {
      return await this.http.sendCardToChat(chatId, buildNoticeCard(notice));
    } catch (err) {
      this.logger.warn({ err, chatId }, "sendNoticeCard failed");
      return null;
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

  async updateUnifiedCard(cardMessageId: string, state: UnifiedCardState): Promise<boolean> {
    try {
      await this.http.patchCard(cardMessageId, buildUnifiedCard(state));
      return true;
    } catch (err) {
      this.logger.warn({ err: conciseError(err), cardMessageId }, "updateUnifiedCard failed");
      return false;
    }
  }
}
