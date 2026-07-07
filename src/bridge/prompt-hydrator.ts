/**
 * Prompt hydrator — the effectful bridge-layer counterpart of the pure
 * interpreter. Turns interpreter {@link PromptSegment}s into ACP
 * {@link acp.ContentBlock}s, downloading referenced images along the way.
 *
 * This is the single decision point for "inline image vs. text placeholder":
 * a successful, in-budget download becomes an ACP `image` block; any failure
 * or oversize falls back to the same text placeholder the interpreter used
 * before this feature, so one bad image never breaks a whole message. To add
 * ACP capability gating later, gate here — nothing else needs to change.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { PromptSegment } from "../interpreter/lark-interpreter.js";
import type { LarkLogger } from "../logger/logger.js";

/** Max inline image size; larger images fall back to a text placeholder to
 *  avoid blowing the stdio pipe / being rejected by the model. 10 MiB. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Narrow capability the hydrator needs; {@link LarkHttpClient} satisfies it. */
export interface ImageDownloader {
  downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface HydrateDeps {
  readonly downloader: ImageDownloader;
  readonly logger: LarkLogger;
  /** Injectable for tests; defaults to {@link MAX_INLINE_IMAGE_BYTES}. */
  readonly maxInlineImageBytes?: number;
}

/**
 * Text fallback for an image that couldn't be inlined. Byte-for-byte identical
 * to the interpreter's pre-feature placeholder, guaranteeing zero regression.
 */
export function imagePlaceholder(messageId: string, imageKey: string): string {
  return `[图片 (message_id=${messageId}, image_key=${imageKey})]`;
}

/**
 * Hydrate interpreter segments into ACP content blocks. `text` segments pass
 * through unchanged; `image-ref` segments are downloaded concurrently and
 * become `image` blocks (or a text placeholder on failure/oversize). Output
 * order strictly matches input order. Never throws — a single image failure is
 * logged and downgraded to a placeholder.
 */
export async function hydratePrompt(
  segments: readonly PromptSegment[],
  deps: HydrateDeps,
): Promise<acp.ContentBlock[]> {
  const maxBytes = deps.maxInlineImageBytes ?? MAX_INLINE_IMAGE_BYTES;
  return Promise.all(segments.map((segment) => hydrateSegment(segment, deps, maxBytes)));
}

async function hydrateSegment(
  segment: PromptSegment,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  if (segment.kind === "text") return { type: "text", text: segment.text };
  return downloadImageBlock(segment.messageId, segment.imageKey, deps, maxBytes);
}

async function downloadImageBlock(
  messageId: string,
  imageKey: string,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  try {
    const { bytes, mimeType } = await deps.downloader.downloadMessageImage(messageId, imageKey);
    if (bytes.length > maxBytes) {
      deps.logger.warn(
        { messageId, imageKey, bytes: bytes.length, maxBytes },
        "inbound image too large — falling back to text placeholder",
      );
      return { type: "text", text: imagePlaceholder(messageId, imageKey) };
    }
    return { type: "image", data: bytes.toString("base64"), mimeType };
  } catch (err) {
    deps.logger.warn(
      { err, messageId, imageKey },
      "inbound image download failed — falling back to text placeholder",
    );
    return { type: "text", text: imagePlaceholder(messageId, imageKey) };
  }
}
