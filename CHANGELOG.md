# Changelog

## 0.2.0

### Features

- Agent-specific authentication hints — auth failures now show actionable remediation (e.g., `Run "claude" in a terminal and complete the login flow first`) in both the console and the Feishu reply.
- CLI argument validation — `--agent`, `--cwd`, `--idle-timeout`, and `--max-sessions` validate values upfront with descriptive error messages.
- `--cwd` validation — verifies the directory exists before starting.
- `lark-acp help` subcommand — works alongside `--help`.
- Expanded help text with usage examples and clearer option descriptions.

### Bug Fixes

- Agent crashes and authentication errors are now distinguished in Feishu replies (previously both shown as generic "Agent error").
- Agent spawn errors (init, auth, session creation) are caught individually with clear messages instead of unhandled exceptions.
- Unknown CLI flags now print a helpful hint to run `--help` instead of silently failing.

## 0.1.0

### Features

- Bridge Feishu/Lark messages to any ACP-compatible agent via WebSocket long connection.
- Built-in presets: `copilot`, `claude`, `codex`, `gemini`, `opencode`.
- Interactive first-run setup via `lark-cli` browser OAuth.
- Per-user sessions with idle timeout and eviction.
- Auto-forwarding of agent thoughts, tool calls, and diffs.
- Auto-allow permission requests from agents.
- Markdown reply formatting for Feishu rich text.
