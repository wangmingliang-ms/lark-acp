import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSessionStore } from "./file-session-store.js";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-sess-"));
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
