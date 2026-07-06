import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSessionStore, SessionAlreadyBoundError } from "./file-session-store.js";
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

  it("backfills threadId:null for records written before topic support", async () => {
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
    await reopened.init();
    try {
      // A pre-topic record resumes as the chat's main (null) conversation.
      const latest = await reopened.getLatest("oc_A", null);
      expect(latest).toMatchObject({ sessionId: "s_legacy", threadId: null });
    } finally {
      await reopened.close();
    }
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

  it("throws when setControls targets a missing session", async () => {
    await expect(
      store.setControls({ chatId: "oc_missing", threadId: null }, { modeId: "agent" }),
    ).rejects.toThrow(/no session found/);
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
