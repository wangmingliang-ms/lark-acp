import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import {
  DISABLED_CONVERSATION_CARD_FEATURE,
  type ConversationCardFeatureGate,
} from "../bridge/conversation-card-feature.js";
import type { ConversationCardView, ConversationTimelineEntry } from "./conversation-card-view.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import { CARD_MARKDOWN_ROTATION_BYTE_LIMIT, splitUtf8, truncateUtf8 } from "./card-text-budget.js";
import type {
  AgentStatus,
  AgentSwitchWarningCardSpec,
  AgentSwitchWarningResolution,
  CommandResultCardSpec,
  LarkPresenter,
  NoticeCardSpec,
  PermissionCardView,
  TimelineEntry,
  UnifiedCardState,
} from "./presenter.js";

const HEADER_TEMPLATE_PERMISSION = "blue";
const HEADER_TEMPLATE_APPROVED = "green";
const HEADER_TEMPLATE_REJECTED = "red";
const HEADER_TEMPLATE_EXPIRED = "grey";

const STATUS_HEADER: Record<AgentStatus, { content: string; template: string }> = {
  received: { content: "📩 消息已收到", template: "wathet" },
  queued: { content: "⏳ 消息已排队", template: "wathet" },
  interrupting: { content: "⚡ 正在中断当前任务", template: "blue" },
  preparing: { content: "🔄 准备中...", template: "blue" },
  thinking: { content: "💭 思考中...", template: "wathet" },
  waiting: { content: "⏳ 等待中...", template: "wathet" },
  calling_tool: { content: "🔄 处理中...", template: "blue" },
  responding: { content: "✍️ 回复中...", template: "blue" },
  sealed: { content: "对话片段", template: "wathet" },
  complete: { content: "✅ 已结束", template: "blue" },
  cancelled: { content: "⛔ 已取消", template: "grey" },
  failed: { content: "⚠️ 出错", template: "red" },
};

const STATUS_ICON: Record<AgentStatus, string> = {
  received: "📩",
  queued: "⏳",
  interrupting: "⚡",
  preparing: "🔄",
  thinking: "💭",
  waiting: "⏳",
  calling_tool: "🔄",
  responding: "✍️",
  sealed: "",
  complete: "✅",
  cancelled: "⛔",
  failed: "⚠️",
};

const STATUS_SUMMARY_DETAIL: Record<AgentStatus, string> = {
  received: "Humming 已收到消息",
  queued: "等待处理",
  interrupting: "正在中断当前任务",
  preparing: "正在启动或连接 Agent",
  thinking: "Agent 正在思考",
  waiting: "Agent 仍在处理",
  calling_tool: "Agent 正在处理",
  responding: "Agent 正在回复",
  sealed: "对话片段",
  complete: "已结束",
  cancelled: "已取消",
  failed: "出错",
};

const CONVERSATION_SUMMARY_CHAR_LIMIT = 80;

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
export const NOTICE_BODY_BYTE_LIMIT = 1_500;
export const COMMAND_RESULT_BODY_BYTE_LIMIT = CARD_MARKDOWN_ROTATION_BYTE_LIMIT;
const COMMAND_RESULT_MARKDOWN_ELEMENT_BYTE_LIMIT = 3_000;
const NOTICE_TRUNCATION_SUFFIX =
  "\n\n…\n\n_内容过长，已截断；完整细节请查看 bridge.log 或本地日志。_";
const COMMAND_RESULT_TRUNCATION_SUFFIX =
  "\n\n…\n\n_结果内容超过限制，已截断；完整细节请查看 bridge.log 或本地日志。_";

function buildV2Card(
  headerContent: string | null,
  headerTemplate: string | null,
  elements: readonly object[],
  summaryContent: string,
): object {
  return {
    schema: CARD_SCHEMA_V2,
    config: { ...CARD_CONFIG_V2, summary: { content: summaryContent } },
    ...(headerContent !== null && headerTemplate !== null
      ? {
          header: {
            title: { tag: "plain_text" as const, content: headerContent },
            template: headerTemplate,
          },
        }
      : {}),
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

function buildAgentSwitchWarningCard(warning: AgentSwitchWarningCardSpec): object {
  return buildV2Card(
    "⚠️ 切换 Agent 会丢失 context",
    "orange",
    [
      { tag: "markdown", content: warning.body },
      { tag: "hr" },
      buildCallbackButton("确认切换", "danger", {
        sw: warning.switchId,
        swa: "confirm",
        c: warning.chatId,
        ...(warning.threadId !== null ? { th: warning.threadId } : {}),
      }),
      buildCallbackButton("取消", "default", {
        sw: warning.switchId,
        swa: "cancel",
        c: warning.chatId,
        ...(warning.threadId !== null ? { th: warning.threadId } : {}),
      }),
    ],
    "⚠️ 切换 Agent 会丢失 context",
  );
}

function buildAgentSwitchWarningResolutionCard(resolution: AgentSwitchWarningResolution): object {
  const header = agentSwitchResolutionHeader(resolution.status);
  return buildV2Card(
    header.title,
    header.template,
    [{ tag: "markdown", content: resolution.text }],
    header.title,
  );
}

function agentSwitchResolutionHeader(status: AgentSwitchWarningResolution["status"]): {
  readonly title: string;
  readonly template: string;
} {
  switch (status) {
    case "confirmed":
      return { title: "✅ 已确认切换", template: "green" };
    case "cancelled":
      return { title: "⛔ 已取消切换", template: "grey" };
    case "expired":
      return { title: "⛔ 切换已失效", template: "grey" };
    case "failed":
      return { title: "⚠️ 切换失败", template: "red" };
    default:
      return assertNeverSwitchResolution(status);
  }
}

function assertNeverSwitchResolution(x: never): never {
  throw new Error(`unexpected agent switch resolution: ${String(x)}`);
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

function truncateBody(body: string, maxBytes: number, suffix: string): string {
  return truncateUtf8(body, maxBytes, suffix);
}

function splitCardMarkdownBody(body: string, maxBytes: number): string[] {
  return splitUtf8(body, maxBytes);
}

function buildMarkdownBodyElements(body: string, maxElementBytes: number): object[] {
  return splitCardMarkdownBody(body, maxElementBytes).flatMap((chunk, index) => [
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
        content: truncateBody(notice.body, NOTICE_BODY_BYTE_LIMIT, NOTICE_TRUNCATION_SUFFIX),
      },
    ],
    notice.title,
  );
}

function buildCommandResultCard(result: CommandResultCardSpec): object {
  const body = truncateBody(
    result.body,
    COMMAND_RESULT_BODY_BYTE_LIMIT,
    COMMAND_RESULT_TRUNCATION_SUFFIX,
  );
  return buildV2Card(
    result.title,
    result.template,
    buildMarkdownBodyElements(body, COMMAND_RESULT_MARKDOWN_ELEMENT_BYTE_LIMIT),
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

function semanticEntryToCardElement(entry: ConversationTimelineEntry): object {
  switch (entry.kind) {
    case "text":
      return { tag: "markdown", content: entry.text };
    case "thought":
      return buildThoughtPanel(entry.text);
    case "tool": {
      const head = `**${entry.toolKind}**: ${entry.title}`;
      return { tag: "markdown", content: entry.detail ? `${head}\n\n${entry.detail}` : head };
    }
    default:
      return assertNeverConversationEntry(entry);
  }
}

function assertNeverConversationEntry(entry: never): never {
  throw new Error(`unexpected semantic timeline entry: ${String(entry)}`);
}

type SummaryEntry = TimelineEntry | ConversationTimelineEntry;

function statusSummary(status: AgentStatus, entries: readonly SummaryEntry[]): string {
  const activityDetail = currentActivityDetail(status, entries);
  const detail = activityDetail ? stripMarkdownForSummary(activityDetail) : "";
  const summaryDetail = detail || STATUS_SUMMARY_DETAIL[status];
  const icon = STATUS_ICON[status];
  return truncateSummary(icon ? `${icon} ${summaryDetail}` : summaryDetail);
}

function currentActivityDetail(
  status: AgentStatus,
  entries: readonly SummaryEntry[],
): string | undefined {
  if (status === "calling_tool") {
    const tool = entries
      .slice()
      .reverse()
      .find(
        (entry) =>
          entry.kind === "tool" && (entry.status === "pending" || entry.status === "in_progress"),
      );
    return tool?.kind === "tool" ? `${tool.toolKind}: ${tool.title}` : undefined;
  }
  if (status === "thinking") {
    const thought = entries
      .slice()
      .reverse()
      .find((entry) => entry.kind === "thought");
    return thought?.kind === "thought" ? thought.text : undefined;
  }
  if (status === "responding") {
    const text = entries
      .slice()
      .reverse()
      .find((entry) => entry.kind === "text");
    return text?.kind === "text" ? text.text : undefined;
  }
  return undefined;
}

function unifiedCardSummary(state: UnifiedCardState): string {
  if (state.status !== "sealed") return statusSummary(state.status, state.entries);
  const firstText = firstSummaryText(state.entries);
  return firstText
    ? truncateSummary(stripMarkdownForSummary(firstText))
    : STATUS_SUMMARY_DETAIL.sealed;
}

function firstSummaryText(entries: readonly TimelineEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind === "text" || entry.kind === "thought") return entry.text;
    const toolSummary = `${entry.toolKind}: ${entry.title}`;
    if (toolSummary.trim()) return toolSummary;
  }
  return undefined;
}

function stripMarkdownForSummary(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSummary(text: string): string {
  if (text.length <= CONVERSATION_SUMMARY_CHAR_LIMIT) return text;
  return `${text.slice(0, CONVERSATION_SUMMARY_CHAR_LIMIT).trimEnd()}…`;
}

function buildSessionMetaElement(state: UnifiedCardState): object | null {
  if (state.status === "sealed") return null;
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
    case "queued":
      return "_前一任务仍在进行，这条消息已排入队列，正在等待处理…_";
    case "interrupting":
      return "_正在中断进行中的任务，这条消息将在中断完成后发送给 Agent…_";
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
  const showHeader = state.status !== "sealed" || emptyTerminal;
  return buildV2Card(
    showHeader ? header.content : null,
    showHeader ? header.template : null,
    elements,
    emptyTerminal ? EMPTY_OUTPUT_HEADER.content : unifiedCardSummary(state),
  );
}

function buildSemanticPermissionCard(view: PermissionCardView): object {
  const elements: object[] = [
    { tag: "markdown", content: `**${view.toolKind}**: ${view.toolTitle}` },
  ];
  for (const option of view.options) {
    elements.push(
      buildCallbackButton(option.label, buttonTypeForKind(option.kind ?? ""), {
        v: 2,
        c: view.route.c,
        ...(view.route.th !== undefined ? { th: view.route.th } : {}),
        p: view.promptToken,
        q: view.permissionToken,
        r: view.requestId,
        o: option.id,
      }),
    );
  }
  return buildV2Card("⏳ 待确认", HEADER_TEMPLATE_PERMISSION, elements, "⏳ 待确认");
}

function semanticEmptyMessage(view: ConversationCardView): string {
  switch (view.kind) {
    case "queued":
      return emptyStateMessage("queued");
    case "interrupting":
      return emptyStateMessage("interrupting");
    case "starting":
      return emptyStateMessage("preparing");
    case "orphaned":
      return "_此对话片段已失去当前所有权。_";
    case "active":
      return emptyStateMessage(view.header);
    case "archived":
      return "";
    case "terminal":
      if (view.body === "empty_complete") return EMPTY_OUTPUT_BODY;
      switch (view.header) {
        case "complete":
        case "cancelled":
        case "failed":
          return emptyStateMessage(view.header);
        case "interrupted":
          return "_本轮 Response 已被中断。_";
        case "merged":
          return "_本条消息已合并到下一条消息，将一同发送给 Agent。_";
        case "superseded":
          return "_兼容状态：本轮任务已被后续任务取代。_";
        case "abandoned":
          return "_兼容状态：本轮任务未能开始或继续。_";
        default:
          return "";
      }
    default:
      return assertNeverConversationView(view);
  }
}

function semanticHeader(view: ConversationCardView): { content: string; template: string } | null {
  switch (view.kind) {
    case "queued":
    case "interrupting":
    case "starting":
    case "active":
      return STATUS_HEADER[view.header];
    case "orphaned":
      return { content: "对话片段", template: "grey" };
    case "archived":
      return null;
    case "terminal":
      return view.body === "empty_complete"
        ? EMPTY_OUTPUT_HEADER
        : semanticTerminalHeader(view.header);
    default:
      return assertNeverConversationView(view);
  }
}

function semanticTerminalHeader(
  header: Extract<ConversationCardView, { kind: "terminal" }>["header"],
): { content: string; template: string } {
  switch (header) {
    case "complete":
    case "cancelled":
    case "failed":
      return STATUS_HEADER[header];
    case "interrupted":
      return { content: "⏸️ 已中断", template: "grey" };
    case "merged":
      return { content: "🔗 已合并到下一条消息", template: "grey" };
    case "superseded":
      return { content: "⏭️ 已被后续任务取代", template: "grey" };
    case "abandoned":
      return { content: "⚠️ 未执行", template: "grey" };
    default:
      return assertNeverTerminalHeader(header);
  }
}

function semanticSummary(
  view: ConversationCardView,
  header: { content: string; template: string } | null,
): string {
  switch (view.kind) {
    case "archived": {
      const text = stripMarkdownForSummary(view.summary);
      return text ? truncateSummary(text) : "对话片段";
    }
    case "queued":
      return statusSummary("queued", view.entries);
    case "interrupting":
      return statusSummary("interrupting", view.entries);
    case "starting":
      return statusSummary("preparing", view.entries);
    case "orphaned":
      return header?.content ?? "对话片段";
    case "active":
      return statusSummary(view.header, view.entries);
    case "terminal":
      return header?.content ?? semanticTerminalHeader(view.header).content;
    default:
      return assertNeverConversationView(view);
  }
}

function semanticEntries(view: ConversationCardView): object[] {
  const elements: object[] = [];
  if (view.entries.length === 0) {
    const message = semanticEmptyMessage(view);
    if (message) elements.push({ tag: "markdown", content: message });
    return elements;
  }
  view.entries.forEach((entry: ConversationTimelineEntry, index: number) => {
    if (index > 0 && entry.kind !== "thought") elements.push({ tag: "hr" });
    elements.push(semanticEntryToCardElement(entry));
  });
  return elements;
}

function semanticProfile(view: ConversationCardView): object | null {
  switch (view.kind) {
    case "queued":
    case "interrupting":
    case "starting":
    case "active":
    case "terminal":
      if (view.profile === null) return null;
      return {
        tag: "markdown",
        content: `<font color=\"grey\">${[
          `Agent: ${view.profile.agent}`,
          `Mode: ${view.profile.mode}`,
          `Model: ${view.profile.model}`,
          `Permission: ${view.profile.permission}`,
        ].join(" · ")}</font>`,
      };
    case "orphaned":
    case "archived":
      return null;
    default:
      return assertNeverConversationView(view);
  }
}

function buildSemanticConversationCard(view: ConversationCardView): object {
  const elements = semanticEntries(view);
  switch (view.kind) {
    case "active":
      if (view.cancelAction !== undefined) {
        elements.push({ tag: "hr" });
        elements.push(
          buildCallbackButton(CANCEL_BUTTON_TEXT, "danger", {
            v: 2,
            c: view.route.c,
            ...(view.route.th !== undefined ? { th: view.route.th } : {}),
            cancel: true,
            p: view.cancelAction.p,
            s: view.cancelAction.s,
            a: view.cancelAction.a,
          }),
        );
      }
      break;
    case "queued":
    case "interrupting":
    case "starting":
    case "orphaned":
    case "archived":
    case "terminal":
      break;
    default:
      return assertNeverConversationView(view);
  }
  const profile = semanticProfile(view);
  if (profile !== null) {
    elements.push({ tag: "hr" });
    elements.push(profile);
  }
  const header = semanticHeader(view);
  return buildV2Card(
    header?.content ?? null,
    header?.template ?? null,
    elements,
    semanticSummary(view, header),
  );
}

function assertNeverConversationView(view: never): never {
  throw new Error(`unexpected conversation card view: ${String(view)}`);
}

function assertNeverTerminalHeader(header: never): never {
  throw new Error(`unexpected terminal header: ${String(header)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRoute(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["c", "th"]) &&
    typeof value.c === "string" &&
    (value.th === undefined || typeof value.th === "string")
  );
}

function isTimelineEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "text":
    case "thought":
      return hasOnlyKeys(value, ["kind", "text"]) && typeof value.text === "string";
    case "tool":
      return (
        hasOnlyKeys(value, ["kind", "toolCallId", "title", "toolKind", "status", "detail"]) &&
        typeof value.toolCallId === "string" &&
        typeof value.title === "string" &&
        typeof value.toolKind === "string" &&
        ["pending", "in_progress", "continued", "completed", "failed", "interrupted"].includes(
          value.status as string,
        ) &&
        (value.detail === undefined || typeof value.detail === "string")
      );
    default:
      return false;
  }
}

function hasEntries(value: Record<string, unknown>, nonEmpty = false): boolean {
  return (
    Array.isArray(value.entries) &&
    (!nonEmpty || value.entries.length > 0) &&
    value.entries.every(isTimelineEntry)
  );
}

function entries(value: Record<string, unknown>): readonly Record<string, unknown>[] {
  return value.entries as readonly Record<string, unknown>[];
}

function hasTextEntry(value: Record<string, unknown>): boolean {
  return entries(value).some((entry) => entry.kind === "text" && (entry.text as string).length > 0);
}

function hasRunningToolEntry(value: Record<string, unknown>): boolean {
  return entries(value).some(
    (entry) =>
      entry.kind === "tool" && (entry.status === "pending" || entry.status === "in_progress"),
  );
}

function hasOnlyTerminalToolEntries(value: Record<string, unknown>): boolean {
  return entries(value).every(
    (entry) =>
      entry.kind !== "tool" ||
      entry.status === "completed" ||
      entry.status === "failed" ||
      entry.status === "continued" ||
      entry.status === "interrupted",
  );
}

function isProfile(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasOnlyKeys(value, ["agent", "mode", "model", "permission"]) &&
      [value.agent, value.mode, value.model, value.permission].every(
        (field) => typeof field === "string",
      ))
  );
}

function isConversationCardView(value: unknown): value is ConversationCardView {
  if (!isRecord(value) || typeof value.kind !== "string" || !isRoute(value.route)) return false;
  switch (value.kind) {
    case "queued":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "profile", "route"]) &&
        value.header === "queued" &&
        hasEntries(value) &&
        isProfile(value.profile)
      );
    case "interrupting":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "profile", "route"]) &&
        value.header === "interrupting" &&
        hasEntries(value) &&
        isProfile(value.profile)
      );
    case "starting":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "profile", "route"]) &&
        value.header === "preparing" &&
        Array.isArray(value.entries) &&
        value.entries.length === 0 &&
        isProfile(value.profile)
      );
    case "orphaned":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "reason", "route"]) &&
        value.header === "orphaned" &&
        hasEntries(value) &&
        (value.reason === "superseded_send" || value.reason === "stale_handoff")
      );
    case "active":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "profile", "cancelAction", "route"]) &&
        ["thinking", "waiting", "calling_tool", "responding"].includes(value.header as string) &&
        hasEntries(value) &&
        isProfile(value.profile) &&
        (value.header !== "responding" || hasTextEntry(value)) &&
        (value.header !== "calling_tool" || hasRunningToolEntry(value)) &&
        (value.header !== "waiting" || entries(value).length === 0) &&
        (value.cancelAction === undefined ||
          (isRecord(value.cancelAction) &&
            hasOnlyKeys(value.cancelAction, ["p", "s", "a"]) &&
            [value.cancelAction.p, value.cancelAction.s, value.cancelAction.a].every(
              (field) => typeof field === "string",
            )))
      );
    case "archived":
      return (
        hasOnlyKeys(value, ["kind", "entries", "summary", "route"]) &&
        hasEntries(value, true) &&
        hasOnlyTerminalToolEntries(value) &&
        typeof value.summary === "string"
      );
    case "terminal":
      return (
        hasOnlyKeys(value, ["kind", "header", "entries", "profile", "body", "route"]) &&
        [
          "complete",
          "cancelled",
          "failed",
          "interrupted",
          "merged",
          "superseded",
          "abandoned",
        ].includes(value.header as string) &&
        hasEntries(value) &&
        hasOnlyTerminalToolEntries(value) &&
        isProfile(value.profile) &&
        ((value.body === "content" && entries(value).length > 0) ||
          (value.body === "empty_complete" &&
            value.header === "complete" &&
            Array.isArray(value.entries) &&
            value.entries.length === 0))
      );
    default:
      return false;
  }
}

function isPermissionCardView(value: unknown): value is PermissionCardView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "route",
      "promptToken",
      "permissionToken",
      "requestId",
      "title",
      "toolKind",
      "toolTitle",
      "options",
    ]) &&
    isRoute(value.route) &&
    [
      value.promptToken,
      value.permissionToken,
      value.requestId,
      value.title,
      value.toolKind,
      value.toolTitle,
    ].every((field) => typeof field === "string") &&
    Array.isArray(value.options) &&
    value.options.length > 0 &&
    value.options.every(
      (option) =>
        isRecord(option) &&
        hasOnlyKeys(option, ["id", "label", "kind"]) &&
        typeof option.id === "string" &&
        typeof option.label === "string" &&
        (option.kind === undefined || typeof option.kind === "string"),
    )
  );
}

export interface LarkCardPresenterOptions {
  http: LarkHttpClient;
  logger: LarkLogger;
  feature?: ConversationCardFeatureGate;
}

/**
 * Default {@link LarkPresenter} implementation using Lark
 * interactive cards via {@link LarkHttpClient}.
 */
export class LarkCardPresenter implements LarkPresenter {
  private readonly http: LarkHttpClient;
  private readonly logger: LarkLogger;
  private readonly feature: ConversationCardFeatureGate;

  constructor(opts: LarkCardPresenterOptions) {
    this.http = opts.http;
    this.logger = opts.logger.child({ name: "presenter" });
    this.feature = opts.feature ?? DISABLED_CONVERSATION_CARD_FEATURE;
  }

  async sendConversationCard(
    replyToMessageId: string,
    view: ConversationCardView,
  ): Promise<string | null> {
    if (!this.feature.v2Enabled) return null;
    if (!isConversationCardView(view)) {
      this.logger.warn("sendConversationCard rejected malformed view");
      return null;
    }
    try {
      return await this.http.replyCard(replyToMessageId, buildSemanticConversationCard(view), {
        replyInThread: view.route.th !== undefined,
      });
    } catch (err) {
      this.logger.warn({ err: conciseError(err) }, "sendConversationCard rejected");
      return null;
    }
  }

  async updateConversationCard(
    cardMessageId: string,
    view: ConversationCardView,
  ): Promise<boolean> {
    if (!this.feature.v2Enabled) return false;
    if (!isConversationCardView(view)) {
      this.logger.warn("updateConversationCard rejected malformed view");
      return false;
    }
    try {
      await this.http.patchCard(cardMessageId, buildSemanticConversationCard(view));
      return true;
    } catch (err) {
      this.logger.warn({ err: conciseError(err) }, "updateConversationCard rejected");
      return false;
    }
  }

  async sendPermissionRequestCard(
    replyToMessageId: string,
    view: PermissionCardView,
  ): Promise<string | null> {
    if (!this.feature.v2Enabled) return null;
    if (!isPermissionCardView(view)) {
      this.logger.warn("sendPermissionRequestCard rejected malformed view");
      return null;
    }
    try {
      return await this.http.replyCard(replyToMessageId, buildSemanticPermissionCard(view), {
        replyInThread: view.route.th !== undefined,
      });
    } catch (err) {
      this.logger.warn({ err: conciseError(err) }, "sendPermissionRequestCard rejected");
      return null;
    }
  }

  async updatePermissionRequestCard(
    cardMessageId: string,
    view: PermissionCardView,
  ): Promise<boolean> {
    if (!this.feature.v2Enabled) return false;
    if (!isPermissionCardView(view)) {
      this.logger.warn("updatePermissionRequestCard rejected malformed view");
      return false;
    }
    try {
      await this.http.patchCard(cardMessageId, buildSemanticPermissionCard(view));
      return true;
    } catch (err) {
      this.logger.warn({ err: conciseError(err) }, "updatePermissionRequestCard rejected");
      return false;
    }
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

  async replyNoticeCard(replyToMessageId: string, notice: NoticeCardSpec): Promise<string | null> {
    try {
      return await this.http.replyCard(replyToMessageId, buildNoticeCard(notice));
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "replyNoticeCard failed");
      return null;
    }
  }

  async updateNoticeCard(messageId: string, notice: NoticeCardSpec): Promise<boolean> {
    try {
      await this.http.patchCard(messageId, buildNoticeCard(notice));
      return true;
    } catch (err) {
      this.logger.warn({ err, messageId }, "updateNoticeCard failed");
      return false;
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

  async replyAgentSwitchWarningCard(
    replyToMessageId: string,
    warning: AgentSwitchWarningCardSpec,
  ): Promise<string | null> {
    try {
      return await this.http.replyCard(replyToMessageId, buildAgentSwitchWarningCard(warning), {
        replyInThread: warning.threadId !== null,
      });
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "replyAgentSwitchWarningCard failed");
      return null;
    }
  }

  async updateAgentSwitchWarningCard(
    cardMessageId: string,
    resolution: AgentSwitchWarningResolution,
  ): Promise<void> {
    try {
      await this.http.patchCard(cardMessageId, buildAgentSwitchWarningResolutionCard(resolution));
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, "updateAgentSwitchWarningCard failed");
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
