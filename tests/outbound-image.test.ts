/**
 * Integration test for the outbound image pipeline (Agent → Lark).
 *
 * Exercises the same composition `chat-runtime.runPrompt` performs: collect ACP
 * `image` blocks + extract markdown-embedded images from the finalized agent
 * text, then resolve each source to bytes and deliver it as a standalone image
 * message. Covers all three source forms (ACP block, local file, remote URL)
 * plus the text-placeholder fallback when a source can't be resolved/uploaded.
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
} from "../src/bridge/outbound-image.js";
import { resolveImageBytes } from "../src/bridge/outbound-image-loader.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/** A presenter double capturing image sends and text fallbacks in order. */
interface DeliveryLog {
  readonly kind: "image" | "text";
  readonly detail: string;
}

/** Mirror of `chat-runtime.deliverOutboundImages`, driven against test doubles. */
async function deliverAll(
  sources: readonly OutboundImageSource[],
  replyImage: (bytes: Buffer) => Promise<boolean>,
): Promise<DeliveryLog[]> {
  const log: DeliveryLog[] = [];
  for (const source of sources) {
    try {
      const { bytes } = await resolveImageBytes(source);
      const ok = await replyImage(bytes);
      if (ok) log.push({ kind: "image", detail: `${String(bytes.length)}B` });
      else log.push({ kind: "text", detail: outboundImagePlaceholder(source) });
    } catch {
      log.push({ kind: "text", detail: outboundImagePlaceholder(source) });
    }
  }
  return log;
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

  it("delivers all three source forms as independent images, in order", async () => {
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

    const log = await deliverAll(all, async () => true);
    expect(log.map((l) => l.kind)).toEqual(["image", "image", "image"]);
  });

  it("falls back to a text placeholder when a remote source is not an image", async () => {
    const text = `broken ![x](${baseUrl}/notimage.html)`;
    const { sources } = extractMarkdownImages(text);
    const log = await deliverAll(sources, async () => true);
    expect(log).toEqual([{ kind: "text", detail: `[图片下载失败: ${baseUrl}/notimage.html]` }]);
  });

  it("falls back to a text placeholder when upload fails", async () => {
    const acpBlock: OutboundImageSource = {
      kind: "acp-image",
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    };
    const log = await deliverAll([acpBlock], async () => false);
    expect(log).toEqual([{ kind: "text", detail: "[图片发送失败]" }]);
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
