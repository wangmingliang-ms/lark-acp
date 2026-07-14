# Humming command guide

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print credentials, tokens, connection strings, or full chat/thread/session IDs.
Omit `--chat-id` and `--thread-id` for the current topic.

## Commands by task

- List Agents: `humming agent list`
- Inspect current session: `humming session capabilities --json`
- Inspect another Agent: `humming agent capabilities --agent <agent> --json`
- List resumable sessions: `humming session list --agent <agent> --json`
- Change current Model/Mode/Config: first `humming session capabilities --json`, then one
  `humming session configure ...`
- Switch Agent: first `humming agent capabilities --agent <target-agent> --json`, then one
  `humming session configure --agent <target-agent> ...`
- Change only Humming Permission:
  `humming session configure --permission <alwaysAsk|alwaysAllow|alwaysDeny>`
- Change profile and send a task: one
  `humming session configure ... --message-file <absolute-path>`
- Send a task without profile changes: `humming session send --message-file <absolute-path>`
- Bind an existing Agent session: first `humming session list --agent <agent> --json`, then
  `humming session bind --agent <agent> --session-id <id>`
- Bind/rebind chat repository: update only `bindings.<chatId>.cwd` in `{{SETTINGS_PATH}}`
- Show Bridge status: `humming status`
- Show Bridge logs: `humming logs`
- Restart Bridge: `humming restart`

## Profile commands

```bash
humming session configure --model <model-id|auto>
humming session configure --mode <mode-id>
humming session configure --config <config-id>=<value>
humming session configure --permission <alwaysAsk|alwaysAllow|alwaysDeny>
humming session configure --agent <agent>
```

Use only Model/Mode/Config IDs returned by the required capabilities command. Run that command once
per unchanged target Agent in the current request and reuse its result. If it fails or the requested
value is absent, stop without running `session configure`.

When Agent/Profile changes and a task are requested together, combine everything into one command:

```bash
humming session configure \
  --agent <agent> \
  --model <model-id> \
  --mode <mode-id> \
  --permission <alwaysAsk|alwaysAllow|alwaysDeny> \
  --config <config-id>=<value> \
  --message-file <absolute-path>
```

Do not use `--cwd` with `session configure` unless the user explicitly requests another repository.
Do not write Agent/Model/Mode/Permission/Config into `bindings`.
Do not edit `sessions.json`; use `humming session ...`.

## Built-in chat commands

Do not reinterpret:

```text
/help
/commands
/capabilities [agent]
/agent [agent]
/model [model-id|auto]
/mode [mode-id]
/permission [alwaysAsk|alwaysAllow|alwaysDeny]
/profile
/bind <path>
/where
/unbind
/new
/cancel
```
