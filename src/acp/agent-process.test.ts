import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import type { AgentProcess, SpawnAgentOptions } from "./agent-process.js";
import {
  AgentAuthError,
  buildAgentSpawnOptions,
  restartAgentAfterResumeFailure,
  sanitizeChildEnv,
} from "./agent-process.js";

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

describe("sanitizeChildEnv", () => {
  it("strips CLAUDECODE so a nested claude session guard does not trip", () => {
    const result = sanitizeChildEnv({ CLAUDECODE: "1", PATH: "/usr/bin" });
    expect(result).not.toHaveProperty("CLAUDECODE");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("strips the whole CLAUDE_CODE_* family", () => {
    const result = sanitizeChildEnv({
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_SSE_PORT: "1234",
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("preserves unrelated CLAUDE_* vars such as credentials/config", () => {
    const result = sanitizeChildEnv({
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDECODE: "1",
    });
    expect(result.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude");
    expect(result.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(result).not.toHaveProperty("CLAUDECODE");
  });

  it("lets an explicit override re-add a stripped var (caller intent wins)", () => {
    const result = sanitizeChildEnv({ CLAUDECODE: "1" }, { CLAUDECODE: "keep" });
    expect(result.CLAUDECODE).toBe("keep");
  });

  it("applies overrides on top of the base env", () => {
    const result = sanitizeChildEnv({ PATH: "/usr/bin" }, { EXTRA: "x" });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.EXTRA).toBe("x");
  });

  it("does not mutate the inputs", () => {
    const base = { CLAUDECODE: "1", PATH: "/usr/bin" };
    const overrides = { EXTRA: "x" };
    sanitizeChildEnv(base, overrides);
    expect(base).toEqual({ CLAUDECODE: "1", PATH: "/usr/bin" });
    expect(overrides).toEqual({ EXTRA: "x" });
  });
});

describe("buildAgentSpawnOptions", () => {
  it("uses a hidden shell on Windows so agent startup does not open a cmd window", () => {
    const opts = buildAgentSpawnOptions({
      cwd: "C:\\repo",
      env: { EXTRA: "1" },
      baseEnv: { PATH: "C:\\Windows", CLAUDECODE: "1" },
      platform: "win32",
    });

    expect(opts.shell).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.env.PATH).toBe("C:\\Windows");
    expect(opts.env.EXTRA).toBe("1");
    expect(opts.env).not.toHaveProperty("CLAUDECODE");
  });
});

describe("restartAgentAfterResumeFailure", () => {
  it("starts a fresh agent process instead of reusing a resume-rejected connection", async () => {
    const staleProcess = {
      kill: vi.fn(),
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess;
    const freshAgent = { sessionId: "fresh-session" } as unknown as AgentProcess;
    const spawnFresh = vi.fn<(opts: SpawnAgentOptions) => Promise<AgentProcess>>();
    spawnFresh.mockResolvedValue(freshAgent);
    const opts = { command: "npx", args: ["-y", "@github/copilot", "--acp"] } as SpawnAgentOptions;

    const result = await restartAgentAfterResumeFailure(opts, staleProcess, spawnFresh);

    expect(staleProcess.kill).toHaveBeenCalledOnce();
    expect(spawnFresh).toHaveBeenCalledOnce();
    expect(spawnFresh).toHaveBeenCalledWith(opts);
    expect(result).toEqual({ agent: freshAgent, resumed: false });
  });
});
