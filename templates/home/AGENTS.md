# Humming operating guide

## Files

- Settings: `{{SETTINGS_PATH}}`
- Sessions: `{{SESSIONS_PATH}}`
- Control socket: `{{CONTROL_SOCKET_PATH}}`
- Settings example: `{{SETTINGS_EXAMPLE_PATH}}`
- Sessions example: `{{SESSIONS_EXAMPLE_PATH}}`

Do not print credentials, tokens, connection strings, or full chat/thread/session IDs.
Omit `--chat-id` and `--thread-id` for the current topic.

## Sending images to the user

You can send real images into the chat — screenshots, generated pictures, images
downloaded from a web page, or any local image file. Just reference the image in
your normal reply; the Humming bridge uploads it to Feishu/Lark and delivers it
as a standalone image message. You do NOT call any Humming command to do this.

Three ways to reference an image (all supported, mix freely with text):

- **Local file** — a screenshot or a file you created/downloaded to disk:
  `![alt](file:///absolute/path/to/image.png)` (or a bare absolute path in the
  markdown link). Use an absolute path. On Windows, `file:///C:/path/to/pic.png`
  or a bare `C:\path\to\pic.png` both work.
- **Remote URL** — an image on a web page you want to forward:
  `![alt](https://example.com/pic.png)`. The bridge downloads and re-uploads it.
- **Generated image** — if your tools/skills emit an image as an ACP `image`
  content block (base64), it is delivered automatically; no markdown needed.

Notes:

- The markdown image is stripped from the text, and the picture is sent as its
  own image message — so write a sentence of context around it.
- Supported formats: PNG, JPEG, GIF, WEBP, BMP. Max ~10 MiB per image.
- On failure (download/upload error, oversize, not an image) the bridge posts a
  short text placeholder instead of silently dropping it — the local file path
  is never leaked into chat.
- To take a screenshot first, use whatever capture tool the host provides, save
  to a temp file, then reference it as a local-file image above:
  - Windows: `powershell -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('C:\\Temp\\shot.png')"` (or `nircmd savescreenshot C:\Temp\shot.png` if installed).
  - macOS: `screencapture -x /tmp/shot.png`.
  - Linux: `grim` on Wayland, `scrot`/`import` on X11.

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
- Update Bridge (hard-sync managed checkout, rebuild, restart): `humming update`

## Full command tree

```text
humming bridge run|start|stop|restart|status|logs   # run and manage the bridge process
humming run|start|stop|restart|status|logs          # top-level shortcuts for the above
humming agent list                                  # list Agent presets
humming agent capabilities|models|modes|permissions --agent <agent>   # short-lived Agent probe
humming session list                                # list the Agent's own sessions for a repo
humming session capabilities|models|modes|permissions   # inspect the current Topic Session
humming session configure                           # change Agent/Model/Mode/Permission/Config (+ optional message)
humming session bind                                # bind the current topic to an existing Agent session
humming session send                                # send a Message without profile changes
humming setup                                       # register a Feishu/Lark bot and save credentials
humming init                                        # seed ~/.humming guide/example files
humming update                                      # hard-sync managed checkout, rebuild, restart
```

Global-scope flags exist on most commands (`--json`, `--home`, `--chat-id`, `--thread-id`); omit
`--chat-id`/`--thread-id` for the current topic.

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
- Submit the profile change and task in a single call; never split it or ask the user to repeat.

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
