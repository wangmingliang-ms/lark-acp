/**
 * Lark message interpreter — translate a Lark message event into the pure
 * {@link PromptSegment}[] shape the bridge hydrates into an agent prompt.
 *
 * Images (standalone and post-embedded) become `image-ref` segments; files,
 * audio and video become `resource-ref` segments. The bridge's prompt hydrator
 * downloads referenced bytes. This module stays pure — no bytes are downloaded
 * here.
 *
 * Content shapes are based on the Lark Open Platform docs:
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { slashCommandController, type SlashCommandInvocation } from "./commands.js";

type LarkRawMention = NonNullable<Lark.RawMessageEvent["message"]["mentions"]>[number];

// ---- Post message element types (matched to Lark docs) ----

interface PostElText {
  tag: "text";
  text: string;
  un_escape?: boolean;
  style?: ("bold" | "underline" | "lineThrough" | "italic")[];
}

interface PostElA {
  tag: "a";
  text?: string;
  href?: string;
  style?: string[];
}

interface PostElAt {
  tag: "at";
  user_id: string;
  user_name?: string;
  style?: string[];
}

interface PostElImg {
  tag: "img";
  image_key: string;
}

interface PostElMedia {
  tag: "media";
  file_key?: string;
  image_key?: string;
}

interface PostElEmotion {
  tag: "emotion";
  emoji_type: string;
}

interface PostElCodeBlock {
  tag: "code_block";
  language?: string;
  text: string;
}

interface PostElHr {
  tag: "hr";
}

type PostElement =
  | PostElText
  | PostElA
  | PostElAt
  | PostElImg
  | PostElMedia
  | PostElEmotion
  | PostElCodeBlock
  | PostElHr;

type PostParagraph = PostElement[];

interface PostPayload {
  title?: string;
  content?: PostParagraph[];
}

interface TextPayload {
  text?: string;
}

interface ImagePayload {
  image_key?: string;
}

interface FilePayload {
  file_key?: string;
  file_name?: string;
}

interface AudioPayload {
  file_key?: string;
  duration?: number;
}

interface MediaPayload {
  file_key?: string;
  image_key?: string;
  file_name?: string;
  duration?: number;
}

interface StickerPayload {
  file_key?: string;
}

interface ShareChatPayload {
  chat_id?: string;
}

interface ShareUserPayload {
  user_id?: string;
}

interface LocationPayload {
  name?: string;
  longitude?: string;
  latitude?: string;
}

// ---- Public API ----

/**
 * Interpreter → hydrator 的中间产物。纯解释器只识别结构、产出这些段，
 * **不下载字节**（下载是 bridge 层的 effect）。`image-ref` 只携带下载所
 * 需的最小信息（messageId + imageKey）。
 */
export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image-ref"; readonly messageId: string; readonly imageKey: string }
  | {
      readonly kind: "resource-ref";
      readonly messageId: string;
      readonly fileKey: string;
      readonly name: string;
      readonly label: string;
    };

/**
 * High-level commands a user can issue via plain-text messages.
 *
 * Detection is intentionally strict: only exact, whitespace-trimmed matches
 * after stripping the bot's own self-mention. Anything else falls through
 * to {@link InterpretedMessage} `kind: "prompt"`.
 */
/**
 * High-level commands a user can issue via plain-text messages.
 *
 * `cancel` / `new` are exact-match, no-argument commands. The binding
 * commands (`bind` / `unbind` / `where`) let a single bot serve many repos:
 * they route this chat to a specific working directory + agent. `bind`
 * carries its parsed arguments; `bind-usage` is emitted when `/bind` is sent
 * without a path so the bridge can reply with usage help.
 *
 * The interpreter stays pure — it only turns text into this structure.
 * Filesystem validation, `~` expansion and agent-preset resolution are the
 * bridge's job (they are effects).
 */
/**
 * Outcome of interpreting a Lark inbound message.
 *
 * - `empty`: no actionable content (e.g. a stripped-to-nothing self-mention).
 * - `command`: a recognised slash-style command — bridge should act on it
 *   directly without sending anything to the agent.
 * - `prompt`: interpreter segments (text + image-ref) for the bridge to
 *   hydrate and forward to the agent.
 */
export type InterpretedMessage =
  | { readonly kind: "empty" }
  | { readonly kind: "command"; readonly command: SlashCommandInvocation }
  | { readonly kind: "prompt"; readonly segments: PromptSegment[] };

export interface InterpretOptions {
  /**
   * Bot's own `open_id`, used to recognise and drop self-mentions in text
   * messages. When omitted, all mentions are rendered as `@{name}`.
   */
  readonly botOpenId?: string;
}

/**
 * Interpret a Lark inbound message event.
 *
 * Text messages (and only text messages) are eligible to be classified as
 * commands. Every other message type becomes a `prompt` (or `empty`).
 *
 * The interpreter stays pure: it emits {@link PromptSegment}s, never
 * downloading bytes. Images (standalone and post-embedded) become `image-ref`
 * segments carrying `message_id` / `image_key`, which the bridge's hydrator
 * downloads into ACP image blocks. Files, audio and video become
 * `resource-ref` segments; unsupported attachments (sticker, share, location,
 * …) stay descriptive text.
 */
export function interpretLarkMessage(
  event: Lark.RawMessageEvent,
  opts: InterpretOptions = {},
): InterpretedMessage {
  const { message } = event;

  if (message.message_type === "text") {
    const text = extractTextContent(message.content, message.mentions, opts.botOpenId);
    if (!text) return { kind: "empty" };
    const command = slashCommandController.resolve(text);
    if (command) return { kind: "command", command };
    return { kind: "prompt", segments: [{ kind: "text", text }] };
  }

  return segmentsToPrompt(normalizeSegments(parseNonTextMessage(message)));
}

function parseNonTextMessage(message: Lark.RawMessageEvent["message"]): PromptSegment[] {
  switch (message.message_type) {
    case "post":
      return parsePost(message.content, message.message_id);
    case "image":
      return parseImage(message.content, message.message_id);
    case "file":
      return parseFile(message.content, message.message_id);
    case "audio":
      return parseAudio(message.content, message.message_id);
    case "media":
      return parseMedia(message.content, message.message_id);
    case "sticker":
      return parseSticker(message.content);
    case "share_chat":
      return parseShareChat(message.content);
    case "share_user":
      return parseShareUser(message.content);
    case "location":
      return parseLocation(message.content);
    case "merge_forward":
      return [{ kind: "text", text: "[合并转发消息 — 请通过工具调用获取子消息]" }];
    default:
      return [{ kind: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
  }
}

function segmentsToPrompt(segments: PromptSegment[]): InterpretedMessage {
  return segments.length ? { kind: "prompt", segments } : { kind: "empty" };
}

/**
 * Regularise an interleaved segment list: merge adjacent text segments into
 * one and drop empty-text segments. Image-ref segments are passed through
 * untouched, so text/attachment ordering is preserved.
 */
function normalizeSegments(segments: PromptSegment[]): PromptSegment[] {
  const out: PromptSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "image-ref" || segment.kind === "resource-ref") {
      out.push(segment);
      continue;
    }
    if (segment.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + segment.text };
      continue;
    }
    out.push(segment);
  }
  return out;
}

// ---- Private parsers ----

/**
 * Decode a Lark text-message payload into a plain string with mentions
 * inlined. The bot's own self-mention is stripped entirely (it's routing
 * metadata, not user content); other users' mentions become `@{name}`.
 */
function extractTextContent(
  raw: string,
  mentions: LarkRawMention[] | undefined,
  botOpenId: string | undefined,
): string {
  const payload = safeParse<TextPayload>(raw);
  let text = payload?.text ?? "";

  if (mentions) {
    for (const m of mentions) {
      const key = m.key;
      if (!key) continue;
      const isSelf = botOpenId !== undefined && m.id?.open_id === botOpenId;
      const replacement = isSelf ? "" : `@{${m.name ?? m.id?.open_id ?? key}}`;
      text = text.replaceAll(key, replacement);
    }
  }
  return text.trim();
}

function parsePost(raw: string, messageId: string): PromptSegment[] {
  const payload = safeParse<PostPayload>(raw);
  if (!payload) return [{ kind: "text", text: "[富文本消息解析失败]" }];

  const segments: PromptSegment[] = [];
  const lineBuffer: string[] = [];
  const flushText = (): void => {
    const text = lineBuffer.join("\n").trim();
    if (text) segments.push({ kind: "text", text });
    lineBuffer.length = 0;
  };

  if (payload.title) {
    lineBuffer.push(`**${payload.title}**`, "");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) {
    flushText();
    return segments;
  }

  for (const para of paragraphs) {
    if (!para.length) {
      lineBuffer.push("");
      continue;
    }

    const first = para[0];
    if (first?.tag === "code_block") {
      const lang = first.language ?? "";
      lineBuffer.push(`\`\`\`${lang}\n${first.text}\n\`\`\``);
      continue;
    }
    if (first?.tag === "hr") {
      lineBuffer.push("---");
      continue;
    }

    const lineParts: string[] = [];
    for (const el of para) {
      if (el.tag === "img") {
        if (lineParts.length) {
          lineBuffer.push(lineParts.join(""));
          lineParts.length = 0;
        }
        flushText();
        segments.push({ kind: "image-ref", messageId, imageKey: el.image_key });
        continue;
      }
      const rendered = elementToText(el);
      if (rendered) lineParts.push(rendered);
    }
    if (lineParts.length) lineBuffer.push(lineParts.join(""));
  }

  flushText();
  return segments;
}

function parseImage(raw: string, messageId: string): PromptSegment[] {
  const payload = safeParse<ImagePayload>(raw);
  const key = payload?.image_key;
  if (!key) return [{ kind: "text", text: "[图片消息缺少 image_key]" }];
  return [{ kind: "image-ref", messageId, imageKey: key }];
}

function parseFile(raw: string, messageId: string): PromptSegment[] {
  const p = safeParse<FilePayload>(raw);
  const name = p?.file_name ?? "未命名";
  const key = p?.file_key;
  if (!key) return [{ kind: "text", text: `[文件: ${name} (file_key=unknown)]` }];
  return [{ kind: "resource-ref", messageId, fileKey: key, name, label: `文件: ${name}` }];
}

function parseAudio(raw: string, messageId: string): PromptSegment[] {
  const p = safeParse<AudioPayload>(raw);
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key;
  if (!key) return [{ kind: "text", text: `[音频: ${dur} (file_key=unknown)]` }];
  return [
    {
      kind: "resource-ref",
      messageId,
      fileKey: key,
      name: `voice-${shortKey(key)}.opus`,
      label: `语音 (${dur})`,
    },
  ];
}

function parseMedia(raw: string, messageId: string): PromptSegment[] {
  const p = safeParse<MediaPayload>(raw);
  const key = p?.file_key;
  const name = p?.file_name ?? (key ? `video-${shortKey(key)}.mp4` : "未命名");
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  if (!key) return [{ kind: "text", text: `[视频: ${name} ${dur} (file_key=unknown)]` }];
  return [
    {
      kind: "resource-ref",
      messageId,
      fileKey: key,
      name,
      label: `视频: ${name} (${dur})`,
    },
  ];
}

function parseSticker(raw: string): PromptSegment[] {
  const p = safeParse<StickerPayload>(raw);
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[表情包 (file_key=${key})]` }];
}

function parseShareChat(raw: string): PromptSegment[] {
  const p = safeParse<ShareChatPayload>(raw);
  const id = p?.chat_id ?? "unknown";
  return [{ kind: "text", text: `[群名片: chat_id=${id}]` }];
}

function parseShareUser(raw: string): PromptSegment[] {
  const p = safeParse<ShareUserPayload>(raw);
  const id = p?.user_id ?? "unknown";
  return [{ kind: "text", text: `[个人名片: user_id=${id}]` }];
}

function parseLocation(raw: string): PromptSegment[] {
  const p = safeParse<LocationPayload>(raw);
  const name = p?.name ?? "未命名地点";
  const lat = p?.latitude ?? "?";
  const lon = p?.longitude ?? "?";
  return [{ kind: "text", text: `[位置: ${name} (${lat}, ${lon})]` }];
}

function shortKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 12) || "unknown";
}

// ---- Element renderers ----

function elementToText(el: PostElement): string {
  switch (el.tag) {
    case "text": {
      let t = el.text;
      if (el.style?.length) {
        for (const st of el.style) {
          switch (st) {
            case "bold":
              t = `**${t}**`;
              break;
            case "italic":
              t = `*${t}*`;
              break;
            case "underline":
              t = `<u>${t}</u>`;
              break;
            case "lineThrough":
              t = `~~${t}~~`;
              break;
          }
        }
      }
      return t;
    }
    case "a": {
      const label = el.text ?? el.href ?? "";
      return el.href ? `[${label}](${el.href})` : label;
    }
    case "at":
      return `@{${el.user_name ?? el.user_id}}`;
    case "media":
      return `[视频/文件: ${el.file_key ?? el.image_key ?? "unknown"}]`;
    case "emotion":
      return `:${el.emoji_type}:`;
    case "img":
    case "code_block":
    case "hr":
      return ""; // handled at paragraph / block level
  }
}

// ---- Helpers ----

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
