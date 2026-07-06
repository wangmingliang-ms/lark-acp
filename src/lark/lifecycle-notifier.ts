import process from "node:process";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "./lark-http.js";

const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;
const DEFAULT_SEND_TIMEOUT_MS = 3_000;

export const LIFECYCLE_NOTICE_KINDS = ["started", "stopping", "restarting", "restarted"] as const;
export type LifecycleNoticeKind = (typeof LIFECYCLE_NOTICE_KINDS)[number];

type HeaderTemplate = "blue" | "green" | "grey" | "orange";

type LifecycleNoticeSpec = {
  readonly title: string;
  readonly body: string;
  readonly template: HeaderTemplate;
};

const LIFECYCLE_NOTICE_SPECS: Readonly<Record<LifecycleNoticeKind, LifecycleNoticeSpec>> = {
  started: {
    title: "✅ Humming 已启动",
    body: "Bridge 进程已启动，可以继续使用。",
    template: "green",
  },
  stopping: {
    title: "⛔ Humming 正在停止",
    body: "Bridge 进程正在停止，期间 bot 暂时不会响应消息。",
    template: "grey",
  },
  restarting: {
    title: "🔄 Humming 正在重启",
    body: "Bridge 进程正在重启，稍后会恢复响应。",
    template: "orange",
  },
  restarted: {
    title: "✅ Humming 已重启",
    body: "Bridge 进程已重启完成，可以继续使用。",
    template: "green",
  },
};

export class LifecycleNoticeTimeoutError extends Error {
  override readonly name = "LifecycleNoticeTimeoutError";

  constructor(chatId: string, timeoutMs: number) {
    super(`lifecycle notice to ${chatId} timed out after ${timeoutMs}ms`);
  }
}

type LifecycleNoticeCardOptions = {
  readonly pid?: number;
  readonly now?: Date;
};

export type LifecycleNoticeOptions = LifecycleNoticeCardOptions & {
  readonly http: Pick<LarkHttpClient, "sendCardToChat">;
  readonly chatIds: readonly string[];
  readonly kind: LifecycleNoticeKind;
  readonly logger: LarkLogger;
  readonly timeoutMs?: number;
};

export function buildLifecycleNoticeCard(
  kind: LifecycleNoticeKind,
  opts: LifecycleNoticeCardOptions = {},
): object {
  const spec = LIFECYCLE_NOTICE_SPECS[kind];
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? new Date();
  const body = `${spec.body}\n\n• PID：${pid}\n• 时间：${formatLifecycleTime(now)}`;

  return {
    schema: CARD_SCHEMA_V2,
    config: { ...CARD_CONFIG_V2, summary: { content: spec.title } },
    header: {
      title: { tag: "plain_text" as const, content: spec.title },
      template: spec.template,
    },
    body: {
      elements: [{ tag: "markdown" as const, content: body }],
    },
  };
}

/**
 * Best-effort lifecycle broadcast. Individual chat failures are logged and do
 * not reject the whole bridge startup/shutdown path.
 */
export async function sendLifecycleNotice(opts: LifecycleNoticeOptions): Promise<void> {
  const chatIds = dedupeChatIds(opts.chatIds);
  if (chatIds.length === 0) {
    opts.logger.debug({ kind: opts.kind }, "no lifecycle notification chats configured");
    return;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const card = buildLifecycleNoticeCard(opts.kind, { pid: opts.pid, now: opts.now });
  const results = await Promise.allSettled(
    chatIds.map((chatId) => withTimeout(opts.http.sendCardToChat(chatId, card), chatId, timeoutMs)),
  );

  results.forEach((result, index) => {
    const chatId = chatIds[index];
    if (chatId === undefined) return;
    if (result.status === "fulfilled") {
      opts.logger.info({ chatId, kind: opts.kind }, "lifecycle notice sent");
      return;
    }
    opts.logger.warn({ err: result.reason, chatId, kind: opts.kind }, "lifecycle notice failed");
  });
}

function formatLifecycleTime(date: Date): string {
  return date.toLocaleString("zh-CN", { hour12: false });
}

function dedupeChatIds(chatIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of chatIds) {
    const chatId = raw.trim();
    if (chatId.length === 0 || seen.has(chatId)) continue;
    seen.add(chatId);
    out.push(chatId);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, chatId: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LifecycleNoticeTimeoutError(chatId, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
