#!/usr/bin/env node
/**
 * lark-acp CLI entry point.
 *
 * Usage:
 *   lark-acp --agent copilot
 *   lark-acp --agent claude --cwd /path/to/project
 *   lark-acp --agent "opencode acp"
 *   lark-acp setup                 Re-run first-time setup
 *   lark-acp agents                List built-in agent presets
 */

import path from "node:path";
import fs from "node:fs";
import { select } from "@inquirer/prompts";
import { FeishuAcpBridge } from "../src/bridge.js";
import { FeishuClient } from "../src/feishu/client.js";
import {
  defaultConfig,
  loadSavedConfig,
  loadLarkChannelConfig,
  resolveAgent,
  BUILT_IN_AGENTS,
} from "../src/config.js";
import { runSetup } from "../src/feishu/setup.js";

const VERSION = "0.2.0";

function usage(): void {
  const presets = Object.keys(BUILT_IN_AGENTS).join(", ");
  console.log(`
lark-acp v${VERSION} — Bridge Feishu/Lark to any ACP-compatible AI agent

Usage:
  lark-acp --agent <preset|command>  [options]
  lark-acp setup                     Configure Feishu App ID & Secret
  lark-acp agents                    List built-in agent presets
  lark-acp help                      Show this help

Options:
  --agent <value>      Built-in preset or raw command string
                       Presets: ${presets}
                       Raw:     "npx my-agent --flag", "python agent.py"
  --cwd <dir>          Working directory for the agent subprocess (default: current dir)
  --setup              Re-run the interactive Feishu credentials setup before starting
  --idle-timeout <m>   Evict idle sessions after <m> minutes (default: 1440, 0 = never)
  --max-sessions <n>   Max concurrent user sessions (default: 10, min: 1)
  --hide-thoughts      Do not forward agent thought chunks to Feishu
  -h, --help           Show this help message and exit
  -v, --version        Show version and exit

Examples:
  lark-acp --agent claude
  lark-acp --agent copilot --cwd /my/project --hide-thoughts
  lark-acp --agent "npx my-custom-agent --acp" --max-sessions 5
  lark-acp setup
  lark-acp agents
`);
}

interface CliArgs {
  command?: string;
  agent?: string;
  cwd?: string;
  runSetup: boolean;
  idleTimeout?: number;
  maxSessions?: number;
  hideThoughts: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { runSetup: false, hideThoughts: false, help: false, version: false };
  const args = argv.slice(2);
  let i = 0;

  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  const requireValue = (flag: string, value: string | undefined): string => {
    if (!value || value.startsWith("-")) {
      console.error(`Error: ${flag} requires a value`);
      process.exit(1);
    }
    return value;
  };

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--agent": {
        result.agent = requireValue("--agent", args[++i]);
        break;
      }
      case "--cwd": {
        result.cwd = requireValue("--cwd", args[++i]);
        break;
      }
      case "--setup":         result.runSetup = true; break;
      case "--idle-timeout": {
        const raw = requireValue("--idle-timeout", args[++i]);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          console.error(`Error: --idle-timeout must be a non-negative integer (minutes), got: ${raw}`);
          process.exit(1);
        }
        result.idleTimeout = n;
        break;
      }
      case "--max-sessions": {
        const raw = requireValue("--max-sessions", args[++i]);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          console.error(`Error: --max-sessions must be a positive integer, got: ${raw}`);
          process.exit(1);
        }
        result.maxSessions = n;
        break;
      }
      case "--hide-thoughts": result.hideThoughts = true; break;
      case "-h": case "--help":    result.help = true; break;
      case "-v": case "--version": result.version = true; break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Error: Unknown option: ${arg}`);
          console.error(`Run "lark-acp --help" for usage.`);
          process.exit(1);
        }
    }
    i++;
  }
  return result;
}

function validateArgs(args: CliArgs): void {
  // --cwd must be an existing directory
  if (args.cwd) {
    try {
      if (!fs.statSync(args.cwd).isDirectory()) {
        console.error(`Error: --cwd "${args.cwd}" is not a directory`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: --cwd "${args.cwd}" does not exist`);
      process.exit(1);
    }
  }
}

function log(msg: string): void {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function printBanner(): void {
  console.log(`
 ██╗      █████╗ ██████╗ ██╗  ██╗      █████╗  ██████╗██████╗ 
 ██║     ██╔══██╗██╔══██╗██║ ██╔╝     ██╔══██╗██╔════╝██╔══██╗
 ██║     ███████║██████╔╝█████╔╝      ███████║██║     ██████╔╝
 ██║     ██╔══██║██╔══██╗██╔═██╗      ██╔══██║██║     ██╔═══╝ 
 ███████╗██║  ██║██║  ██║██║  ██╗     ██║  ██║╚██████╗██║     
 ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝  ╚═╝ ╚═════╝╚═╝     
                                               v${VERSION} 🐦
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || args.command === "help") { usage(); return; }
  if (args.version) { console.log(`lark-acp v${VERSION}`); return; }

  validateArgs(args);

  printBanner();

  const config = defaultConfig();
  const storageDir = config.storage.dir;

  // Subcommands
  if (args.command === "setup" || args.runSetup) {
    const creds = await runSetup(storageDir);
    config.feishu.appId = creds.appId;
    config.feishu.appSecret = creds.appSecret;
    // After setup, prompt for agent if not already specified
    if (!args.agent) {
      const agentAnswer = await select({
        message: "Which agent to connect?",
        choices: Object.entries(BUILT_IN_AGENTS).map(([id, preset]) => ({
          name: preset.label,
          value: id,
        })),
      });
      if (!agentAnswer) { console.log("No agent selected — exiting."); return; }
      args.agent = agentAnswer;
    }
    // fall through to start the bridge below
  } else {
    // Load saved credentials — check lark-channel config first, then our own
    const larkChannel = loadLarkChannelConfig();
    if (larkChannel) {
      config.feishu.appId = larkChannel.appId;
      config.feishu.appSecret = larkChannel.appSecret;
      log(`Using credentials from ~/.lark-channel/config.json`);
    } else {
      const saved = loadSavedConfig(storageDir);
      if (saved?.feishu?.appId && saved?.feishu?.appSecret) {
        config.feishu.appId = saved.feishu.appId;
        config.feishu.appSecret = saved.feishu.appSecret;
      } else {
        // First run — prompt for credentials
        const creds = await runSetup(storageDir);
        config.feishu.appId = creds.appId;
        config.feishu.appSecret = creds.appSecret;
      }
    }
  }

  if (args.command === "agents") {
    console.log("Built-in ACP agent presets:\n");
    for (const [id, preset] of Object.entries(BUILT_IN_AGENTS)) {
      console.log(`  ${id.padEnd(12)} ${preset.label}`);
      console.log(`               ${[preset.command, ...preset.args].join(" ")}`);
    }
    return;
  }

  // Resolve agent
  const agentSelection = args.agent;
  if (!agentSelection) {
    console.error("Error: --agent is required\n");
    usage();
    process.exit(1);
  }

  const resolved = resolveAgent(agentSelection);
  config.agent.command = resolved.command;
  config.agent.args = resolved.args;
  config.agent.preset = resolved.id;
  if (resolved.env) config.agent.env = { ...config.agent.env, ...resolved.env };

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  if (args.maxSessions !== undefined) config.session.maxConcurrentUsers = args.maxSessions;
  if (args.hideThoughts) config.agent.showThoughts = false;

  const bridge = new FeishuAcpBridge(config, log);

  const shutdown = async (): Promise<void> => {
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log(`Starting lark-acp with agent: ${resolved.label ?? agentSelection}`);
  log(`Working directory: ${config.agent.cwd}`);
  bridge.start();
  log("Bridge running. Press Ctrl+C to stop.");

  // Print bot chat link so the user can jump straight into Feishu
  const feishuClient = new FeishuClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  feishuClient.getBotChatLink().then((link) => {
    if (link) {
      console.log(`\n  🐦 Chat with your bot on Feishu:`);
      console.log(`     ${link}\n`);
    }
  }).catch(() => {});
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
