import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBindingStore } from "./file-binding-store.js";
import type { ChatBinding } from "./binding-store.js";

let dir: string;
const openStores: FileBindingStore[] = [];

/** Track a store so afterEach can flush + close it before the temp dir is removed. */
function newStore(): FileBindingStore {
  const store = new FileBindingStore(dir);
  openStores.push(store);
  return store;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-binding-"));
  openStores.length = 0;
});

afterEach(async () => {
  await Promise.all(openStores.map((s) => s.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function binding(chatId: string, over: Partial<ChatBinding> = {}): ChatBinding {
  const now = 1_700_000_000_000;
  return {
    chatId,
    cwd: "/work/proj",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("FileBindingStore", () => {
  it("round-trips a binding through get()", async () => {
    const store = newStore();
    await store.init();
    const b = binding("oc_a");
    await store.set(b);
    expect(await store.get("oc_a")).toEqual(b);
  });

  it("returns null for an unknown chat", async () => {
    const store = newStore();
    await store.init();
    expect(await store.get("oc_missing")).toBeNull();
  });

  it("persists across a fresh store instance (disk reload)", async () => {
    const first = newStore();
    await first.init();
    await first.set(binding("oc_a", { cwd: "/repo/a" }));
    await first.set(binding("oc_b", { cwd: "/repo/b" }));
    await first.close(); // flush to disk

    const second = newStore();
    await second.init();
    expect(await second.get("oc_a")).toMatchObject({ cwd: "/repo/a" });
    expect(await second.get("oc_b")).toMatchObject({ cwd: "/repo/b" });
    expect((await second.list()).length).toBe(2);
  });

  it("does not run a deferred flush after close already flushed synchronously", async () => {
    const store = newStore();
    await store.init();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await store.set(binding("oc_a", { cwd: "/repo/a" }));
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(stderrWrite).not.toHaveBeenCalledWith(
        expect.stringContaining("binding store flush failed"),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("overwrites on re-set (rebind)", async () => {
    const store = newStore();
    await store.init();
    await store.set(binding("oc_a", { cwd: "/repo/old" }));
    await store.set(binding("oc_a", { cwd: "/repo/new" }));
    expect(await store.get("oc_a")).toMatchObject({ cwd: "/repo/new" });
    expect((await store.list()).length).toBe(1);
  });

  it("delete() removes a binding and is a no-op when absent", async () => {
    const store = newStore();
    await store.init();
    await store.set(binding("oc_a"));
    await store.delete("oc_a");
    expect(await store.get("oc_a")).toBeNull();
    await store.delete("oc_a"); // no throw
    await store.delete("oc_never"); // no throw
  });

  it("tolerates a corrupt file by starting empty", async () => {
    fs.writeFileSync(path.join(dir, "bindings.json"), "{ this is not json", "utf-8");
    const store = newStore();
    await store.init(); // must not throw
    expect(await store.list()).toEqual([]);
  });

  it("skips structurally-invalid entries but keeps valid ones", async () => {
    const onDisk = {
      oc_good: binding("oc_good"),
      oc_bad: { chatId: "oc_bad" }, // missing cwd
    };
    fs.writeFileSync(path.join(dir, "bindings.json"), JSON.stringify(onDisk), "utf-8");
    const store = newStore();
    await store.init();
    expect(await store.get("oc_good")).toMatchObject({ cwd: "/work/proj" });
    expect(await store.get("oc_bad")).toBeNull();
  });

  it("ignores legacy agent fields when loading old bindings", async () => {
    const onDisk = {
      oc_old: {
        ...binding("oc_old"),
        agentLabel: "codex",
        agentCommand: "npx",
        agentArgs: ["-y", "codex-acp"],
      },
    };
    fs.writeFileSync(path.join(dir, "bindings.json"), JSON.stringify(onDisk), "utf-8");
    const store = newStore();
    await store.init();
    const got = await store.get("oc_old");
    expect(got).toMatchObject({ cwd: "/work/proj" });
    expect(got).not.toHaveProperty("agentLabel");
  });
});
