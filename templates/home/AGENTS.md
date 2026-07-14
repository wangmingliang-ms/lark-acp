# humming operating guide

Use this guide when the user asks to configure Humming, bind/rebind a repo, bind this topic to an existing agent session, switch Agent, or change the current session configuration.

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print secrets, full chat IDs, full thread IDs, full session IDs, tokens, API keys, or connection strings in group chats.

## Settings contents

`settings.json` stores machine/global configuration:

- `credentials`: Feishu/Lark bot app credentials. Do not print them.
- `runtime.agent`: global default Agent for new chats/topics with no inherited session configuration.
- `runtime.defaultControls`: global default Model / Mode / Permission / Config for new chats/topics with no inherited session configuration.
- `runtime.permissionMode`: global Humming approval-card policy.
- `runtime.lifecycleNotifyChatIds`: chats that receive bridge lifecycle notifications.
- `runtime.globalControlChatIds`: DM control chats whose Agent/Model/Mode/Permission/Config changes write global defaults back to `settings.json`.
- `runtime.cwd` / `runtime.unboundCwd`: default/reception working directories.
- `agents`: built-in preset overrides and custom Agent presets.
- `bindings`: per-chat repo bindings only: `{ "cwd": "/absolute/path/to/repo" }`.

Do not store per-topic session state in `settings.json`; that belongs in `sessions.json`.

## Built-in commands handled by Humming

If the user sends one of these slash commands, do not reinterpret it; Humming handles it before the Agent sees it:

```text
/help
/commands
/capabilities
/capabilities <agent>
/agent
/agent <agent>
/model
/model <model-id|auto>
/mode
/mode <mode-id>
/permission
/permission <alwaysAsk|alwaysAllow|alwaysDeny>
/profile
/bind <path>
/where
/unbind
/new
/cancel
```

`/model auto` means clear the explicit model override.

## General Humming CLI rules

- The CLI's command tree is `humming bridge|agent|session|setup|init|update`. Bridge operations also have top-level shortcuts: `humming run|start|stop|restart|status|logs`; they use the same handlers as `humming bridge ...`. All business values are named options (`-a/--agent`, `-m/--model`, `--mode`, `-p/--permission`, `-c/--config`, `-C/--cwd`, `--chat-id`, `--thread-id`, `--session-id`, `--json`). There are no positional Agent values and no old `sessions`/`control`/`proxy` subcommands.
- Humming injects `HUMMING_CHAT_ID` and `HUMMING_THREAD_ID` into Agent subprocesses. Omit `--chat-id` / `--thread-id` unless intentionally targeting a different chat/topic.
- `humming agent ...` probes an arbitrary Agent (short-lived, no session side effects). `humming session ...` reads/changes the current Topic Session. Never substitute one for the other.
- Use Humming CLI commands for Agent/session state. Do not inspect Claude/Codex/Gemini/OpenCode cache directories or guess from project files.
- Chat binding is repo-only. Do not put Agent/Model/Mode/Permission/Config into `bindings`.
- Direct-message global-control chats update global defaults; group/topic changes are session-scoped.

Useful commands:

```bash
humming agent list
humming session capabilities --json
humming agent capabilities --agent <agent> --json
humming session list --agent <agent> --json
```

## Repo binding

When the user asks to bind/rebind a chat to a repo, preserve unrelated `settings.json` keys and write only:

```json
{
  "bindings": {
    "<chatId>": { "cwd": "/absolute/path/to/repo" }
  }
}
```

After editing settings, let Humming send the normal repo-bound notice.

## Session configuration: Agent / Model / Mode / Permission / Config

Before changing session configuration, query the live Session capabilities:

```bash
humming session capabilities --json
```

Use only IDs/values returned by capabilities. If the requested value is unavailable, tell the user and do not configure it.

Before switching, probe the target Agent first — `session configure --agent` also probes it for early UX feedback, but always check capabilities yourself so you know which Model/Mode/Config ids are valid:

```bash
humming agent capabilities --agent <agent> --json
```

If the probe fails, stop. Do not switch Agent or change the configuration.

`session configure` accepts any combination of Agent/Model/Mode/Permission/Config, plus an optional Message that is sent only after that configuration is fully applied:

```bash
humming session configure --model <model-id>
humming session configure --model auto
humming session configure --mode <mode-id>
humming session configure --permission alwaysAsk
humming session configure --config <select-config-id>=<value-id>
humming session configure --config <boolean-config-id>=true
```

Combine flags when changing multiple configuration values in one request:

```bash
humming session configure --model <model-id> --mode <mode-id> --permission alwaysAsk
```

`configure` requires at least one configuration field (`--agent`/`--model`/`--mode`/`--permission`/`--config`). A Message with no configuration field is rejected — use `session send` when the configuration is unchanged.

## Agent switching and atomic configuration-change-and-message requests

For a pure Agent switch with no Message and no other configuration changes:

```bash
humming session configure --agent <agent>
```

For a single user request that changes the session configuration and also carries a task to run afterward, attach the Message to the same `configure` call:

```bash
humming session configure --agent <agent> \
  --model <model-id> \
  --mode <mode-id> \
  --permission alwaysAsk \
  --message-file /absolute/path/to/task.md
```

Short message form:

```bash
humming session configure --agent <agent> --model gpt-5.5 --message "task text"
```

Rules:

- Model/Mode/Config values are always validated against the Agent named by `--agent` in the same request (or the Agent in the pending configuration change/current session when `--agent` is omitted) — never against a different Agent.
- Do not split one such request into separate Agent-switch and control-change calls unless a single `configure` call cannot express it.
- Do not add `--cwd` to `session configure` unless the user is deliberately pointing the new Agent at a different repo.
- Do not edit `runtime.agent` or `bindings` to switch the current topic's Agent.
- Do not explain Humming internals to the user; run the command and continue the task.

## Sending a message without changing session configuration

```bash
humming session send --message "Fix the failing test"
humming session send --message-file /absolute/path/to/task.md
humming session send --message-stdin < /absolute/path/to/task.md
```

Use `session send` only when no Agent/Model/Mode/Permission/Config change is needed. If a configuration change and a message both apply, use `session configure` with a message so it is sent only after the change succeeds.

## Binding this topic to an existing agent session

List sessions for the current chat repo:

```bash
humming session list --agent claude --json
```

List sessions for an explicitly requested repo only for inspection:

```bash
humming session list --agent codex --cwd /absolute/path/to/repo --json
```

Bind the current topic to a selected session in the current chat repo:

```bash
humming session bind --agent claude --session-id "<selected-session-id>"
```

Rules:

- Do not hand-edit `sessions.json`.
- Do not pass `--cwd` to `session bind`.
- If the session is already bound elsewhere, ask the user to reset the original thread first.
- If multiple sessions match, show short candidates and ask the user to choose.

## Permission behavior

- If the Agent exposes Plan/Edit/Bypass as modes, set `--mode`.
- If the Agent exposes approval/bypass as config, set `--config`.
- Use `--permission` only for Humming's own approval-card policy, not an Agent-native control.
