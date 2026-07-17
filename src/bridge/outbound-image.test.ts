import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import {
  extractMarkdownImages,
  outboundImagePlaceholder,
  type OutboundImageSource,
} from "./outbound-image.js";

describe("extractMarkdownImages", () => {
  it("returns no sources for plain text", () => {
    const { sources, cleaned } = extractMarkdownImages("just some text");
    expect(sources).toEqual([]);
    expect(cleaned).toBe("just some text");
  });

  it("returns no sources for empty text", () => {
    expect(extractMarkdownImages("")).toEqual({ sources: [], cleaned: "" });
  });

  it("classifies an http(s) image as remote-url with alt", () => {
    const { sources, cleaned } = extractMarkdownImages("look ![a cat](https://x.test/c.png) here");
    expect(sources).toEqual([{ kind: "remote-url", url: "https://x.test/c.png", alt: "a cat" }]);
    expect(cleaned).toBe("look  here");
  });

  it("classifies a file:// image as local-file", () => {
    const fileUrl = pathToFileURL("/tmp/shot.png").href;
    const { sources } = extractMarkdownImages(`![](${fileUrl})`);
    expect(sources).toEqual([{ kind: "local-file", path: "/tmp/shot.png" }]);
  });

  it("classifies a bare absolute path as local-file", () => {
    const { sources } = extractMarkdownImages("![diagram](/var/img/d.jpg)");
    expect(sources).toEqual([{ kind: "local-file", path: "/var/img/d.jpg", alt: "diagram" }]);
  });

  it("extracts multiple images in order", () => {
    const { sources } = extractMarkdownImages(
      "![](https://a.test/1.png) mid ![](https://b.test/2.png)",
    );
    expect(sources.map((s) => (s.kind === "remote-url" ? s.url : ""))).toEqual([
      "https://a.test/1.png",
      "https://b.test/2.png",
    ]);
  });

  it("skips data: URIs", () => {
    const { sources, cleaned } = extractMarkdownImages("![](data:image/png;base64,AAA)");
    expect(sources).toEqual([]);
    // No source extracted → text left untouched.
    expect(cleaned).toBe("![](data:image/png;base64,AAA)");
  });

  it("strips the image markdown and tidies blank lines", () => {
    const { cleaned } = extractMarkdownImages("before\n\n![](https://x.test/c.png)\n\nafter");
    expect(cleaned).toBe("before\n\nafter");
  });

  it("ignores malformed markdown with no image", () => {
    const { sources } = extractMarkdownImages("![oops](");
    expect(sources).toEqual([]);
  });
});

describe("outboundImagePlaceholder", () => {
  const cases: ReadonlyArray<readonly [OutboundImageSource, string]> = [
    [{ kind: "acp-image", base64: "AAAA", mimeType: "image/png" }, "[图片发送失败]"],
    [{ kind: "local-file", path: "/secret/host/path.png" }, "[图片发送失败]"],
    [{ kind: "remote-url", url: "https://x.test/c.png" }, "[图片下载失败: https://x.test/c.png]"],
  ];

  it.each(cases)("renders %o", (source, expected) => {
    expect(outboundImagePlaceholder(source)).toBe(expected);
  });

  it("never leaks a local path", () => {
    const msg = outboundImagePlaceholder({ kind: "local-file", path: "/home/user/secret.png" });
    expect(msg).not.toContain("/home/user/secret.png");
  });
});
