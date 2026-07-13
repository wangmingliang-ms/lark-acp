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
});
