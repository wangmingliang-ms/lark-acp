import { describe, expect, it } from "vitest";
import {
  splitUtf8,
  truncateUtf8,
  utf8ByteLength,
  utf8PartsByteLength,
  utf8PrefixEnd,
} from "./card-text-budget.js";

describe("card text byte budget", () => {
  it("measures all card text with UTF-8 bytes", () => {
    expect(utf8ByteLength("abc界")).toBe(6);
    expect(utf8PartsByteLength(["abc", "界"])).toBe(6);
  });

  it("finds prefixes without splitting emoji surrogate pairs", () => {
    const text = "a😀b";
    const end = utf8PrefixEnd(text, 5);
    expect(text.slice(0, end)).toBe("a😀");
    expect(utf8ByteLength(text.slice(0, end))).toBe(5);
  });

  it("truncates multibyte text including its suffix inside the byte budget", () => {
    const suffix = "…已截断";
    const result = truncateUtf8("界".repeat(20), 30, suffix);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(30);
    expect(result).toContain(suffix);
  });

  it("splits multibyte text into chunks within the same byte budget", () => {
    const chunks = splitUtf8("第一段\n\n第二段\n\n第三段", 18);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 18)).toBe(true);
    expect(chunks.join("")).toBe("第一段\n\n第二段\n\n第三段");
  });
});
