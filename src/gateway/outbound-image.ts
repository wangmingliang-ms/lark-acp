/**
 * Outbound image extraction — the pure counterpart of {@link outbound-image-loader}.
 *
 * Agents emit images in three forms: ACP `image` content blocks (handled at the
 * session layer), and two markdown-embedded forms — local files (`![](file://…)`
 * or a bare path) and remote URLs (`![](https://…)`). Feishu renders images only
 * as uploaded `image_key`s, so the gateway pulls image references *out* of the
 * agent's text and sends them as standalone `image` messages.
 *
 * This module walks the `marked` inline token tree to find image references and
 * returns both the classified {@link OutboundImageSource}s and a `cleaned` copy
 * of the text with those references removed (so the text card stays clean rather
 * than degrading images to `[图片](href)` links). Pure and total — never throws.
 */

import { fileURLToPath } from "node:url";
import { marked, type Token, type Tokens } from "marked";

/**
 * A resolvable outbound image reference, discriminated by where its bytes live.
 * `acp-image` originates from an ACP `image` content block; the other two are
 * extracted from agent markdown by {@link extractMarkdownImages}.
 */
export type OutboundImageSource =
  | { readonly kind: "acp-image"; readonly base64: string; readonly mimeType: string }
  | { readonly kind: "local-file"; readonly path: string; readonly alt?: string }
  | { readonly kind: "remote-url"; readonly url: string; readonly alt?: string };

/** Result of pulling image references out of a block of agent markdown. */
export interface ExtractedImages {
  readonly sources: readonly OutboundImageSource[];
  /** The input text with every extracted image reference removed. */
  readonly cleaned: string;
}

/**
 * An ordered piece of an agent message: either a run of text (markdown) or a
 * single image reference. Concatenating the `text` pieces with the images
 * removed reproduces the original document order — this is what lets the card
 * interleave `markdown` and `img` elements in place.
 */
export type MarkdownSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly source: OutboundImageSource };

/**
 * Split agent markdown into an ordered list of text/image segments, preserving
 * the position of each image relative to its surrounding prose. Uses the
 * `marked` AST to locate real image tokens (so `![]` inside a code block is not
 * mistaken for an image), then slices the source text at each image's raw span.
 *
 * Pure and total. Text with no images yields a single text segment (or none for
 * empty input). Adjacent/empty text runs are dropped so the result contains no
 * empty text segments.
 */
export function splitMarkdownIntoSegments(text: string): readonly MarkdownSegment[] {
  if (text.length === 0) return [];

  const images: { readonly source: OutboundImageSource; readonly raw: string }[] = [];
  collectImageTokensWithRaw(marked.lexer(text), images);
  if (images.length === 0) return [{ kind: "text", text }];

  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  for (const image of images) {
    const at = text.indexOf(image.raw, cursor);
    if (at < 0) continue; // raw not found (shouldn't happen) — skip, keep order
    if (at > cursor) segments.push({ kind: "text", text: text.slice(cursor, at) });
    segments.push({ kind: "image", source: image.source });
    cursor = at + image.raw.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.filter((segment) => segment.kind !== "text" || segment.text.length > 0);
}

/** Walk the token tree in document order, recording each image's source + raw span. */
function collectImageTokensWithRaw(
  tokens: readonly Token[],
  out: { source: OutboundImageSource; raw: string }[],
): void {
  for (const token of tokens) {
    if (token.type === "image") {
      const image = token as Tokens.Image;
      const source = classifyImageHref(image.href, image.text);
      if (source !== null) out.push({ source, raw: image.raw });
      continue;
    }
    const nested = (token as { tokens?: readonly Token[] }).tokens;
    if (nested !== undefined) collectImageTokensWithRaw(nested, out);
  }
}

/**
 * Extract image references from `text` and return them alongside a `cleaned`
 * copy with those references stripped. Classifies each `![alt](href)` by the
 * href scheme: `file:` and bare/relative paths become {@link local-file},
 * `http(s):` becomes {@link remote-url}. Order of appearance is preserved.
 *
 * Pure and total — malformed markdown simply yields no sources.
 */
export function extractMarkdownImages(text: string): ExtractedImages {
  if (text.length === 0) return { sources: [], cleaned: text };

  const sources: OutboundImageSource[] = [];
  const tokens = marked.lexer(text);
  collectImageTokens(tokens, sources);

  if (sources.length === 0) return { sources: [], cleaned: text };

  return { sources, cleaned: stripImageMarkdown(text) };
}

/** Recursively walk the token tree, appending a source for each image token. */
function collectImageTokens(tokens: readonly Token[], out: OutboundImageSource[]): void {
  for (const token of tokens) {
    if (token.type === "image") {
      const source = classifyImageHref((token as Tokens.Image).href, (token as Tokens.Image).text);
      if (source !== null) out.push(source);
      continue;
    }
    const nested = (token as { tokens?: readonly Token[] }).tokens;
    if (nested !== undefined) collectImageTokens(nested, out);
  }
}

/**
 * Classify a markdown image href into a loadable source. Returns `null` for
 * hrefs we can't resolve to bytes (e.g. `data:` URIs are already inline; an
 * empty href is meaningless).
 */
function classifyImageHref(href: string, alt: string): OutboundImageSource | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;

  const altText = alt.trim();
  const withAlt = altText.length > 0 ? { alt: altText } : {};

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { kind: "remote-url", url: trimmed, ...withAlt };
  }
  if (trimmed.startsWith("file://")) {
    const localPath = safeFileUrlToPath(trimmed);
    if (localPath === null) return null;
    return { kind: "local-file", path: localPath, ...withAlt };
  }
  // `data:` URIs carry their own bytes and don't map to an upload flow; skip.
  if (trimmed.startsWith("data:")) return null;

  // Anything else is treated as a filesystem path (absolute or relative).
  return { kind: "local-file", path: trimmed, ...withAlt };
}

/** Convert a `file://` URL to a path, returning `null` on a malformed URL. */
function safeFileUrlToPath(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return null;
  }
}

/** Regex matching a markdown image span `![alt](href)` (alt/href may be empty). */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
/** Collapse 3+ consecutive newlines left behind after stripping images. */
const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

/** Remove every markdown image span from `text` and tidy leftover blank lines. */
function stripImageMarkdown(text: string): string {
  return text.replaceAll(MARKDOWN_IMAGE_RE, "").replace(EXCESS_BLANK_LINES_RE, "\n\n").trim();
}

/**
 * Text fallback for an outbound image that couldn't be delivered. Local paths
 * are intentionally omitted from the message — they leak the host filesystem
 * layout; the path is logged for operators instead.
 */
export function outboundImagePlaceholder(source: OutboundImageSource): string {
  switch (source.kind) {
    case "acp-image":
      return "[图片发送失败]";
    case "local-file":
      return "[图片发送失败]";
    case "remote-url":
      return `[图片下载失败: ${source.url}]`;
  }
}
