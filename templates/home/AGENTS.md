# humming operating guide

This file is installed by humming so agents have durable operating instructions even before the bridge has handled its first message.

When a user asks to change humming settings, bind a chat to a repository, bind the current topic to an existing agent session, switch the current topic's Agent, or change the current session's model/mode/config/permission controls, read this guide first and follow it exactly.

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print or copy secrets. Treat App IDs, chat IDs, session IDs, tokens, API keys, and connection strings as sensitive. Use `humming setup` to create/save Feishu credentials; it masks App ID in output and never prints App Secret.

## Settings / bindings

Use `settings.json` for global config, credentials, runtime defaults, agent presets, and chat bindings. Preserve unrelated keys. After a repo bind/rebind succeeds, humming sends a notice card into the chat with the before/after details.

To bind or rebind a chat, update the top-level `bindings` object:

```json
{
  "bindings": {
    "<chatId>": {
      "cwd": "/absolute/path/to/repo"
    }
  }
}
```

Chat bindings are repo-only. Do not write an agent into `bindings`: Agent / Model / Mode / Permission / Config controls belong to the topic/session profile. New topics inherit the most recent profile from the same chat + repo; if the repo has no prior session, humming uses the global default Agent from `runtime.agent`.

## Session controls

Session-specific controls live in `sessions.json` and should normally be changed through the humming CLI, not by hand-editing JSON.

When the user asks to list/show an agent's "settings", "session settings", available models/modes/config, or existing sessions, use humming commands. Do **not** inspect Claude/Codex/Gemini/OpenCode cache directories or search random project folders for agent state.

Humming injects the current target into every agent subprocess as `HUMMING_CHAT_ID` and `HUMMING_THREAD_ID`. The CLI falls back to those env vars, so commands run from inside a Humming agent should usually omit `--chat-id` / `--thread-id`. This is shell-neutral and works on Windows PowerShell/cmd as well as bash. Only pass explicit ids when you intentionally target a different chat/topic.

- Built-in/user agent presets: `humming agents`
- Current live session settings/capabilities: `humming control capabilities --json`
- Capabilities for a specific Agent without changing this topic: `humming control agent-capabilities --agent <agent> --json`
- Existing ACP sessions for an agent: `humming sessions list --agent <agent> --json`

Before changing model/mode/config/permission controls, always query live capabilities for the current chat/thread. Do not guess ids or values from memory.

```bash
humming control capabilities --json
```

The response keeps ACP-native fields as-is where possible:

- `models`: ACP `SessionModelState`, with `currentModelId` and `availableModels`
- `modes`: ACP `SessionModeState`, with `currentModeId` and `availableModes`
- `configOptions`: ACP `SessionConfigOption[]`
- `bridgePermissionModes` / `bridgePermissionMode`: humming client-side policy, not ACP-native

Only choose ids/values that appear in the live response. If the requested target does not exist, tell the user and do not write controls.

If the user asks about another Agent's model/mode/config options before switching to it, use a probe session. This starts the selected Agent briefly, creates a throwaway ACP session to read its real capabilities, then stops it. It does not change the current topic session.

```bash
humming control agent-capabilities --agent copilot --json
```

If the probe fails and a chat id is available, humming sends a `目标 Agent 不可用` notification to the user. Treat that as a hard blocker: do not switch Agent or write controls until the target Agent is installed/authenticated and the probe succeeds.

Set controls with one JSON payload. Prefer `--json-file` or `--json-stdin` on Windows to avoid PowerShell 5.1 / npm shim quote rewriting:

```bash
humming sessions set-control --json-file /absolute/path/to/controls.json
# or
humming sessions set-control --json-stdin < /absolute/path/to/controls.json
```

Inline JSON is also supported when the shell preserves quotes correctly:

```bash
humming sessions set-control --json '{
  "modelId": "<one models.availableModels[].modelId>",
  "modeId": "<one modes.availableModes[].id>",
  "config": {
    "<boolean config id>": { "type": "boolean", "value": true },
    "<select config id>": { "value": "<one select option value>" }
  },
  "bridgePermissionMode": "alwaysAllow"
}'
```

All fields are optional; include only the controls the user asked to change. ACP select config requests use `{ "value": "<valueId>" }` with no `type` field.

If set-control fails, humming should surface a clear error notice to the user and keep the live runtime plus `sessions.json` unchanged. Ask the agent to query capabilities again and retry with valid ids/values.

If set-control succeeds while the current topic is idle, humming sends a `Session profile 已更新` notice that includes the current Agent, Mode, Model, Permission, and Config controls. If the runtime is not currently running, the notice is sent to the chat and the next message will start/resume with the stored profile.

If set-control is requested while the current topic has an in-flight prompt, Humming saves the requested change as one-shot `pendingControls`. The current prompt continues with the old profile. Before the next prompt is sent to the ACP agent, Humming consumes `pendingControls`, applies them, merges them into `controls`, and removes `pendingControls`. If applying fails, Humming still removes `pendingControls`, sends an error notice, and continues the new prompt with the old profile.

## Switching the current topic's Agent

Switching Agent is a topic/session profile change, not a `settings.json` edit. Do **not** change `runtime.agent` or write an agent into `bindings` to switch the current topic; those only affect cold starts / repo binding, not an already-bound topic session.

Use the CLI:

```bash
humming sessions set-agent --agent copilot
```

Semantics:

- Humming stops the current topic runtime if it is running.
- Humming drops the old topic session binding and writes a profile-only record for the new Agent.
- Humming copies Model / Mode / Permission / Config controls from the most recent session in the current chat that used the target Agent. This is metadata-only inheritance; it does not copy history or sessionId.
- The next message in this topic starts a fresh ACP session with the new Agent.
- Old Agent conversation history is not migrated automatically.
- Humming probes the target Agent before switching. If the target Agent cannot start or cannot create a session, the switch is aborted and the old topic session stays active.
- Claude/Codex/Copilot/etc. model, mode, and config ids are Agent-specific. Do not carry old controls across the switch. Humming only inherits controls from the target Agent's own recent sessions; if the user asks for specific controls, query the new Agent's capabilities and then call `sessions set-control` with ids from the new response.

On success humming sends an `Agent 已切换` notice showing Agent / Repo / Mode / Model / Permission / Controls changes. It intentionally does not print full session/chat/thread ids.

## Binding the current topic to an existing agent session

When the user asks to continue a desktop Claude Code / Codex / other ACP session from the current Feishu topic, do **not** hand-edit `sessions.json`. Use the humming CLI.

Rules:

- `sessions list` may use `--cwd` when the user explicitly asks to inspect another repo from a host/reception chat.
- `sessions bind` intentionally does **not** accept `--cwd`. It can only bind the current topic to a session in the current chat's bound repo. It never changes chat binding and never binds a topic across repos.
- If the chosen session is already bound to another chat/thread, humming rejects the bind and sends a conflict notice. Do not work around this by hand-editing `sessions.json`; ask the user to reset the original thread first.
- Do not print full session IDs in a group chat. It is OK to use the full ID in local CLI commands.
- If multiple sessions match the user's description, show a short candidate list with title / updated time / repo and ask the user to choose.

List sessions for the current chat repo:

```bash
humming sessions list --agent claude --json
```

List sessions for an explicitly requested repo (query only, not bind):

```bash
humming sessions list --agent codex --cwd /absolute/path/to/repo --json
```

Bind the current topic to the selected session in the current chat repo:

```bash
humming sessions bind --agent claude --session-id "<selected-session-id>"
```

On success humming sends a notice card naming the bound session title and showing the change details, including Agent / Mode / Model / Permission / Config controls where known. The next user message in this topic resumes that session.

## Permission terminology

ACP has per-tool `requestPermission` approvals, but no standard global permission mode. If an agent exposes Plan/Edit/Bypass as modes, set `modeId`. If it exposes approval/bypass as a config option, set `config`. Only use `bridgePermissionMode` for humming's own approval-card policy.
