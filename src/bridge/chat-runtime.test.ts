import { describe, it, expect } from "vitest";
import { ChatRuntime } from "./chat-runtime.js";
import type { ChatRuntimeOptions } from "./chat-runtime.js";
import { createPinoLogger } from "../logger/logger.js";

/**
 * Minimal options to construct a ChatRuntime without spawning anything.
 * These tests only exercise the pre-bootstrap getters (`processing` /
 * `lastActivity`) that the bridge's idle-eviction reads, so the presenter /
 * session store are never touched.
 */
function opts(): ChatRuntimeOptions {
  const logger = createPinoLogger();
  // The presenter/sessionStore are unused by the getters under test; a cast
  // keeps the test focused (CLAUDE.md §4 — documented, narrow test cast).
  return {
    chatId: "oc_test",
    threadId: null,
    agentCommand: "node",
    agentArgs: [],
    agentCwd: "/tmp",
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    permissionMode: "alwaysAllow",
    presenter: {} as ChatRuntimeOptions["presenter"],
    sessionStore: {} as ChatRuntimeOptions["sessionStore"],
    logger,
  };
}

describe("ChatRuntime idle-eviction getters (regression: evicted mid-spawn)", () => {
  it("reports lastActivity as construction time, not the epoch, before bootstrap", () => {
    const before = Date.now();
    const runtime = new ChatRuntime(opts());
    const after = Date.now();

    // The bug: `state?.lastActivity ?? 0` returned 0 for a fresh runtime, so
    // `now - 0` always exceeded the idle timeout and evicted it mid-spawn.
    expect(runtime.lastActivity).toBeGreaterThanOrEqual(before);
    expect(runtime.lastActivity).toBeLessThanOrEqual(after);
    expect(runtime.lastActivity).not.toBe(0);
  });

  it("a fresh runtime is NOT idle under a normal timeout", () => {
    const runtime = new ChatRuntime(opts());
    const idleTimeoutMs = 24 * 60 * 60_000; // bridge default (24h)
    const isIdle = Date.now() - runtime.lastActivity > idleTimeoutMs;
    expect(isIdle).toBe(false);
  });

  it("processing is false before any message (no spawn in flight yet)", () => {
    const runtime = new ChatRuntime(opts());
    expect(runtime.processing).toBe(false);
  });
});
