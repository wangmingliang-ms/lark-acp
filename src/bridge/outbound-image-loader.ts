/**
 * Outbound image loader — the effectful counterpart of {@link outbound-image}.
 *
 * Resolves an {@link OutboundImageSource} to raw bytes plus a MIME type, ready
 * for upload to Feishu. Mirrors the inbound {@link prompt-hydrator} in spirit:
 * a 10 MiB cap, MIME sniffing, and defensive fetching. Unlike the hydrator this
 * module *does* throw on failure — the caller ({@link chat-runtime}) degrades a
 * single failed image to a text placeholder without aborting the turn.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { sniffImageMime } from "../lark/lark-http.js";
import type { OutboundImageSource } from "./outbound-image.js";

/** Max outbound image size. Larger images are rejected. 10 MiB. */
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

/** Default timeout for fetching a remote image before aborting. */
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** Resolved image bytes with a concrete MIME type. */
export interface ResolvedImage {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

export interface ResolveImageDeps {
  /** Injectable for tests; defaults to {@link MAX_OUTBOUND_IMAGE_BYTES}. */
  readonly maxBytes?: number;
  /** Injectable for tests; defaults to {@link REMOTE_IMAGE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Raised when an outbound image cannot be resolved to uploadable bytes. */
export class OutboundImageError extends Error {
  override readonly name = "OutboundImageError";

  constructor(
    message: string,
    readonly kind: OutboundImageSource["kind"],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Resolve an outbound image source to bytes + MIME type.
 *
 * @throws {OutboundImageError} when bytes can't be obtained: bad base64, a
 *   missing/oversized/non-absolute local file, or a failed/oversized/non-image
 *   remote fetch.
 */
export async function resolveImageBytes(
  source: OutboundImageSource,
  deps: ResolveImageDeps = {},
): Promise<ResolvedImage> {
  const maxBytes = deps.maxBytes ?? MAX_OUTBOUND_IMAGE_BYTES;
  switch (source.kind) {
    case "acp-image":
      return resolveAcpImage(source, maxBytes);
    case "local-file":
      return resolveLocalFile(source, maxBytes);
    case "remote-url":
      return resolveRemoteUrl(source, deps, maxBytes);
  }
}

function resolveAcpImage(
  source: Extract<OutboundImageSource, { kind: "acp-image" }>,
  maxBytes: number,
): ResolvedImage {
  const bytes = Buffer.from(source.base64, "base64");
  if (bytes.length === 0) {
    throw new OutboundImageError("ACP image decoded to empty bytes", "acp-image");
  }
  if (bytes.length > maxBytes) {
    throw new OutboundImageError(
      `ACP image is ${String(bytes.length)} bytes, exceeds cap ${String(maxBytes)}`,
      "acp-image",
    );
  }
  const mimeType = source.mimeType.trim().length > 0 ? source.mimeType : sniffImageMime(bytes);
  return { bytes, mimeType };
}

async function resolveLocalFile(
  source: Extract<OutboundImageSource, { kind: "local-file" }>,
  maxBytes: number,
): Promise<ResolvedImage> {
  if (!path.isAbsolute(source.path)) {
    throw new OutboundImageError(`local image path is not absolute: ${source.path}`, "local-file");
  }
  let bytes: Buffer;
  try {
    const stat = await fs.stat(source.path);
    if (!stat.isFile()) {
      throw new OutboundImageError(`local image path is not a file: ${source.path}`, "local-file");
    }
    if (stat.size > maxBytes) {
      throw new OutboundImageError(
        `local image is ${String(stat.size)} bytes, exceeds cap ${String(maxBytes)}`,
        "local-file",
      );
    }
    bytes = await fs.readFile(source.path);
  } catch (err) {
    if (err instanceof OutboundImageError) throw err;
    throw new OutboundImageError(`failed to read local image: ${source.path}`, "local-file", {
      cause: err,
    });
  }
  return { bytes, mimeType: sniffImageMime(bytes) };
}

async function resolveRemoteUrl(
  source: Extract<OutboundImageSource, { kind: "remote-url" }>,
  deps: ResolveImageDeps,
  maxBytes: number,
): Promise<ResolvedImage> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(source.url, { signal: controller.signal });
    if (!response.ok) {
      throw new OutboundImageError(
        `remote image fetch returned HTTP ${String(response.status)}: ${source.url}`,
        "remote-url",
      );
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (contentType.length > 0 && !contentType.startsWith("image/")) {
      throw new OutboundImageError(
        `remote resource is not an image (content-type ${contentType}): ${source.url}`,
        "remote-url",
      );
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new OutboundImageError(
        `remote image declares ${String(declaredLength)} bytes, exceeds cap ${String(maxBytes)}`,
        "remote-url",
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new OutboundImageError(`remote image is empty: ${source.url}`, "remote-url");
    }
    if (bytes.length > maxBytes) {
      throw new OutboundImageError(
        `remote image is ${String(bytes.length)} bytes, exceeds cap ${String(maxBytes)}`,
        "remote-url",
      );
    }
    const mimeType = contentType.startsWith("image/") ? contentType : sniffImageMime(bytes);
    return { bytes, mimeType };
  } catch (err) {
    if (err instanceof OutboundImageError) throw err;
    throw new OutboundImageError(`failed to fetch remote image: ${source.url}`, "remote-url", {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}
