import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSessionStore,
  SessionAlreadyBoundError,
  SessionStoreFormatError,
} from "./file-session-store.js";
import type { SessionRecord } from "./session-store.js";

/**
 * White-box tests for the thread-scoped {@link FileSessionStore}. A topic
 * (Feishu 话题) maps to a distinct `threadId`; `threadId: null` is the chat's
 * "main" (non-topic) conversation. These tests pin the isolation guarantees
 * the bridge relies on for per-thread session routing.
 */

let dir: string;
let store: FileSessionStore;

function record(
  over: Partial<SessionRecord> & Pick<SessionRecord, "chatId" | "sessionId">,
): SessionRecord {
  return {
    threadId: null,
    agentCommand: "node",
    agentArgs: [],
    cwd: "/tmp",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-sess-"));
  store = new FileSessionStore(dir);
  await store.init();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileSessionStore thread scoping", () => {
  it("getLatest isolates threads: each topic resumes its own session", async () => {
    await store.save(
      record({ chatId: "oc_A", threadId: null, sessionId: "s_main", updatedAt: 10 }),
    );
    await store.save(
      record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1", updatedAt: 20 }),
    );
    await store.save(
      record({ chatId: "oc_A", threadId: "th_2", sessionId: "s_t2", updatedAt: 30 }),
    );

    expect(await store.getLatest("oc_A", null)).toMatchObject({ sessionId: "s_main" });
    expect(await store.getLatest("oc_A", "th_1")).toMatchObject({ sessionId: "s_t1" });
    expect(await store.getLatest("oc_A", "th_2")).toMatchObject({ sessionId: "s_t2" });
  });

  it("getLatest returns null for a thread with no sessions (even if the chat has others)", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1" }));
    expect(await store.getLatest("oc_A", null)).toBeNull();
    expect(await store.getLatest("oc_A", "th_missing")).toBeNull();
  });

  it("getLatest picks the most recently updated session within a thread", async () => {
    await store.save(
      record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_old", updatedAt: 100 }),
    );
    await store.save(
      record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_new", updatedAt: 200 }),
    );
    expect(await store.getLatest("oc_A", "th_1")).toMatchObject({ sessionId: "s_new" });
  });

  it("listByThread returns only that thread's sessions; listByChat spans all", async () => {
    await store.save(record({ chatId: "oc_A", threadId: null, sessionId: "s_main" }));
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1" }));
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1b" }));

    const t1 = await store.listByThread("oc_A", "th_1");
    expect(t1.map((r) => r.sessionId).sort()).toEqual(["s_t1", "s_t1b"]);

    const main = await store.listByThread("oc_A", null);
    expect(main.map((r) => r.sessionId)).toEqual(["s_main"]);

    const all = await store.listByChat("oc_A");
    expect(all.length).toBe(3);
  });

  it("persists threadId across a store reopen (same dir)", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1", updatedAt: 5 }));
    await store.close();

    const reopened = new FileSessionStore(dir);
    await reopened.init();
    try {
      expect(await reopened.getLatest("oc_A", "th_1")).toMatchObject({ sessionId: "s_t1" });
      // The main conversation must NOT pick up the topic's session.
      expect(await reopened.getLatest("oc_A", null)).toBeNull();
    } finally {
      await reopened.close();
    }
  });

  it("rejects a pre-topic record persisted without an explicit threadId", async () => {
    // Simulate an on-disk file whose records predate the threadId field.
    await store.close();
    const filePath = path.join(dir, "sessions.json");
    const legacyShaped = {
      oc_A: [
        {
          chatId: "oc_A",
          sessionId: "s_legacy",
          agentCommand: "node",
          agentArgs: [],
          cwd: "/tmp",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(legacyShaped), "utf-8");

    const reopened = new FileSessionStore(dir);
    const initResult = reopened.init();
    await expect(initResult).rejects.toBeInstanceOf(SessionStoreFormatError);
    await expect(initResult).rejects.toThrow(/threadId/);
  });

  it("rejects the pre-multi-session single-record-per-chat shape", async () => {
    await store.close();
    const filePath = path.join(dir, "sessions.json");
    const oldShaped = {
      oc_A: { sessionId: "s_old", cwd: "/tmp", updatedAt: 1 },
    };
    fs.writeFileSync(filePath, JSON.stringify(oldShaped), "utf-8");

    const reopened = new FileSessionStore(dir);
    const initResult = reopened.init();
    await expect(initResult).rejects.toBeInstanceOf(SessionStoreFormatError);
    await expect(initResult).rejects.toThrow(/must be an array/);
  });

  it("round-trips a record with controls and a pending configuration across reopen", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
        controls: { modelId: "gpt-5.5", config: { approval: { value: "ask" } } },
        pendingConfiguration: {
          targetAgent: {
            sessionId: "profile:1",
            profileOnly: true,
            agentCommand: "npx",
            agentArgs: ["-y", "codex"],
            agentLabel: "codex",
            cwd: "/tmp",
          },
          controls: { clearModelId: true },
          message: { prompt: "resume", createdAt: 7 },
          createdAt: 7,
          updatedAt: 7,
        },
      }),
    );
    await store.close();

    const reopened = new FileSessionStore(dir);
    await reopened.init();
    try {
      expect(await reopened.getLatest("oc_A", "th_1")).toMatchObject({
        controls: { modelId: "gpt-5.5", config: { approval: { value: "ask" } } },
        pendingConfiguration: {
          targetAgent: { agentLabel: "codex" },
          controls: { clearModelId: true },
          message: { prompt: "resume", createdAt: 7 },
        },
      });
    } finally {
      await reopened.close();
    }
  });

  it("rejects a record whose pending configuration is missing required timestamps", async () => {
    await store.close();
    const filePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        oc_A: [
          {
            chatId: "oc_A",
            threadId: "th_1",
            sessionId: "s_t1",
            agentCommand: "node",
            agentArgs: [],
            cwd: "/tmp",
            createdAt: 1,
            updatedAt: 1,
            pendingConfiguration: { controls: { modeId: "agent" } },
          },
        ],
      }),
      "utf-8",
    );

    const reopened = new FileSessionStore(dir);
    const initResult = reopened.init();
    await expect(initResult).rejects.toBeInstanceOf(SessionStoreFormatError);
    await expect(initResult).rejects.toThrow(/pendingConfiguration/);
  });

  it("rejects a record whose controls carry a non-string modelId", async () => {
    await store.close();
    const filePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        oc_A: [
          {
            chatId: "oc_A",
            threadId: null,
            sessionId: "s_main",
            agentCommand: "node",
            agentArgs: [],
            cwd: "/tmp",
            createdAt: 1,
            updatedAt: 1,
            controls: { modelId: 42 },
          },
        ],
      }),
      "utf-8",
    );

    const reopened = new FileSessionStore(dir);
    const initResult = reopened.init();
    await expect(initResult).rejects.toBeInstanceOf(SessionStoreFormatError);
    await expect(initResult).rejects.toThrow(/controls/);
  });
});

describe("FileSessionStore session bind", () => {
  it("bindThreadSession replaces the current thread's previous session", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_target", sessionId: "s_previous" }));

    const bound = await store.bindThreadSession(
      record({
        chatId: "oc_A",
        threadId: "th_target",
        sessionId: "s_desktop",
        title: "Desktop task",
        sessionUpdatedAt: "2026-07-05T12:00:00Z",
        agentLabel: "claude",
        updatedAt: 300,
      }),
    );

    expect(bound).toMatchObject({
      threadId: "th_target",
      sessionId: "s_desktop",
      title: "Desktop task",
      sessionUpdatedAt: "2026-07-05T12:00:00Z",
    });
    expect(await store.getLatest("oc_A", "th_target")).toMatchObject({ sessionId: "s_desktop" });
    const all = await store.listByChat("oc_A");
    expect(all.map((r) => r.sessionId)).toEqual(["s_desktop"]);
  });

  it("rejects binding a session that is already bound to another thread", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_old", sessionId: "s_desktop" }));

    await expect(
      store.bindThreadSession(
        record({ chatId: "oc_A", threadId: "th_target", sessionId: "s_desktop" }),
      ),
    ).rejects.toBeInstanceOf(SessionAlreadyBoundError);

    expect(await store.getLatest("oc_A", "th_old")).toMatchObject({ sessionId: "s_desktop" });
    expect(await store.getLatest("oc_A", "th_target")).toBeNull();
  });

  it("allows rebinding the same session to the same thread to refresh metadata", async () => {
    await store.save(
      record({ chatId: "oc_A", threadId: "th_target", sessionId: "s_desktop", title: "Old" }),
    );

    await expect(
      store.bindThreadSession(
        record({ chatId: "oc_A", threadId: "th_target", sessionId: "s_desktop", title: "New" }),
      ),
    ).resolves.toMatchObject({ title: "New" });

    expect(await store.getLatest("oc_A", "th_target")).toMatchObject({ title: "New" });
  });
});

describe("FileSessionStore session controls", () => {
  it("merges ACP-shaped controls into the latest thread session", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
        controls: {
          modelId: "model-old",
          config: { approval_mode: { value: "ask" } },
        },
      }),
    );

    const updated = await store.setControls(
      { chatId: "oc_A", threadId: "th_1" },
      {
        modeId: "agent",
        config: {
          approval_mode: { value: "auto" },
          auto_edit: { type: "boolean", value: true },
        },
        bridgePermissionMode: "alwaysAsk",
      },
    );

    expect(updated).toMatchObject({
      sessionId: "s_t1",
      controls: {
        modelId: "model-old",
        modeId: "agent",
        bridgePermissionMode: "alwaysAsk",
        config: {
          approval_mode: { value: "auto" },
          auto_edit: { type: "boolean", value: true },
        },
      },
    });
  });

  it("replaces the pending configuration for the latest thread session", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
        controls: { modelId: "model-old" },
        pendingConfiguration: {
          controls: { config: { approval_mode: { value: "ask" } } },
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );

    const queued = await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "th_1" },
      {
        controls: {
          modeId: "agent",
          config: {
            approval_mode: { value: "auto" },
            auto_edit: { type: "boolean", value: true },
          },
        },
        createdAt: 1,
        updatedAt: 2,
      },
    );
    expect(queued).toMatchObject({
      controls: { modelId: "model-old" },
      pendingConfiguration: {
        controls: {
          modeId: "agent",
          config: {
            approval_mode: { value: "auto" },
            auto_edit: { type: "boolean", value: true },
          },
        },
      },
    });

    const queuedConfiguration = queued.pendingConfiguration;
    expect(queuedConfiguration).toBeDefined();
    const cleared = await store.clearPendingConfigurationIfMatches(
      { chatId: "oc_A", threadId: "th_1" },
      queuedConfiguration!,
    );
    expect(cleared.cleared).toBe(true);
    expect(cleared.record.pendingConfiguration).toBeUndefined();
    expect(await store.getLatest("oc_A", "th_1")).toMatchObject({
      controls: { modelId: "model-old" },
      pendingConfiguration: undefined,
    });
  });

  it("clearPendingConfigurationIfMatches is a no-op when nothing is pending", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1" }));

    const cleared = await store.clearPendingConfigurationIfMatches(
      { chatId: "oc_A", threadId: "th_1" },
      { createdAt: 1, updatedAt: 1 },
    );
    expect(cleared.cleared).toBe(false);
    expect(cleared.record.sessionId).toBe("s_t1");
  });

  it("clearPendingConfigurationIfMatches preserves a newer pending configuration instead of clobbering it", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_t1" }));

    const stale = await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "th_1" },
      { controls: { modeId: "agent" }, createdAt: 1, updatedAt: 1 },
    );
    const staleConfiguration = stale.pendingConfiguration!;

    // Simulate a later `configure`/`send` request replacing the Pending
    // Configuration while an earlier application (holding only the stale
    // snapshot) is still in flight.
    const fresher = await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "th_1" },
      { controls: { modeId: "ask" }, createdAt: 1, updatedAt: 2 },
    );

    const cleared = await store.clearPendingConfigurationIfMatches(
      { chatId: "oc_A", threadId: "th_1" },
      staleConfiguration,
    );
    expect(cleared.cleared).toBe(false);
    expect(cleared.record.pendingConfiguration).toMatchObject(fresher.pendingConfiguration!);
    expect(await store.getLatest("oc_A", "th_1")).toMatchObject({
      pendingConfiguration: { controls: { modeId: "ask" } },
    });
  });

  it("stores an atomic target Agent + controls + message pending configuration", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
      }),
    );

    const queued = await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "th_1" },
      {
        targetAgent: {
          sessionId: "profile:1",
          profileOnly: true,
          agentCommand: "npx",
          agentArgs: ["-y", "@github/copilot", "--acp"],
          agentLabel: "copilot",
          cwd: "/tmp",
        },
        controls: { modelId: "gpt-5.5" },
        message: { prompt: "continue with target", createdAt: 123 },
        createdAt: 123,
        updatedAt: 123,
      },
    );

    expect(queued).toMatchObject({
      pendingConfiguration: {
        targetAgent: { agentLabel: "copilot" },
        controls: { modelId: "gpt-5.5" },
        message: { prompt: "continue with target", createdAt: 123 },
      },
    });
  });

  it("throws when setControls targets a missing session", async () => {
    await expect(
      store.setControls({ chatId: "oc_missing", threadId: null }, { modeId: "agent" }),
    ).rejects.toThrow(/no session found/);
  });

  it("clears an explicit model override without persisting a clear marker", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
        controls: { modelId: "model-old", modeId: "agent" },
      }),
    );

    const updated = await store.setControls(
      { chatId: "oc_A", threadId: "th_1" },
      { clearModelId: true },
    );

    expect(updated.controls).toEqual({ modeId: "agent" });
    expect(updated.controls).not.toHaveProperty("clearModelId");
  });

  it("stores model clearing in a pending configuration patch", async () => {
    await store.save(
      record({
        chatId: "oc_A",
        threadId: "th_1",
        sessionId: "s_t1",
        controls: { modelId: "model-old" },
      }),
    );

    const updated = await store.setPendingConfiguration(
      { chatId: "oc_A", threadId: "th_1" },
      { controls: { clearModelId: true }, createdAt: 1, updatedAt: 1 },
    );

    expect(updated.pendingConfiguration?.controls).toEqual({ clearModelId: true });
  });

  it("clears only one thread and removes profile-only records when the real session is saved", async () => {
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "profile:1" }));
    await store.save(record({ chatId: "oc_A", threadId: "th_2", sessionId: "s_other" }));

    await store.clearThread("oc_A", "th_1");
    expect(await store.getLatest("oc_A", "th_1")).toBeNull();
    expect(await store.getLatest("oc_A", "th_2")).toMatchObject({ sessionId: "s_other" });

    await store.save({
      ...record({ chatId: "oc_A", threadId: "th_1", sessionId: "profile:2" }),
      profileOnly: true,
    });
    await store.save(record({ chatId: "oc_A", threadId: "th_1", sessionId: "s_real" }));
    expect(await store.listByThread("oc_A", "th_1")).toHaveLength(1);
    expect(await store.getLatest("oc_A", "th_1")).toMatchObject({ sessionId: "s_real" });
  });
});
