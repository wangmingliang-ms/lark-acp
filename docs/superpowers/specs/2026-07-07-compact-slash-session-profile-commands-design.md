# Compact slash session-profile commands

**Date:** 2026-07-07
**Status:** Proposed — pending user spec review

## 1. Problem

Humming already supports changing a topic's session profile through the Humming CLI/control path:

- `humming sessions set-agent ...`
- `humming sessions set-control ...`
- `humming control capabilities ...`

That works when the current ACP Agent is healthy enough to receive a natural-language request, inspect Humming docs, and run the CLI. It fails in the exact recovery case we care about: the current Agent may be unavailable, unauthenticated, hung, or crashing. In that state, asking the Agent to switch itself is unreliable because the request must pass through the broken Agent first.

We need a compact, bridge-native slash command path that lets the user manually change the topic profile from Feishu/Lark without involving the current ACP Agent.

## 2. Product direction

The new commands are **slash-only**. Humming strips its own bot mention, then recognizes only strict slash commands in text messages. No natural-language fallback, no fuzzy matching, and no non-slash aliases.

Initial command surface:

```text
/agent <agent>
/model <model-id|auto>
/mode <mode-id>
/permission <alwaysAsk|alwaysAllow|alwaysDeny>
/profile
```

These are compact Feishu commands, not a second product surface. Their behavior and post-action user experience must stay consistent with the existing Humming command/control path. A successful `/agent copilot` should produce the same notice semantics as `humming sessions set-agent --agent copilot`; a failed target-Agent probe should produce the same `⚠️ 目标 Agent 不可用` experience; control updates should reuse the same session-profile success/queued/failure cards.

## 3. Non-goals

- No dropdown UI or interactive command wizard in v1.
- No non-slash Chinese aliases.
- No broad `/config` command yet.
- No compound parser in v1, e.g. `/agent copilot model auto`. Keep commands one operation each unless a later product need appears.
- No hidden transcript/history migration when switching Agent. Agent switch remains a session boundary.

## 4. Semantics

### 4.1 `/agent <agent>`

`/agent <agent>` switches the current Feishu topic's Agent without using the current ACP Agent.

Flow:

1. Resolve `<agent>` using the same preset/raw-command resolver used by Humming CLI agent selection.
2. Resolve the current topic repo using existing binding/profile rules:
   - current chat binding repo if present;
   - default/reception cwd where applicable;
   - fail visibly if no repo can be determined.
3. Probe the target Agent in that repo by creating a short-lived ACP session.
4. If probe fails:
   - do not tear down the current runtime;
   - do not mutate `sessions.json`;
   - reply with the same target-Agent failure notice as the Humming command path.
5. If probe succeeds:
   - supersede the current topic runtime if present;
   - clear the current topic's persisted ACP session binding;
   - save a `profileOnly` `SessionRecord` for the target Agent;
   - inherit controls only from the same chat's most recent session that used the same target Agent invocation;
   - reply with the same `✅ Agent 已切换` notice as the Humming command path.

Switching Agent never copies the old Agent's conversation history, session id, model id, mode id, or config values.

### 4.2 `/model <model-id|auto>`

`/model <model-id>` sets the current topic's ACP model via the existing session-control path.

`/model auto` has special semantics: **clear the explicit model override**. It means “let the current/next Agent use its own default or automatic model selection.” It must not persist a literal `modelId: "auto"`, because ACP agents do not share a universal `auto` model id.

Implementation consequence: `SessionControls` needs a way to represent model deletion/clearing. Today `modelId?: string` cannot distinguish “no change” from “delete modelId”. Add an explicit clear operation rather than overloading an empty string.

Recommended internal shape:

```ts
type SessionControlPatch = {
  readonly modelId?: string;
  readonly clearModelId?: true;
  readonly modeId?: string;
  readonly bridgePermissionMode?: PermissionMode;
  readonly config?: Readonly<Record<string, SessionConfigControlValue>>;
};
```

Persisted `SessionRecord.controls` should remain clean ACP-ish state and should not contain `clearModelId`; the clear marker exists only for command/control patch application.

### 4.3 `/mode <mode-id>`

`/mode <mode-id>` sets the current topic mode through the existing control application semantics:

- validate against live capabilities when a runtime is active;
- fail atomically and visibly when invalid;
- when a prompt is in flight, queue for the next turn rather than mutating the current prompt.

### 4.4 `/permission <mode>`

`/permission <alwaysAsk|alwaysAllow|alwaysDeny>` updates Humming's bridge-side permission policy for the current topic.

This is not ACP-native and should use the same `bridgePermissionMode` path as the existing Humming command/control flow.

### 4.5 `/profile`

`/profile` shows the current topic's effective session profile:

- Agent
- Repo
- Mode
- Model
- Permission
- Controls
- whether controls are live, stored, pending, or profile-only when that distinction matters

It should use the same display helpers as the success notices so labels remain consistent.

## 5. Code-sharing requirement

The slash-command path must not become a parallel implementation of Humming commands.

Current relevant paths:

- Feishu command recognition already exists in `src/interpreter/lark-interpreter.ts`.
- Bridge-native command dispatch already exists in `LarkBridge.handleCommand()`.
- Humming CLI sends control requests to `BridgeControlServer`.
- `LarkBridge.controlSetAgent()`, `controlSetControls()`, and `controlAgentProbeFailed()` already own the user-facing notice cards for set-agent, set-control, and probe failure.
- Existing notice builders include `buildSessionAgentSwitchedNotice()`, `buildStoredControlUpdatedNotice()`, `buildPendingControlQueuedNotice()`, and `buildAgentProbeFailedNotice()`.

Refactor target:

1. Extract session-profile operations and notice rendering into a shared bridge module, for example `src/bridge/session-profile-commands.ts` or `src/session-profile/session-profile-service.ts`.
2. Keep adapters thin:
   - Humming CLI parses CLI flags and sends/constructs a shared request.
   - Feishu slash commands parse compact text and construct the same shared request.
   - Control socket handlers call the same operation functions.
3. All user-visible success/failure/queued cards come from the same builders.
4. Tests should assert the slash path and control path return/render equivalent notices for the same operation.

A lighter implementation is acceptable only if it still achieves real sharing: slash commands may call the same bridge control methods directly, provided those methods are the single source of truth for mutation and notice cards. If private-method coupling makes that awkward, refactor rather than duplicating behavior.

## 6. Error handling and UX

Every slash command must produce a visible result card. Silent failure is not acceptable for a recovery command.

Expected cases:

- Missing argument: usage notice, e.g. `ℹ️ 用法：/agent <agent>`.
- Unknown Agent: red/orange failure notice, no state mutation.
- Target Agent probe failure: reuse `⚠️ 目标 Agent 不可用`, no state mutation.
- Invalid model/mode/config id: reuse session-control failure semantics; show the invalid id and available ids when available.
- In-flight prompt: queue control changes for next turn and show the existing queued-profile notice. Do not claim the current prompt changed.
- `/model auto`: success notice must show Model moving to `—` / automatic/default, not to a literal `auto` id.

## 7. Implementation map

### 7.1 Interpreter

`src/interpreter/lark-interpreter.ts`:

- Extend `LarkCommand` with:
  - `{ kind: "set-agent"; agent: string }`
  - `{ kind: "set-model"; model: string | "auto" }`
  - `{ kind: "set-mode"; mode: string }`
  - `{ kind: "set-permission"; permissionMode: PermissionMode }`
  - `{ kind: "profile" }`
- Add strict parsers for `/agent`, `/model`, `/mode`, `/permission`, `/profile`.
- Preserve existing exact-match commands (`/cancel`, `/new`, `/bind`, `/where`, `/unbind`).
- Do not parse post/non-text messages as commands.

### 7.2 Shared session-profile operation layer

Create or extract a shared operation layer that can be called by both control socket handlers and slash commands.

Responsibilities:

- Resolve target Agent invocation and cwd.
- Probe target Agent for `/agent` / `sessions set-agent` before mutation.
- Apply/persist control patches, including clear-model semantics.
- Decide live vs stored vs pending behavior.
- Build/send the canonical notice cards.

### 7.3 Bridge dispatch

`src/bridge/bridge.ts`:

- Add command branches in `handleCommand()`.
- Pass `messageId` as the notice anchor so slash command responses reply to the command message.
- Never enqueue these commands to the ACP Agent.

### 7.4 CLI/control compatibility

- Keep existing `humming sessions set-agent` and `humming sessions set-control` behavior.
- If the control payload needs `SessionControlPatch` for clear-model support, update the control-server schema and CLI validation together.
- Prefer Windows-safe JSON transport already designed for `set-control`; no new quoting-sensitive command requirements.

### 7.5 Home docs/templates

Update `templates/home/AGENTS.md` / `CLAUDE.md` so Agents know:

- If the user explicitly sends slash commands, those are handled by Humming and should not be reinterpreted by the Agent.
- For natural-language setting changes, Agents should still use Humming CLI/control commands.
- `/model auto` means clear the explicit model override.

## 8. Testing

Minimum tests:

1. Interpreter parses each slash command exactly and rejects near misses.
2. Slash commands are not enqueued to `ChatRuntime`.
3. `/agent <agent>` probe failure leaves existing runtime/session untouched and renders the same failure notice as `agentProbeFailed`.
4. `/agent <agent>` success writes a profile-only record and renders the same success notice as `sessions set-agent`.
5. `/model auto` clears persisted `controls.modelId` without writing a literal `auto`.
6. `/model <id>` and `/mode <id>` use existing validation/apply/queue behavior.
7. In-flight control changes show the same queued notice as the Humming command path.
8. `/profile` displays Agent / Repo / Mode / Model / Permission / Controls consistently with success notices.

Quality gate:

```bash
npm run fmt
npm run fmt:check
npm run build
npm test
git diff --check
```

Runtime smoke after implementation:

```bash
humming restart
humming status
```

Then test from Feishu with:

```text
/profile
/model auto
/agent copilot
/profile
```

## 9. Open decisions

None for v1. Miller confirmed slash-only and requested consistency/code sharing with Humming command behavior.
