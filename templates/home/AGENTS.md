# lark-acp operating guide

This file is installed by lark-acp so agents have durable operating instructions even before the bridge has handled its first message.

When a user asks to change lark-acp settings, bind a chat to a repository, or change the current session's model/mode/config/permission controls, read this guide first and follow it exactly.

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print or copy secrets. Treat App IDs, chat IDs, session IDs, tokens, API keys, and connection strings as sensitive.

## Settings / bindings

Use `settings.json` for global config, credentials, runtime defaults, agent presets, and chat bindings. Preserve unrelated keys.

To bind or rebind a chat, update the top-level `bindings` object:

```json
{
  "bindings": {
    "<chatId>": {
      "cwd": "/absolute/path/to/repo",
      "agent": "claude"
    }
  }
}
```

Valid built-in agent names normally include `claude`, `codex`, `copilot`, `gemini`, `opencode`, and `claude-agent`; confirm with `lark-acp agents` when unsure.

## Session controls

Session-specific controls live in `sessions.json` and should normally be changed through the lark-acp CLI, not by hand-editing JSON.

Before changing model/mode/config/permission controls, always query live capabilities for the current chat/thread. Do not guess ids or values from memory.

```bash
lark-acp control capabilities --chat-id "$LARK_ACP_CHAT_ID" --thread-id "$LARK_ACP_THREAD_ID" --json
```

The response keeps ACP-native fields as-is where possible:

- `models`: ACP `SessionModelState`, with `currentModelId` and `availableModels`
- `modes`: ACP `SessionModeState`, with `currentModeId` and `availableModes`
- `configOptions`: ACP `SessionConfigOption[]`
- `bridgePermissionModes` / `bridgePermissionMode`: lark-acp client-side policy, not ACP-native

Only choose ids/values that appear in the live response. If the requested target does not exist, tell the user and do not write controls.

Set controls with one JSON payload:

```bash
lark-acp sessions set-control --chat-id "$LARK_ACP_CHAT_ID" --thread-id "$LARK_ACP_THREAD_ID" --json '{
  "modelId": "<one models.availableModels[].modelId>",
  "modeId": "<one modes.availableModes[].id>",
  "config": {
    "<boolean config id>": { "type": "boolean", "value": true },
    "<select config id>": { "value": "<one select option value>" }
  },
  "bridgePermissionMode": "alwaysAsk"
}'
```

All fields are optional; include only the controls the user asked to change. ACP select config requests use `{ "value": "<valueId>" }` with no `type` field.

If set-control fails, lark-acp should surface a clear error notice to the user and keep the live runtime plus `sessions.json` unchanged. Ask the agent to query capabilities again and retry with valid ids/values.

## Permission terminology

ACP has per-tool `requestPermission` approvals, but no standard global permission mode. If an agent exposes Plan/Edit/Bypass as modes, set `modeId`. If it exposes approval/bypass as a config option, set `config`. Only use `bridgePermissionMode` for lark-acp's own approval-card policy.
