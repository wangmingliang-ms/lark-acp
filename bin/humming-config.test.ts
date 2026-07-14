import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readConfigFile,
  resolveConfig,
  resolveHomeDir,
  resolveSettingsPath,
  DEFAULT_AGENT,
  DEFAULT_PERMISSION_MODE,
  ENV_APP_ID,
  ENV_APP_SECRET,
} from "./cli/config/load.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[ENV_APP_ID];
  delete process.env[ENV_APP_SECRET];
});

describe("resolveHomeDir / resolveSettingsPath", () => {
  it("defaults to ~/.humming when nothing is set", () => {
    expect(resolveHomeDir(undefined)).toBe(path.join(os.homedir(), ".humming"));
  });

  it("honors an explicit --home override", () => {
    expect(resolveHomeDir(path.join(dir, "custom"))).toBe(path.resolve(dir, "custom"));
  });

  it("resolves settings.json under the home dir by default", () => {
    expect(resolveSettingsPath(undefined, dir)).toBe(path.join(dir, "settings.json"));
  });

  it("honors an explicit --settings-path override", () => {
    const configPath = path.join(dir, "custom.json");
    expect(resolveSettingsPath(configPath, dir)).toBe(path.resolve(configPath));
  });
});

describe("readConfigFile", () => {
  it("returns an empty config when the file is absent", () => {
    const cfg = readConfigFile(path.join(dir, "settings.json"));
    expect(cfg.credentials).toEqual({});
    expect(cfg.runtime).toEqual({});
    expect(cfg.agents).toEqual({});
    expect(cfg.bindings).toEqual({});
  });

  it("round-trips runtime.agent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: "codex" } }));
    expect(readConfigFile(p).runtime.agent).toBe("codex");
  });

  it("leaves runtime.agent undefined when absent", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: {} }));
    expect(readConfigFile(p).runtime.agent).toBeUndefined();
  });

  it("rejects a non-string runtime.agent via Zod", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { agent: 42 } }));
    expect(() => readConfigFile(p)).toThrowError(/runtime.agent/);
  });

  it("reads lifecycle notification chat ids", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", "oc_B"] } }));
    expect(readConfigFile(p).runtime.lifecycleNotifyChatIds).toEqual(["oc_A", "oc_B"]);
  });

  it("rejects non-string lifecycle notification chat ids", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ runtime: { lifecycleNotifyChatIds: ["oc_A", 7] } }));
    expect(() => readConfigFile(p)).toThrowError(/runtime.lifecycleNotifyChatIds/);
  });

  it("rejects malformed JSON", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, "{ not json");
    expect(() => readConfigFile(p)).toThrowError(/not valid JSON/);
  });

  it("round-trips bindings and custom agent presets", () => {
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        bindings: { oc_chat: { cwd: "/repo" } },
        agents: { custom: { label: "Custom", command: "node", args: ["agent.js"] } },
      }),
    );
    const cfg = readConfigFile(p);
    expect(cfg.bindings["oc_chat"]).toEqual({ cwd: "/repo" });
    expect(cfg.agents["custom"]).toMatchObject({ label: "Custom", command: "node" });
  });
});

describe("resolveConfig", () => {
  it("throws a friendly error when credentials are missing", () => {
    const configPath = path.join(dir, "settings.json");
    expect(() => resolveConfig({}, configPath, dir, readConfigFile(configPath))).toThrowError(
      /credentials missing/,
    );
  });

  it("prefers env credentials over the file", () => {
    process.env[ENV_APP_ID] = "cli_env";
    process.env[ENV_APP_SECRET] = "secret_env";
    const configPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ credentials: { appId: "cli_file", appSecret: "secret_file" } }),
    );
    const cfg = resolveConfig({}, configPath, dir, readConfigFile(configPath));
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.credentialsSource).toContain("env:");
  });

  it("defaults the permission mode to alwaysAsk", () => {
    const configPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ credentials: { appId: "cli_x", appSecret: "s" } }),
    );
    const cfg = resolveConfig({}, configPath, dir, readConfigFile(configPath));
    expect(cfg.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("CLI flags override the file for runtime knobs", () => {
    const configPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        credentials: { appId: "cli_x", appSecret: "s" },
        runtime: { maxChats: 3 },
      }),
    );
    const cfg = resolveConfig({ maxChats: 9 }, configPath, dir, readConfigFile(configPath));
    expect(cfg.maxChats).toBe(9);
  });
});

describe("DEFAULT_AGENT", () => {
  it("is claude", () => {
    expect(DEFAULT_AGENT).toBe("claude");
  });
});
