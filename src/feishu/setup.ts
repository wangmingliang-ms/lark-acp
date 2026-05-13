/**
 * Interactive first-run setup.
 *
 * Priority order:
 *  1. ~/.lark-channel/config.json  (written by `lark-cli config bind --source lark-channel`)
 *  2. ~/.feishu-acp/config.json    (our own saved config)
 *  3. lark-cli guided flow         (installs lark-cli if needed, then browser OAuth)
 *  4. Manual App ID / App Secret   (fallback)
 */

import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveConfig, loadSavedConfig } from "../config.js";

// ~/.lark-channel/config.json schema (matches lark-cli's lark-channel-bridge format)
interface LarkChannelConfig {
  accounts: { app: { id: string; secret: string; tenant?: string } };
}

function larkChannelConfigPath(): string {
  return path.join(os.homedir(), ".lark-channel", "config.json");
}

function readLarkChannelConfig(): { appId: string; appSecret: string } | null {
  try {
    const raw = fs.readFileSync(larkChannelConfigPath(), "utf-8");
    const cfg = JSON.parse(raw) as LarkChannelConfig;
    const { id, secret } = cfg.accounts?.app ?? {};
    if (id && secret) return { appId: id, appSecret: secret };
  } catch {
    // not present or malformed
  }
  return null;
}

function isLarkCliAvailable(): boolean {
  try {
    execSync("lark-cli --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function runLarkCliSetup(log: (msg: string) => void): Promise<boolean> {
  log("Running: lark-cli config init --new");
  log("A browser window will open — follow the prompts to create your Feishu app.\n");

  // Step 1: config init --new (interactive, pass through stdio)
  const initOk = await new Promise<boolean>((resolve) => {
    const proc = spawn("lark-cli", ["config", "init", "--new"], { stdio: "inherit" });
    proc.on("close", (code) => resolve(code === 0));
  });
  if (!initOk) return false;

  log("\nRunning: lark-cli config bind --source lark-channel");
  log("This writes your App ID and Secret to ~/.lark-channel/config.json\n");

  // Step 2: config bind --source lark-channel (writes our config file)
  const bindOk = await new Promise<boolean>((resolve) => {
    const proc = spawn("lark-cli", ["config", "bind", "--source", "lark-channel"], {
      stdio: "inherit",
    });
    proc.on("close", (code) => resolve(code === 0));
  });
  return bindOk;
}

async function runNpxLarkCliSetup(log: (msg: string) => void): Promise<boolean> {
  log("lark-cli not found — installing temporarily via npx...\n");

  const initOk = await new Promise<boolean>((resolve) => {
    const proc = spawn("npx", ["@larksuite/cli", "config", "init", "--new"], {
      stdio: "inherit",
      shell: true,
    });
    proc.on("close", (code) => resolve(code === 0));
  });
  if (!initOk) return false;

  const bindOk = await new Promise<boolean>((resolve) => {
    const proc = spawn("npx", ["@larksuite/cli", "config", "bind", "--source", "lark-channel"], {
      stdio: "inherit",
      shell: true,
    });
    proc.on("close", (code) => resolve(code === 0));
  });
  return bindOk;
}

export async function runSetup(
  storageDir: string,
  log: (msg: string) => void = console.log,
): Promise<{ appId: string; appSecret: string }> {
  // 1. Check ~/.lark-channel/config.json first (lark-cli native format)
  const larkChannel = readLarkChannelConfig();
  if (larkChannel) {
    log(`✓ Found existing config in ~/.lark-channel/config.json (App ID: ${larkChannel.appId})`);
    saveConfig(storageDir, { feishu: larkChannel });
    return larkChannel;
  }

  // 2. Check our own saved config
  const saved = loadSavedConfig(storageDir);
  if (saved?.feishu?.appId && saved?.feishu?.appSecret) {
    log(`✓ Found existing config in ~/.feishu-acp/config.json (App ID: ${saved.feishu.appId})`);
    return { appId: saved.feishu.appId, appSecret: saved.feishu.appSecret };
  }

  console.log(`
┌─────────────────────────────────────────┐
│         feishu-acp first-time setup     │
└─────────────────────────────────────────┘
`);

  // 3. Try lark-cli automated flow
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const useLarkCli = await prompt(
      rl,
      "Use lark-cli to auto-create a Feishu app? (recommended) [Y/n]: ",
    );

    if (useLarkCli.toLowerCase() !== "n") {
      const success = isLarkCliAvailable()
        ? await runLarkCliSetup(log)
        : await runNpxLarkCliSetup(log);

      if (success) {
        const creds = readLarkChannelConfig();
        if (creds) {
          log(`\n✓ Setup complete! App ID: ${creds.appId}`);
          saveConfig(storageDir, { feishu: creds });
          return creds;
        }
        log("⚠ lark-cli setup completed but config not found — falling back to manual entry.");
      } else {
        log("⚠ lark-cli setup failed — falling back to manual entry.");
      }
    }

    // 4. Manual fallback
    console.log(`
Manual setup:
  1. Go to https://open.feishu.cn/app → Create self-built app
  2. Add Bot capability
  3. Add permissions: im:message, im:message:send_as_bot
  4. Subscribe event: im.message.receive_v1  (use long connection)
  5. Publish the app
`);
    const appId = await prompt(rl, "App ID: ");
    const appSecret = await prompt(rl, "App Secret: ");

    if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

    saveConfig(storageDir, { feishu: { appId, appSecret } });
    log(`\n✓ Config saved to ${storageDir}/config.json`);
    return { appId, appSecret };
  } finally {
    rl.close();
  }
}
