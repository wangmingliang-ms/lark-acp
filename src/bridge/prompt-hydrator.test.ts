import { describe, it, expect, vi } from "vitest";
import {
  hydratePrompt,
  imagePlaceholder,
  MAX_INLINE_IMAGE_BYTES,
  type ImageDownloader,
  type HydrateDeps,
} from "./prompt-hydrator.js";
import type { PromptSegment } from "../interpreter/lark-interpreter.js";
import type { LarkLogger } from "../logger/logger.js";

const silentLogger: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return silentLogger;
  },
};

/** A logger whose `warn` is a spy; everything else is inert. */
function spyLogger(): { logger: LarkLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: LarkLogger = {
    debug(): void {},
    info(): void {},
    warn,
    error(): void {},
    child(): LarkLogger {
      return logger;
    },
  };
  return { logger, warn };
}

/** Downloader returning a fixed buffer. */
function fakeDownloader(bytes: Buffer, mimeType = "image/png"): ImageDownloader {
  return {
    downloadMessageImage: vi.fn(async () => ({ bytes, mimeType })),
  };
}

function deps(over: Partial<HydrateDeps> & { downloader: ImageDownloader }): HydrateDeps {
  return { logger: silentLogger, ...over };
}

describe("hydratePrompt", () => {
  it("passes a text segment through as a text block", async () => {
    const segments: PromptSegment[] = [{ kind: "text", text: "hello" }];
    const blocks = await hydratePrompt(
      segments,
      deps({ downloader: fakeDownloader(Buffer.from("x")) }),
    );
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("downloads an image-ref into an image block (base64 data + mimeType)", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_1", imageKey: "img_k" }];
    const downloader = fakeDownloader(bytes, "image/png");
    const blocks = await hydratePrompt(segments, deps({ downloader }));
    expect(blocks).toEqual([
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
    expect(downloader.downloadMessageImage).toHaveBeenCalledWith("om_1", "img_k");
  });

  it("falls back to text placeholder and warns when download throws", async () => {
    const { logger, warn } = spyLogger();
    const downloader: ImageDownloader = {
      downloadMessageImage: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_2", imageKey: "k2" }];
    const blocks = await hydratePrompt(segments, deps({ downloader, logger }));
    expect(blocks).toEqual([{ type: "text", text: imagePlaceholder("om_2", "k2") }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to text placeholder and warns when the image is oversize", async () => {
    const { logger, warn } = spyLogger();
    const bytes = Buffer.alloc(11);
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_3", imageKey: "k3" }];
    const blocks = await hydratePrompt(
      segments,
      deps({ downloader: fakeDownloader(bytes), logger, maxInlineImageBytes: 10 }),
    );
    expect(blocks).toEqual([{ type: "text", text: imagePlaceholder("om_3", "k3") }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps output order across mixed text + multiple concurrent images", async () => {
    const a = Buffer.from([1]);
    const c = Buffer.from([3]);
    const downloader: ImageDownloader = {
      downloadMessageImage: vi.fn(async (_messageId: string, imageKey: string) => {
        // out-of-order completion: 'a' resolves after 'c'
        if (imageKey === "a") {
          await new Promise((r) => setTimeout(r, 10));
          return { bytes: a, mimeType: "image/png" };
        }
        return { bytes: c, mimeType: "image/jpeg" };
      }),
    };
    const segments: PromptSegment[] = [
      { kind: "image-ref", messageId: "m", imageKey: "a" },
      { kind: "text", text: "middle" },
      { kind: "image-ref", messageId: "m", imageKey: "c" },
    ];
    const blocks = await hydratePrompt(segments, deps({ downloader }));
    expect(blocks).toEqual([
      { type: "image", data: a.toString("base64"), mimeType: "image/png" },
      { type: "text", text: "middle" },
      { type: "image", data: c.toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("MAX_INLINE_IMAGE_BYTES is 10 MiB", () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
