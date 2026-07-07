/**
 * Lark message interpreter — translate a Lark message event into the pure
 * {@link PromptSegment}[] shape the bridge hydrates into an agent prompt.
 *
 * Images (standalone and post-embedded) become `image-ref` segments; the
 * bridge's prompt hydrator downloads them into ACP image blocks. Every other
 * attachment is rendered as a descriptive text segment. This module stays
 * pure — no bytes are downloaded here.
 *
 * Content shapes are based on the Lark Open Platform docs:
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

import type * as Lark from "@larksuiteoapi/node-sdk";

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
  | { readonly kind: "image-ref"; readonly messageId: string; readonly imageKey: string };

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
export type ProfileCommandName = "agent" | "model" | "mode" | "permission";
export type ProfilePermissionMode = "alwaysAsk" | "alwaysAllow" | "alwaysDeny";

export type LarkCommand =
  | { readonly kind: "cancel" }
  | { readonly kind: "new" }
  | { readonly kind: "help" }
  | { readonly kind: "capabilities"; readonly agent: string | null }
  | { readonly kind: "bind"; readonly cwd: string; readonly agent: string | null }
  | { readonly kind: "bind-usage" }
  | { readonly kind: "unbind" }
  | { readonly kind: "where" }
  | { readonly kind: "set-agent"; readonly agent: string }
  | { readonly kind: "list-agents" }
  | { readonly kind: "set-model"; readonly model: string | "auto" }
  | { readonly kind: "list-models" }
  | { readonly kind: "set-mode"; readonly mode: string }
  | { readonly kind: "list-modes" }
  | { readonly kind: "set-permission"; readonly permissionMode: ProfilePermissionMode }
  | { readonly kind: "list-permissions" }
  | { readonly kind: "profile" }
  | { readonly kind: "profile-command-usage"; readonly command: ProfileCommandName };

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
  | { readonly kind: "command"; readonly command: LarkCommand }
  | { readonly kind: "prompt"; readonly segments: PromptSegment[] };

export interface InterpretOptions {
  /**
   * Bot's own `open_id`, used to recognise and drop self-mentions in text
   * messages. When omitted, all mentions are rendered as `@{name}`.
   */
  readonly botOpenId?: string;
}

const CANCEL_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/cancel", "/stop", "取消", "停止"]);
const NEW_SESSION_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/new", "/restart"]);
const UNBIND_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/unbind", "/unpin"]);
const WHERE_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/where", "/pwd", "/binding"]);
const PROFILE_PERMISSION_MODES: ReadonlySet<ProfilePermissionMode> = new Set([
  "alwaysAsk",
  "alwaysAllow",
  "alwaysDeny",
]);
const BIND_COMMAND_TOKEN = "/bind";
const AGENT_COMMAND_TOKEN = "/agent";
const MODEL_COMMAND_TOKEN = "/model";
const MODE_COMMAND_TOKEN = "/mode";
const PERMISSION_COMMAND_TOKEN = "/permission";
const PROFILE_COMMAND_TOKEN = "/profile";
const HELP_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/help", "/commands"]);
const CAPABILITIES_COMMAND_TOKEN = "/capabilities";

/**
 * Interpret a Lark inbound message event.
 *
 * Text messages (and only text messages) are eligible to be classified as
 * commands. Every other message type becomes a `prompt` (or `empty`).
 *
 * The interpreter stays pure: it emits {@link PromptSegment}s, never
 * downloading bytes. Images (standalone and post-embedded) become `image-ref`
 * segments carrying `message_id` / `image_key`, which the bridge's hydrator
 * downloads into ACP image blocks. Every other attachment (file, audio, video,
 * sticker, …) is rendered as a descriptive text segment.
 */
export function interpretLarkMessage(
  event: Lark.RawMessageEvent,
  opts: InterpretOptions = {},
): InterpretedMessage {
  const { message } = event;

  if (message.message_type === "text") {
    const text = extractTextContent(message.content, message.mentions, opts.botOpenId);
    if (!text) return { kind: "empty" };
    const command = detectCommand(text);
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
      return parseFile(message.content);
    case "audio":
      return parseAudio(message.content);
    case "media":
      return parseMedia(message.content);
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
 * untouched, so text/image ordering is preserved.
 */
function normalizeSegments(segments: PromptSegment[]): PromptSegment[] {
  const out: PromptSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "image-ref") {
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

function detectCommand(text: string): LarkCommand | null {
  if (CANCEL_COMMAND_TOKENS.has(text)) return { kind: "cancel" };
  if (NEW_SESSION_COMMAND_TOKENS.has(text)) return { kind: "new" };
  if (HELP_COMMAND_TOKENS.has(text)) return { kind: "help" };
  const capabilitiesCommand = detectCapabilitiesCommand(text);
  if (capabilitiesCommand) return capabilitiesCommand;
  if (UNBIND_COMMAND_TOKENS.has(text)) return { kind: "unbind" };
  if (WHERE_COMMAND_TOKENS.has(text)) return { kind: "where" };
  const profileCommand = detectProfileCommand(text);
  if (profileCommand) return profileCommand;
  return detectBindCommand(text);
}

function detectCapabilitiesCommand(text: string): LarkCommand | null {
  const rest = stripLeadingToken(text, CAPABILITIES_COMMAND_TOKEN);
  if (rest === null) return null;
  if (rest.length === 0) return { kind: "capabilities", agent: null };
  if (/\s/.test(rest)) return null;
  return { kind: "capabilities", agent: rest };
}

function detectProfileCommand(text: string): LarkCommand | null {
  const agent = detectSingleArgCommand(text, AGENT_COMMAND_TOKEN, "agent");
  if (agent) {
    if (agent.kind === "usage") return { kind: "list-agents" };
    return { kind: "set-agent", agent: agent.value };
  }

  const model = detectSingleArgCommand(text, MODEL_COMMAND_TOKEN, "model");
  if (model) {
    if (model.kind === "usage") return { kind: "list-models" };
    return { kind: "set-model", model: model.value };
  }

  const mode = detectSingleArgCommand(text, MODE_COMMAND_TOKEN, "mode");
  if (mode) {
    if (mode.kind === "usage") return { kind: "list-modes" };
    return { kind: "set-mode", mode: mode.value };
  }

  const permission = detectSingleArgCommand(text, PERMISSION_COMMAND_TOKEN, "permission");
  if (permission) {
    if (permission.kind === "usage") return { kind: "list-permissions" };
    if (isProfilePermissionMode(permission.value)) {
      return { kind: "set-permission", permissionMode: permission.value };
    }
    return null;
  }

  const profileRest = stripLeadingToken(text, PROFILE_COMMAND_TOKEN);
  if (profileRest === "") return { kind: "profile" };
  return null;
}

type SingleArgCommandResult =
  | { readonly kind: "arg"; readonly value: string }
  | {
      readonly kind: "usage";
      readonly command: {
        readonly kind: "profile-command-usage";
        readonly command: ProfileCommandName;
      };
    };

function detectSingleArgCommand(
  text: string,
  token: string,
  command: ProfileCommandName,
): SingleArgCommandResult | null {
  const rest = stripLeadingToken(text, token);
  if (rest === null) return null;
  if (rest.length === 0)
    return { kind: "usage", command: { kind: "profile-command-usage", command } };
  if (/\s/.test(rest)) return null;
  return { kind: "arg", value: rest };
}

function isProfilePermissionMode(value: string): value is ProfilePermissionMode {
  return PROFILE_PERMISSION_MODES.has(value as ProfilePermissionMode);
}

/**
 * Parse a `/bind [path] [agent]` message. Unlike the other commands, `/bind`
 * takes positional arguments, so it matches on the leading token rather than
 * the whole message.
 *
 * - `/bind` (no path)            → `bind-usage` (bridge replies with help)
 * - `/bind <path>`               → `bind` with `agent: null` (bridge picks default)
 * - `/bind <path> <agent...>`    → `bind` with the rest joined as the agent
 *
 * The agent tail is kept as a single string so raw commands with their own
 * flags survive (e.g. `/bind ~/proj node ./my-acp.js --port 9000`). Path
 * expansion / validation happens in the bridge, not here.
 */
function detectBindCommand(text: string): LarkCommand | null {
  const rest = stripLeadingToken(text, BIND_COMMAND_TOKEN);
  if (rest === null) return null;
  if (rest.length === 0) return { kind: "bind-usage" };

  const firstSpace = rest.search(/\s/);
  if (firstSpace < 0) return { kind: "bind", cwd: rest, agent: null };

  const cwd = rest.slice(0, firstSpace);
  const agent = rest.slice(firstSpace + 1).trim();
  return { kind: "bind", cwd, agent: agent.length > 0 ? agent : null };
}

/**
 * If `text` is exactly `token` or starts with `token` followed by
 * whitespace, return the trimmed remainder (possibly empty). Otherwise
 * `null`. Guards against `/bindfoo` matching `/bind`.
 */
function stripLeadingToken(text: string, token: string): string | null {
  if (text === token) return "";
  if (!text.startsWith(token)) return null;
  const next = text.charAt(token.length);
  if (next.trim().length !== 0) return null; // e.g. "/bindx" — not our command
  return text.slice(token.length).trim();
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

function parseFile(raw: string): PromptSegment[] {
  const p = safeParse<FilePayload>(raw);
  const name = p?.file_name ?? "未命名";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[文件: ${name} (file_key=${key})]` }];
}

function parseAudio(raw: string): PromptSegment[] {
  const p = safeParse<AudioPayload>(raw);
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[音频: ${dur} (file_key=${key})]` }];
}

function parseMedia(raw: string): PromptSegment[] {
  const p = safeParse<MediaPayload>(raw);
  const name = p?.file_name ?? "未命名";
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[视频: ${name} ${dur} (file_key=${key})]` }];
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
