import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHomeTemplates } from "./home-templates.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-home-templates-"));
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
    expect(agents).toContain("## Commands by task");
    expect(agents).toContain("## Decision rules");
    expect(agents).toContain("### Choose the capability source");
    expect(agents).toContain("### Combine profile changes and tasks");
    expect(agents).toContain("### Bind sessions and repositories");
    expect(agents).toContain("### Choose Permission, Mode, or Config");
    expect(agents).toContain("### Handle scope and failures");
    expect(agents).toContain("Bind/rebind chat repository");
    expect(agents).toContain("Do not write Agent/Model/Mode/Permission/Config into `bindings`");
    expect(agents).toContain("/agent [agent]");
    expect(agents).toContain("/model [model-id|auto]");
    expect(agents).toContain("/capabilities [agent]");
    expect(agents).toContain("humming session configure --model <model-id|auto>");
    expect(agents).toContain("humming session configure --agent <agent>");
    expect(agents).toContain("Change current Model/Mode/Config");
    expect(agents).toContain("humming session capabilities --json");
    expect(agents).toContain("Switch Agent");
    expect(agents).toContain("humming agent capabilities --agent <target-agent> --json");
    expect(agents).toContain("Query once per unchanged target Agent");
    expect(agents).not.toContain("sessions set-control");
    expect(agents).not.toContain("sessions queue-task");
    expect(agents).not.toContain("set-pending-target-profile");
    expect(agents).not.toContain("humming control ");

    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(sessionsPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "settings.back.json"), "utf-8")),
    ).toMatchObject({
      credentials: { appId: "cli_xxxxxxxxxxxxxxxx" },
      runtime: { agent: "claude" },
      bindings: { oc_example_chat_id: { cwd: "/absolute/path/to/repo" } },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "settings.back.json"), "utf-8")),
    ).not.toMatchObject({ bindings: { oc_example_chat_id: { agent: "claude" } } });
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
    expect(fs.readFileSync(agentsPath, "utf-8")).toContain("Humming operating guide");
  });
});
