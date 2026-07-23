/**
 * Integration test for the inline-image pipeline (Agent → Lark card).
 *
 * Exercises the resolve→upload step `chat-runtime.resolveInlineImages` performs:
 * each collected image source (ACP block, local file, remote URL) is resolved to
 * bytes and uploaded to an `img_key` for an inline card `img` element; a source
 * that can't be resolved or uploaded patches to a text placeholder instead.
 * Also covers `extractMarkdownImages` (used to pull file/URL images out of the
 * finalized agent text) and its chunk-split robustness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractMarkdownImages,
  outboundImagePlaceholder,
  type OutboundImageSource,
} from "../src/gateway/outbound-image.js";
import { resolveImageBytes } from "../src/gateway/outbound-image-loader.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/** Terminal state of an inline image entry after its upload settles. */
type InlineResult =
  | { readonly status: "ready"; readonly imgKey: string }
  | { readonly status: "failed"; readonly fallback: string };

/** Mirror of `chat-runtime.resolveInlineImages`, driven against test doubles. */
async function resolveAll(
  sources: readonly OutboundImageSource[],
  uploadCardImage: (bytes: Buffer) => Promise<string | null>,
): Promise<InlineResult[]> {
  const out: InlineResult[] = [];
  for (const source of sources) {
    try {
      const { bytes } = await resolveImageBytes(source);
      const imgKey = await uploadCardImage(bytes);
      if (imgKey === null) {
        out.push({ status: "failed", fallback: outboundImagePlaceholder(source) });
      } else {
        out.push({ status: "ready", imgKey });
      }
    } catch {
      out.push({ status: "failed", fallback: outboundImagePlaceholder(source) });
    }
  }
  return out;
}

describe("outbound image pipeline", () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let localImagePath: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BYTES);
        return;
      }
      if (req.url === "/notimage.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outimg-it-"));
    localImagePath = path.join(tmpDir, "shot.png");
    await fs.writeFile(localImagePath, PNG_BYTES);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves all three source forms to img_keys, in order", async () => {
    // Simulate the collected turn: one ACP image block, plus finalized text
    // carrying a local file image and a remote URL image.
    const acpBlock: OutboundImageSource = {
      kind: "acp-image",
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    };
    const fileUrl = pathToFileURL(localImagePath).href;
    const text = `Here is the screenshot ![local](${fileUrl}) and the download ![remote](${baseUrl}/ok.png).`;
    const { sources: markdownSources, cleaned } = extractMarkdownImages(text);

    // Text is stripped of the image markdown for the card.
    expect(cleaned).not.toContain("![");
    expect(cleaned).toContain("Here is the screenshot");

    const all = [acpBlock, ...markdownSources];
    expect(all.map((s) => s.kind)).toEqual(["acp-image", "local-file", "remote-url"]);

    let counter = 0;
    const results = await resolveAll(all, async () => `img_key_${String(++counter)}`);
    expect(results).toEqual([
      { status: "ready", imgKey: "img_key_1" },
      { status: "ready", imgKey: "img_key_2" },
      { status: "ready", imgKey: "img_key_3" },
    ]);
  });

  it("falls back to a text placeholder when a remote source is not an image", async () => {
    const text = `broken ![x](${baseUrl}/notimage.html)`;
    const { sources } = extractMarkdownImages(text);
    const results = await resolveAll(sources, async () => "img_key");
    expect(results).toEqual([
      { status: "failed", fallback: `[图片下载失败: ${baseUrl}/notimage.html]` },
    ]);
  });

  it("falls back to a text placeholder when upload fails", async () => {
    const acpBlock: OutboundImageSource = {
      kind: "acp-image",
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    };
    const results = await resolveAll([acpBlock], async () => null);
    expect(results).toEqual([{ status: "failed", fallback: "[图片发送失败]" }]);
  });

  it("handles chunk-split markdown once text is finalized", () => {
    // Streaming might split `![](...)` across chunks; extraction runs on the
    // reassembled text, so the reference is still found.
    const chunks = ["look ![cat](", `${baseUrl}/ok.png`, ") done"];
    const finalized = chunks.join("");
    const { sources } = extractMarkdownImages(finalized);
    expect(sources).toEqual([{ kind: "remote-url", url: `${baseUrl}/ok.png`, alt: "cat" }]);
  });
});
