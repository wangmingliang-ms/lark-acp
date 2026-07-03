import { describe, it, expect } from "vitest";
import { AgentAuthError } from "./agent-process.js";

describe("AgentAuthError", () => {
  it("builds an actionable message carrying label + hint", () => {
    const err = new AgentAuthError("npx", "请先认证 Codex：设置 OPENAI_API_KEY。");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentAuthError");
    expect(err.agentLabel).toBe("npx");
    expect(err.message).toContain("未认证");
    expect(err.message).toContain("OPENAI_API_KEY");
  });

  it("preserves the underlying cause when provided", () => {
    const cause = { code: -32000, message: "Authentication required" };
    const err = new AgentAuthError("codex", "hint", cause);
    expect(err.cause).toBe(cause);
  });
});
