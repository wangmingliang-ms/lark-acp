# Humming operating guide

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

## Decision rules

### Choose the capability source

- Current Agent Model/Mode/Config change: use `humming session capabilities --json`.
- Agent switch or controls for another Agent: use
  `humming agent capabilities --agent <target-agent> --json`.
- A target Agent was already selected earlier in the same request: reuse that target Agent's
  capabilities.
- A pending Agent switch is known and the user changes controls: query that target Agent and include
  `--agent <target-agent>` again in the combined `session configure` command.
- Permission-only change: do not query Agent capabilities.

Use only returned Model/Mode/Config IDs. Query once per unchanged target Agent in one request. If
the query fails or the requested value is absent, stop and tell the user what value is unavailable.

### Combine profile changes and tasks

- Multiple Agent/Model/Mode/Permission/Config changes in one request: use one `session configure`.
- Profile change plus a task: put the task on the same `session configure` with `--message`,
  `--message-file`, or `--message-stdin`.
- Task without profile changes: use `session send`.
- Do not run `session configure` and then `session send` for one profile-change-and-task request.

### Bind sessions and repositories

- Bind/rebind a repository: change only `bindings.<chatId>.cwd` in `settings.json`.
- Bind an existing Agent session: list with `session list`, choose a session in the current chat
  repository, then use `session bind`.
- Multiple sessions match: show short candidates and ask the user to choose.
- Session already belongs to another topic: ask the user to reset the original topic; do not edit
  `sessions.json`.
- Do not pass `--cwd` to `session bind`.

### Choose Permission, Mode, or Config

- Humming approval-card policy: use `--permission`.
- Agent Plan/Edit/Bypass behavior exposed as a mode: use `--mode`.
- Agent approval/bypass behavior exposed as config: use `--config`.

### Handle scope and failures

- Group/topic profile changes: use `session configure`; do not edit global defaults.
- Configured DM global-control chat: use `session configure`; Humming updates global defaults.
- Capability lookup or configure failure: report the exact failed field/value and stop.
- Do not guess another Model/Mode/Config value or retry with a different Agent unless requested.

## Profile commands

```bash
humming session configure --model <model-id|auto>
humming session configure --mode <mode-id>
humming session configure --config <config-id>=<value>
humming session configure --permission <alwaysAsk|alwaysAllow|alwaysDeny>
humming session configure --agent <agent>
```

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
