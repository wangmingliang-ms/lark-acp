import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsBindingStore } from "./settings-binding-store.js";
import type { ChatBinding } from "./binding-store.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-settings-"));
  settingsPath = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
}

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

describe("SettingsBindingStore", () => {
  it("writes repo-only bindings under the `bindings` key of settings.json", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    await store.set(binding("oc_a", { cwd: "/repo/a" }));

    const root = readJson();
    expect(root["bindings"]).toEqual({ oc_a: { cwd: "/repo/a" } });
  });

  it("preserves other top-level keys (credentials/runtime) on write", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        credentials: { appId: "cli_x", appSecret: "s" },
        runtime: { permissionMode: "alwaysAsk" },
      }),
    );
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    await store.set(binding("oc_a", { cwd: "/repo/a" }));

    const root = readJson();
    expect(root["credentials"]).toEqual({ appId: "cli_x", appSecret: "s" });
    expect(root["runtime"]).toEqual({ permissionMode: "alwaysAsk" });
    expect(root["bindings"]).toEqual({ oc_a: { cwd: "/repo/a" } });
  });

  it("round-trips get() without hydrating any agent fields", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    await store.set(binding("oc_a", { cwd: "/repo/a" }));

    const got = await store.get("oc_a");
    expect(got).toMatchObject({ chatId: "oc_a", cwd: "/repo/a" });
    expect(got).not.toHaveProperty("agentLabel");
    expect(got).not.toHaveProperty("agentCommand");
  });

  it("returns null for an unknown chat", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    expect(await store.get("oc_missing")).toBeNull();
  });

  it("delete() removes just that binding, keeps others + other keys", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ credentials: { appId: "cli_x" } }));
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    await store.set(binding("oc_a"));
    await store.set(binding("oc_b"));
    await store.delete("oc_a");

    expect(await store.get("oc_a")).toBeNull();
    expect(await store.get("oc_b")).not.toBeNull();
    expect(readJson()["credentials"]).toEqual({ appId: "cli_x" });
  });

  it("ignores unknown extra fields (e.g. a stray `agent` key) on a bindings entry", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ bindings: { oc_z: { cwd: "/repo/z", agent: "codex" } } }),
    );
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    const got = await store.get("oc_z");
    expect(got).toMatchObject({ cwd: "/repo/z" });
    expect(got).not.toHaveProperty("agentLabel");
  });

  it("tolerates a corrupt/half-written settings.json as empty", async () => {
    fs.writeFileSync(settingsPath, "{ half written");
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    expect(await store.list()).toEqual([]);
    // a subsequent set() overwrites cleanly
    await store.set(binding("oc_a"));
    expect(await store.get("oc_a")).not.toBeNull();
  });

  it("list() returns all bindings", async () => {
    const store = new SettingsBindingStore(settingsPath);
    await store.init();
    await store.set(binding("oc_a", { cwd: "/a" }));
    await store.set(binding("oc_b", { cwd: "/b" }));
    const all = await store.list();
    expect(all.map((b) => b.chatId).sort()).toEqual(["oc_a", "oc_b"]);
  });
});
