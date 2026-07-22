import { describe, it, expect } from "vitest";
import { resolveAgentFlag } from "./runtime.js";

describe("resolveAgentFlag", () => {
  it("returns runtime.agent when present", () => {
    expect(resolveAgentFlag({ runtime: { agent: "claude" } })).toBe("claude");
  });

  it("returns null when runtime.agent is absent", () => {
    expect(resolveAgentFlag({ runtime: {} })).toBe(null);
  });
});
