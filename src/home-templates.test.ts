import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHomeTemplates } from "./home-templates.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-home-templates-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("installHomeTemplates", () => {
  it("installs home guide files and example JSON without creating live settings/sessions", () => {
    const settingsPath = path.join(dir, "settings.json");
    const sessionsPath = path.join(dir, "sessions.json");

    installHomeTemplates({
      homeDir: dir,
      settingsPath,
      sessionsPath,
      controlSocketPath: path.join(dir, "control.sock"),
    });

    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
    expect(claude).toBe(agents);
    expect(agents).toContain(settingsPath);
    expect(agents).toContain(sessionsPath);
    expect(agents).toContain(path.join(dir, "control.sock"));
    expect(agents).toContain("before/after details");
    expect(agents).toContain("lark-acp commands");

    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(sessionsPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "settings.back.json"), "utf-8")),
    ).toMatchObject({
      credentials: { appId: "cli_xxxxxxxxxxxxxxxx" },
      runtime: { agent: "claude" },
      bindings: { oc_example_chat_id: { agent: "claude" } },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "sessions.back.json"), "utf-8")),
    ).toMatchObject({
      oc_example_chat_id: [
        {
          controls: {
            modelId: "example-model-id",
            modeId: "example-mode-id",
            bridgePermissionMode: "alwaysAsk",
          },
        },
      ],
    });
  });

  it("does not overwrite user-edited docs unless requested", () => {
    const agentsPath = path.join(dir, "AGENTS.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(agentsPath, "custom", "utf-8");

    installHomeTemplates({
      homeDir: dir,
      settingsPath: path.join(dir, "settings.json"),
      sessionsPath: path.join(dir, "sessions.json"),
      controlSocketPath: null,
    });
    expect(fs.readFileSync(agentsPath, "utf-8")).toBe("custom");

    installHomeTemplates({
      homeDir: dir,
      settingsPath: path.join(dir, "settings.json"),
      sessionsPath: path.join(dir, "sessions.json"),
      controlSocketPath: null,
      overwriteDocs: true,
    });
    expect(fs.readFileSync(agentsPath, "utf-8")).toContain("lark-acp operating guide");
  });
});
