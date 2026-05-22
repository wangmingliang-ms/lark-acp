/**
 * Built-in ACP agent presets and lookup helpers.
 *
 * Pure data; no IO. The library itself never reads these — they exist
 * for callers (CLIs, embedding apps) that want a curated list of known
 * agents to expose in their UI.
 */

export interface AgentPreset {
  label: string;
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  copilot: {
    label: "GitHub Copilot",
    command: "npx",
    args: ["-y", "@github/copilot", "--acp"],
    description: "GitHub Copilot CLI (native --acp)",
  },
  claude: {
    label: "Claude Code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    description: "Claude Code via Zed's ACP adapter (uses local `claude` CLI auth)",
  },
  "claude-agent": {
    label: "Claude Agent SDK",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    description: "Direct Anthropic API via the Claude Agent SDK (needs ANTHROPIC_API_KEY)",
  },
  codex: {
    label: "Codex CLI",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    description: "OpenAI Codex via Zed's ACP adapter",
  },
  gemini: {
    label: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--experimental-acp"],
    description: "Google Gemini CLI (experimental --acp)",
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    description: "OpenCode (assumes `opencode` is on $PATH)",
  },
};

export interface ResolvedAgent {
  id?: string;
  label?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: "preset" | "raw";
}

/**
 * Split a raw `"command arg1 arg2"` string into its parts.
 *
 * @throws when the input has no command token after trimming.
 */
export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (!parts[0]) throw new Error("Agent command cannot be empty");
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Resolve a user-provided agent selection against the preset registry.
 * Falls back to parsing the input as a raw command string.
 *
 * @throws when the selection is not a preset and parsing it as a raw
 *         command yields no command token.
 */
export function resolveAgent(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): ResolvedAgent {
  const preset = registry[agentSelection];
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: "preset",
    };
  }
  const parsed = parseAgentCommand(agentSelection);
  return { command: parsed.command, args: parsed.args, source: "raw" };
}
