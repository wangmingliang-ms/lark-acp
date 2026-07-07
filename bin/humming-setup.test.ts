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
  parseArgs,
  readConfigFile,
  runSetup,
  writeSetupCredentials,
} from "./humming.js";

describe("parseArgs — setup subcommand", () => {
  it("parses bare setup as Feishu/Lark setup", () => {
    const args = parseArgs(["setup"]);

    expect(args.command).toBe("setup");
    expect(args.setupTarget).toBe("feishu");
    expect(args.setupForce).toBeUndefined();
  });

  it("parses explicit setup feishu with --force", () => {
    const args = parseArgs(["--home", "/tmp/h", "setup", "feishu", "--force"]);

    expect(args.command).toBe("setup");
    expect(args.home).toBe("/tmp/h");
    expect(args.setupTarget).toBe("feishu");
    expect(args.setupForce).toBe(true);
  });
});

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

    writeSetupCredentials(settings, {
      appId: "cli_created",
      appSecret: "created-secret",
    });

    const parsed = JSON.parse(fs.readFileSync(settings, "utf-8")) as unknown;
    expect(parsed).toEqual({
      runtime: { agent: "copilot" },
      agents: { custom: { label: "Custom", command: "node", args: ["agent.js"] } },
      bindings: { oc_chat: { cwd: "/repo" } },
      credentials: { appId: "cli_created", appSecret: "created-secret" },
    });
    expect((fs.statSync(settings).mode & 0o777).toString(8)).toBe("600");
  });

  it("skips credential registration when credentials already exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-existing-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        credentials: { appId: "cli_existing", appSecret: "existing-secret" },
        setup: { ownerOpenId: "ou_existing_owner" },
        runtime: { agent: "claude" },
      }),
      "utf-8",
    );

    const result = await ensureSetupCredentials(
      readConfigFile(settings),
      settings,
      "feishu",
      false,
      async () => {
        throw new Error("registration should be skipped");
      },
    );

    expect(result).toEqual({
      credentials: {
        appId: "cli_existing",
        appSecret: "existing-secret",
        domain: "feishu",
        ownerOpenId: "ou_existing_owner",
      },
      created: false,
    });
    expect(readConfigFile(settings).runtime.agent).toBe("claude");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runSetup does not abort when credentials already exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-runsetup-existing-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({ credentials: { appId: "cli_existing", appSecret: "existing-secret" } }),
      "utf-8",
    );

    await expect(runSetup(parseArgs(["--home", dir, "setup"]))).resolves.toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("masks identifiers and never includes the app secret in the success summary", () => {
    const summary = formatSetupSummary({
      settingsPath: "/home/user/.humming/settings.json",
      appId: "cli_abcdef123456",
      appSecret: "super-secret-value",
      domain: "feishu",
      botName: "Humming Bot",
    });

    expect(maskCredentialId("cli_abcdef123456")).toBe("cli_…3456");
    expect(summary).toContain("cli_…3456");
    expect(summary).toContain("Humming Bot");
    expect(summary).not.toContain("super-secret-value");
    expect(summary).not.toContain("cli_abcdef123456");
  });

  it("enrolls the setup owner's P2P chat for lifecycle notifications", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humming-setup-lifecycle-"));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({ runtime: { agent: "claude", lifecycleNotifyChatIds: ["oc_existing"] } }),
      "utf-8",
    );

    const result = await enrollSetupLifecycleNotification(
      settings,
      {
        appId: "cli_created",
        appSecret: "created-secret",
        domain: "feishu",
        ownerOpenId: "ou_owner",
      },
      async (setup) => {
        expect(setup.ownerOpenId).toBe("ou_owner");
        return "oc_owner_p2p";
      },
    );

    const parsed = JSON.parse(fs.readFileSync(settings, "utf-8")) as {
      runtime?: { lifecycleNotifyChatIds?: readonly string[]; agent?: string };
    };
    expect(result).toEqual({ enrolled: true, chatId: "oc_owner_p2p" });
    expect(parsed.runtime?.agent).toBe("claude");
    expect(parsed.runtime?.lifecycleNotifyChatIds).toEqual(["oc_existing", "oc_owner_p2p"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("highlights the Feishu setup link and describes the guided flow", () => {
    const output = formatSetupProgress({
      kind: "link",
      url: "https://open.feishu.cn/page/launcher?user_code=redacted&from=humming&tp=humming",
    });

    expect(output).toContain("ACTION REQUIRED: open this setup link in Feishu / Lark");
    expect(output).toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    expect(output).toContain("log in if prompted");
    expect(output).toContain("choose or create the group");
    expect(output).toContain("search for the bot name");
    expect(output).not.toContain("QR");
    expect(output).not.toContain("Scan");
    expect(output).not.toContain("scan");
  });

  it("waits for setup completion instead of scan approval", () => {
    expect(formatSetupProgress({ kind: "polling" })).toBe("Waiting for setup completion...\n");
  });
});
