import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enrollSetupLifecycleNotification,
  ensureSetupCredentials,
  formatSetupProgress,
  formatSetupSummary,
  maskCredentialId,
  writeSetupCredentials,
} from "./cli/commands/setup.js";
import { readConfigFile } from "./cli/config/load.js";

describe("setup credential persistence", () => {
  it("writes credentials while preserving runtime, agents, and bindings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        runtime: { agent: "copilot" },
        agents: { custom: { label: "Custom", command: "node", args: ["agent.js"] } },
        bindings: { oc_chat: { cwd: "/repo" } },
      }),
      "utf-8",
    );

    writeSetupCredentials(settings, { appId: "cli_abcdef123456", appSecret: "s3cr3t" });

    const written = JSON.parse(fs.readFileSync(settings, "utf-8")) as Record<string, unknown>;
    expect(written["credentials"]).toEqual({ appId: "cli_abcdef123456", appSecret: "s3cr3t" });
    expect(written["runtime"]).toEqual({ agent: "copilot" });
    expect(written["agents"]).toEqual({
      custom: { label: "Custom", command: "node", args: ["agent.js"] },
    });
    expect(written["bindings"]).toEqual({ oc_chat: { cwd: "/repo" } });

    const mode = fs.statSync(settings).mode & 0o777;
    expect(mode).toBe(0o600);

    const cfg = readConfigFile(settings);
    expect(cfg.credentials).toEqual({ appId: "cli_abcdef123456", appSecret: "s3cr3t" });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-object settings file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "[1,2,3]");
    expect(() => writeSetupCredentials(settings, { appId: "x", appSecret: "y" })).toThrowError(
      /must contain a JSON object/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensureSetupCredentials", () => {
  it("skips registration when credentials already exist and force is false", async () => {
    const existing = readConfigFileFromObject({
      credentials: { appId: "cli_x", appSecret: "s" },
      setup: { domain: "feishu" as const },
    });
    const result = await ensureSetupCredentials(existing, "/unused/settings.json", "feishu", false);
    expect(result.created).toBe(false);
    expect(result.credentials.appId).toBe("cli_x");
  });

  it("re-registers when force is true", async () => {
    const existing = readConfigFileFromObject({
      credentials: { appId: "cli_x", appSecret: "s" },
    });
    const register = async () => ({ appId: "cli_new", appSecret: "s2", domain: "feishu" as const });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-"));
    const settings = path.join(dir, "settings.json");
    const result = await ensureSetupCredentials(existing, settings, "feishu", true, register);
    expect(result.created).toBe(true);
    expect(result.credentials.appId).toBe("cli_new");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws when registration is cancelled", async () => {
    const existing = readConfigFileFromObject({});
    const register = async () => null;
    await expect(
      ensureSetupCredentials(existing, "/unused/settings.json", "feishu", false, register),
    ).rejects.toThrowError(/did not complete/);
  });
});

describe("enrollSetupLifecycleNotification", () => {
  it("skips when no ownerOpenId is known", async () => {
    const result = await enrollSetupLifecycleNotification("/unused/settings.json", {
      appId: "cli_x",
      appSecret: "s",
      domain: "feishu",
    });
    expect(result).toEqual({ enrolled: false, reason: "missing-owner-open-id" });
  });

  it("appends the chat id to lifecycleNotifyChatIds on success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({}), "utf-8");
    const sendNotification = async () => "oc_new_chat";
    const result = await enrollSetupLifecycleNotification(
      settings,
      { appId: "cli_x", appSecret: "s", domain: "feishu", ownerOpenId: "ou_1" },
      sendNotification,
    );
    expect(result).toEqual({ enrolled: true, chatId: "oc_new_chat" });
    const written = JSON.parse(fs.readFileSync(settings, "utf-8")) as {
      runtime: { lifecycleNotifyChatIds: string[] };
    };
    expect(written.runtime.lifecycleNotifyChatIds).toEqual(["oc_new_chat"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports failure without throwing when the send rejects", async () => {
    const sendNotification = async () => {
      throw new Error("network down");
    };
    const result = await enrollSetupLifecycleNotification(
      "/unused/settings.json",
      { appId: "cli_x", appSecret: "s", domain: "feishu", ownerOpenId: "ou_1" },
      sendNotification,
    );
    expect(result).toEqual({ enrolled: false, reason: "failed" });
  });
});

describe("maskCredentialId", () => {
  it("keeps the cli_ prefix and last 4 chars", () => {
    expect(maskCredentialId("cli_abcdefghijklmnop")).toBe("cli_…mnop");
  });

  it("fully masks short ids", () => {
    expect(maskCredentialId("short")).toBe("[saved]");
  });
});

describe("formatSetupSummary", () => {
  it("mentions the new bridge start command", () => {
    const text = formatSetupSummary({
      settingsPath: "/home/.humming/settings.json",
      appId: "cli_abcdefghijklmnop",
      appSecret: "s",
      domain: "feishu",
    });
    expect(text).toContain("humming bridge start");
  });
});

describe("formatSetupProgress", () => {
  it("renders the action-required link banner", () => {
    const text = formatSetupProgress({ kind: "link", url: "https://example.com/setup" });
    expect(text).toContain("https://example.com/setup");
    expect(text).toContain("ACTION REQUIRED");
  });

  it("renders a failure message", () => {
    const text = formatSetupProgress({ kind: "failed", reason: "denied" });
    expect(text).toContain("denied");
  });
});

// Minimal helper matching bin/cli/config/load.ts's FileConfig shape for unit
// tests that don't need to read a real settings.json from disk.
function readConfigFileFromObject(partial: {
  readonly credentials?: { readonly appId?: string; readonly appSecret?: string };
  readonly setup?: { readonly domain?: "feishu" | "lark" };
}): ReturnType<typeof readConfigFile> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-cfg-"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(partial), "utf-8");
  const cfg = readConfigFile(settingsPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return cfg;
}
