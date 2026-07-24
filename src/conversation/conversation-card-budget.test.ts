import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "../presenter/card-text-budget.js";
import { conversationCardBudget } from "./conversation-card-budget.js";

describe("conversationCardBudget", () => {
  it("is the single source for conversation Card limits", () => {
    expect(conversationCardBudget).toMatchObject({
      preferredSplitStartBytes: 8_192,
      maxContentBytes: 20_000,
      maxElements: 40,
    });
  });

  it("prefers the last sentence boundary between 8 KB and 20 KB", () => {
    const text = `${"a".repeat(9_000)}。${"b".repeat(5_000)}\n${"c".repeat(7_000)}`;
    const [prefix, remainder] = conversationCardBudget.splitText(text, 0);
    expect(prefix).toBe(`${"a".repeat(9_000)}。${"b".repeat(5_000)}\n`);
    expect(prefix + remainder).toBe(text);
  });

  it("forces a UTF-8-safe split at 20 KB without a preferred boundary", () => {
    const text = "界".repeat(7_000);
    const [prefix, remainder] = conversationCardBudget.splitText(text, 0);
    expect(utf8ByteLength(prefix)).toBeLessThanOrEqual(conversationCardBudget.maxContentBytes);
    expect(utf8ByteLength(prefix + "界")).toBeGreaterThan(conversationCardBudget.maxContentBytes);
    expect(prefix + remainder).toBe(text);
  });

  describe("foldImagesToFit", () => {
    const chrome = { showCancelButton: true, profile: null };

    it("keeps everything when the card already fits", () => {
      const entries = [
        { kind: "text" as const, text: "hi" },
        { kind: "image" as const, imageId: "a", status: "uploading" as const },
      ];
      const { entries: out, droppedImageIds } = conversationCardBudget.foldImagesToFit(
        entries,
        chrome,
      );
      expect(out).toBe(entries);
      expect(droppedImageIds).toEqual([]);
    });

    it("folds overflow images into a [图片] marker and stays within budget", () => {
      const imgCount = conversationCardBudget.maxElements + 10;
      const entries = [
        { kind: "text" as const, text: "gallery" },
        ...Array.from({ length: imgCount }, (_, i) => ({
          kind: "image" as const,
          imageId: `img-${String(i)}`,
          status: "uploading" as const,
        })),
      ];
      const { entries: out, droppedImageIds } = conversationCardBudget.foldImagesToFit(
        entries,
        chrome,
      );
      expect(conversationCardBudget.fits(out, chrome)).toBe(true);
      expect(droppedImageIds.length).toBeGreaterThan(0);
      expect(out.filter((e) => e.kind === "image").length).toBe(imgCount - droppedImageIds.length);
      expect(out.some((e) => e.kind === "text" && e.text.includes("[图片]"))).toBe(true);
    });
  });
});
