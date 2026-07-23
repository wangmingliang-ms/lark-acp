import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import {
  extractMarkdownImages,
  splitMarkdownIntoSegments,
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

describe("splitMarkdownIntoSegments", () => {
  it("returns nothing for empty input", () => {
    expect(splitMarkdownIntoSegments("")).toEqual([]);
  });

  it("returns a single text segment when there are no images", () => {
    expect(splitMarkdownIntoSegments("just prose")).toEqual([{ kind: "text", text: "just prose" }]);
  });

  it("interleaves text and images in document order", () => {
    const segments = splitMarkdownIntoSegments(
      "one ![a](https://x.test/a.png) two ![b](https://x.test/b.png) three",
    );
    expect(segments).toEqual([
      { kind: "text", text: "one " },
      { kind: "image", source: { kind: "remote-url", url: "https://x.test/a.png", alt: "a" } },
      { kind: "text", text: " two " },
      { kind: "image", source: { kind: "remote-url", url: "https://x.test/b.png", alt: "b" } },
      { kind: "text", text: " three" },
    ]);
  });

  it("keeps an image at the start with only trailing text", () => {
    const segments = splitMarkdownIntoSegments("![a](https://x.test/a.png) after");
    expect(segments.map((s) => s.kind)).toEqual(["image", "text"]);
    expect(segments[1]).toEqual({ kind: "text", text: " after" });
  });

  it("resolves file:// images to local-file segments", () => {
    const url = pathToFileURL("/tmp/shot.png").href;
    const segments = splitMarkdownIntoSegments(`see ![](${url}) done`);
    expect(segments[1]).toEqual({
      kind: "image",
      source: { kind: "local-file", path: "/tmp/shot.png" },
    });
  });

  it("does not treat ![] inside a fenced code block as an image", () => {
    const text = "text\n\n```\n![notanimage](x.png)\n```\n\nmore";
    const segments = splitMarkdownIntoSegments(text);
    expect(segments.every((s) => s.kind === "text")).toBe(true);
  });

  it("splits an image embedded mid-paragraph", () => {
    const segments = splitMarkdownIntoSegments("before ![x](https://x.test/c.png) after");
    expect(segments).toEqual([
      { kind: "text", text: "before " },
      { kind: "image", source: { kind: "remote-url", url: "https://x.test/c.png", alt: "x" } },
      { kind: "text", text: " after" },
    ]);
  });

  it("does not mislocate a real image when an inline code span holds the same raw", () => {
    // The code span `![](https://x.test/c.png)` is not an image; the later real
    // image with identical raw must be located at ITS position, and the code
    // span must stay intact in the text.
    const text = "use `![](https://x.test/c.png)` then ![](https://x.test/c.png) end";
    const segments = splitMarkdownIntoSegments(text);
    expect(segments).toEqual([
      { kind: "text", text: "use `![](https://x.test/c.png)` then " },
      { kind: "image", source: { kind: "remote-url", url: "https://x.test/c.png" } },
      { kind: "text", text: " end" },
    ]);
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
