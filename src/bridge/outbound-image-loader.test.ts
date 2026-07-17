import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveImageBytes,
  OutboundImageError,
  MAX_OUTBOUND_IMAGE_BYTES,
} from "./outbound-image-loader.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function fakeFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("resolveImageBytes: acp-image", () => {
  it("decodes base64 and keeps provided mime", async () => {
    const base64 = PNG_BYTES.toString("base64");
    const res = await resolveImageBytes({ kind: "acp-image", base64, mimeType: "image/png" });
    expect(res.bytes.equals(PNG_BYTES)).toBe(true);
    expect(res.mimeType).toBe("image/png");
  });

  it("sniffs mime when missing", async () => {
    const base64 = PNG_BYTES.toString("base64");
    const res = await resolveImageBytes({ kind: "acp-image", base64, mimeType: "" });
    expect(res.mimeType).toBe("image/png");
  });

  it("rejects empty base64", async () => {
    await expect(
      resolveImageBytes({ kind: "acp-image", base64: "", mimeType: "" }),
    ).rejects.toThrow(OutboundImageError);
  });

  it("rejects oversize", async () => {
    const big = Buffer.alloc(MAX_OUTBOUND_IMAGE_BYTES + 1).toString("base64");
    await expect(
      resolveImageBytes({ kind: "acp-image", base64: big, mimeType: "image/png" }),
    ).rejects.toThrow(/exceeds cap/);
  });
});

describe("resolveImageBytes: local-file", () => {
  it("reads an absolute file and sniffs mime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outimg-"));
    const file = path.join(dir, "a.png");
    await fs.writeFile(file, PNG_BYTES);
    const res = await resolveImageBytes({ kind: "local-file", path: file });
    expect(res.bytes.equals(PNG_BYTES)).toBe(true);
    expect(res.mimeType).toBe("image/png");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects a relative path", async () => {
    await expect(resolveImageBytes({ kind: "local-file", path: "rel/a.png" })).rejects.toThrow(
      /not absolute/,
    );
  });

  it("rejects a missing file", async () => {
    await expect(
      resolveImageBytes({ kind: "local-file", path: "/nonexistent/xyz.png" }),
    ).rejects.toThrow(OutboundImageError);
  });

  it("rejects an oversize file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outimg-"));
    const file = path.join(dir, "big.png");
    await fs.writeFile(file, Buffer.alloc(10));
    await expect(
      resolveImageBytes({ kind: "local-file", path: file }, { maxBytes: 5 }),
    ).rejects.toThrow(/exceeds cap/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("resolveImageBytes: remote-url", () => {
  it("fetches an image and uses response content-type", async () => {
    const response = new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    const res = await resolveImageBytes(
      { kind: "remote-url", url: "https://x.test/c.png" },
      { fetch: fakeFetch(response) },
    );
    expect(res.mimeType).toBe("image/png");
    expect(res.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("rejects a non-image content-type", async () => {
    const response = new Response("<html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(
      resolveImageBytes(
        { kind: "remote-url", url: "https://x.test/p.html" },
        { fetch: fakeFetch(response) },
      ),
    ).rejects.toThrow(/not an image/);
  });

  it("rejects a non-ok response", async () => {
    const response = new Response("", { status: 404 });
    await expect(
      resolveImageBytes(
        { kind: "remote-url", url: "https://x.test/missing.png" },
        { fetch: fakeFetch(response) },
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects when content-length exceeds cap", async () => {
    const response = new Response(PNG_BYTES, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(MAX_OUTBOUND_IMAGE_BYTES + 1),
      },
    });
    await expect(
      resolveImageBytes(
        { kind: "remote-url", url: "https://x.test/big.png" },
        { fetch: fakeFetch(response) },
      ),
    ).rejects.toThrow(/exceeds cap/);
  });

  it("wraps a fetch rejection", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      resolveImageBytes({ kind: "remote-url", url: "https://x.test/c.png" }, { fetch: failing }),
    ).rejects.toThrow(OutboundImageError);
  });
});
