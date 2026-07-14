import process from "node:process";
import type { PermissionMode } from "../acp/humming-client.js";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "./lark-http.js";

const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;
const DEFAULT_SEND_TIMEOUT_MS = 3_000;

export const LIFECYCLE_NOTICE_KINDS = [
  "started",
  "stopped",
  "restarting",
  "restarted",
  "restartFailed",
  "crashed",
] as const;
export type LifecycleNoticeKind = (typeof LIFECYCLE_NOTICE_KINDS)[number];

type HeaderTemplate = "blue" | "green" | "grey" | "orange" | "red";

type LifecycleNoticeSpec = {
  readonly title: string;
  readonly body: string;
  readonly template: HeaderTemplate;
};

export type LifecycleCodeRevision = {
  readonly commit: string;
  readonly message: string;
};

export type LifecycleDefaultProfile = {
  readonly agent: string;
  readonly model?: string;
  readonly mode?: string;
  readonly permissionMode: PermissionMode;
};

const LIFECYCLE_NOTICE_SPECS: Readonly<Record<LifecycleNoticeKind, LifecycleNoticeSpec>> = {
  started: {
    title: "✅ Humming 已启动",
    body: "Bridge 进程已启动，可以继续使用。",
    template: "green",
  },
  stopped: {
    title: "⏹️ Humming 已停止",
    body: "Bridge 进程已停止，bot 当前不会响应消息。",
    template: "blue",
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
  restartFailed: {
    title: "❌ Humming 重启失败",
    body: "Bridge 未能在截止时间内恢复。请检查 bridge.log 并从外部终端重新启动。",
    template: "red",
  },
  crashed: {
    title: "⚠️ Humming 发生未捕获错误",
    body: "Bridge 捕获到未处理异常/Promise rejection，已写入日志。进程将退出，期间 bot 暂时不会响应消息。",
    template: "red",
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
  readonly codeRevision?: LifecycleCodeRevision;
  readonly defaultProfile?: LifecycleDefaultProfile;
};

export type LifecycleNoticeOptions = LifecycleNoticeCardOptions & {
  readonly http: Pick<LarkHttpClient, "sendCardToChat"> &
    Partial<Pick<LarkHttpClient, "patchCard">>;
  readonly chatIds: readonly string[];
  readonly kind: LifecycleNoticeKind;
  readonly logger: LarkLogger;
  readonly timeoutMs?: number;
  readonly replace?: readonly LifecycleNoticeDelivery[];
};

export type LifecycleNoticeDelivery = {
  readonly chatId: string;
  readonly messageId: string;
};

export function buildLifecycleNoticeCard(
  kind: LifecycleNoticeKind,
  opts: LifecycleNoticeCardOptions = {},
): object {
  const spec = LIFECYCLE_NOTICE_SPECS[kind];
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? new Date();
  const body = [
    spec.body,
    "",
    ...formatCodeRevision(kind, opts.codeRevision),
    ...formatDefaultProfile(kind, opts.defaultProfile),
    "**Runtime**",
    `• PID：${pid}`,
    `• 时间：${formatLifecycleTime(now)}`,
  ].join("\n");

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
export async function sendLifecycleNotice(
  opts: LifecycleNoticeOptions,
): Promise<readonly LifecycleNoticeDelivery[]> {
  const chatIds = dedupeChatIds(opts.chatIds);
  if (chatIds.length === 0) {
    opts.logger.debug({ kind: opts.kind }, "no lifecycle notification chats configured");
    return [];
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const card = buildLifecycleNoticeCard(opts.kind, {
    pid: opts.pid,
    now: opts.now,
    codeRevision: opts.codeRevision,
    defaultProfile: opts.defaultProfile,
  });
  const replaceByChat = new Map(opts.replace?.map((item) => [item.chatId, item.messageId]) ?? []);
  const results = await Promise.allSettled(
    chatIds.map(async (chatId): Promise<LifecycleNoticeDelivery | null> => {
      const previousMessageId = replaceByChat.get(chatId);
      if (previousMessageId && opts.http.patchCard) {
        try {
          await withTimeout(opts.http.patchCard(previousMessageId, card), chatId, timeoutMs);
          return { chatId, messageId: previousMessageId };
        } catch (err) {
          opts.logger.warn(
            { err, chatId, kind: opts.kind },
            "lifecycle notice patch failed; sending replacement",
          );
        }
      }
      const messageId = await withTimeout(
        opts.http.sendCardToChat(chatId, card),
        chatId,
        timeoutMs,
      );
      return messageId ? { chatId, messageId } : null;
    }),
  );

  const deliveries: LifecycleNoticeDelivery[] = [];
  results.forEach((result, index) => {
    const chatId = chatIds[index];
    if (chatId === undefined) return;
    if (result.status === "fulfilled") {
      if (result.value) deliveries.push(result.value);
      opts.logger.info({ chatId, kind: opts.kind }, "lifecycle notice sent");
      return;
    }
    opts.logger.warn({ err: result.reason, chatId, kind: opts.kind }, "lifecycle notice failed");
  });
  return deliveries;
}

function formatLifecycleTime(date: Date): string {
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatCodeRevision(
  kind: LifecycleNoticeKind,
  revision: LifecycleCodeRevision | undefined,
): readonly string[] {
  if ((kind !== "started" && kind !== "restarted") || revision === undefined) return [];
  const message = revision.message.trim();
  return [
    "**Code Revision**",
    `• Commit：\`${revision.commit}\``,
    ...(message.length > 0 ? [`• Message：${message}`] : []),
    "",
  ];
}

function formatDefaultProfile(
  kind: LifecycleNoticeKind,
  profile: LifecycleDefaultProfile | undefined,
): readonly string[] {
  if ((kind !== "started" && kind !== "restarted") || profile === undefined) return [];
  return [
    "**Default Configuration（全局）**",
    `• Agent：${profile.agent}`,
    `• Model：${profile.model ?? ""}`,
    `• Mode：${profile.mode ?? ""}`,
    `• Permission Mode：${profile.permissionMode}`,
    "",
  ];
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
