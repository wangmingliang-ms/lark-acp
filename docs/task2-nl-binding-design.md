# Task 2 design — natural-language binding (implementation notes)

Branch: `feat/nl-binding` (off main @ 602b533). Companion to
`docs/unified-home-and-nl-binding-SPEC.md` phase 2. This file pins the
concrete design so context survives.

## Flow

```
unbound chat sends a message
   → bridge has no binding for this chatId
   → NEW: spawn the default agent in the "reception area" (unboundCwd, default ~/.lark-acp)
     instead of replying "please /bind"
   → agent can converse normally; on spawn we injected:
       env  LARK_ACP_CHAT_ID   = <chatId>
       env  LARK_ACP_SETTINGS  = <abs path to settings.json>
       file <cwd>/AGENTS.md + <cwd>/CLAUDE.md  = how-to-bind instructions
   → user: "把这个 chat 绑到 copilot-intellij，用 claude"
   → agent edits settings.json: bindings[<chatId>] = { cwd: "...", agent: "claude" }
   → bridge's fs.watch(settings.json) fires (debounced)
   → re-read bindings; this chat's binding is new → tear down its reception runtime
   → next message spawns the real agent in ~/workspace/copilot-intellij
```

## Agent selection (Miller's explicit requirement)

The instruction file tells the agent that a binding is
`{ cwd, agent }` and `agent` may be any of the built-in presets
(claude, codex, copilot, gemini, opencode, claude-agent) or a raw command.
So "绑到 copilot-intellij，用 codex" → `{ cwd: ".../copilot-intellij", agent: "codex" }`.
Resolution happens in SettingsBindingStore via the injected resolver (already
built in task 1) — agent label → command/args.

## Pieces

1. **Reception binding** — `resolveBinding` returns a non-null reception
   binding (default agent @ unboundCwd, `explicit:false`) when nothing else
   matches AND `unboundCwd` is configured (default on). A new
   `reception: true` marker distinguishes it so we can (a) inject the bind
   instructions only there, (b) still show a subtle "unbound" hint.
   - Config: `runtime.unboundCwd` (default `<home>`), `--unbound-cwd`,
     and a way to disable (set empty → restore old "please /bind" behaviour).

2. **chatId + settings injection** — `ChatRuntimeOptions` gains optional
   `agentEnvExtra` (or bridge builds env). Simpler: bridge passes the extra
   env in the `agentEnv` it already threads through. Add
   `LARK_ACP_CHAT_ID`, `LARK_ACP_SETTINGS`. Write instruction files into the
   reception cwd once per spawn (idempotent).

3. **Hot-reload** — bridge owns an `fs.watch(settingsPath)` started in
   `start()`, stopped in `stop()`. Debounced ~300ms. On fire:
   - re-list bindings from bindingStore (tolerates half-written file → skip).
   - diff against a snapshot map `chatId -> cwd|agent signature`.
   - for each added/changed chatId that has a live runtime: `teardownChat` so
     the next message respawns in the new cwd. For removed bindings: also tear
     down (falls back to reception on next message).
   - other chats + Feishu WS untouched.

## Pitfalls handled

- Double-fire of fs.watch → debounce + signature diff (no-op if unchanged).
- Half-written settings.json → SettingsBindingStore.readRoot() already
  returns {} on parse failure; hot-reload treats "can't read" as "no change".
- Concurrent writes (bridge /bind vs agent edit) → atomic temp+rename already
  in SettingsBindingStore; last writer wins, watcher reconciles.
- Reception runtime must NOT be persisted as a real binding (it's ephemeral).

## Acceptance

- Unbound chat converses in reception area.
- "bind me to X using codex" → settings.json updated → hot-reload → next msg
  runs in X with codex. No restart, no reconnect, other chats fine.
- Agent selection honoured (claude vs codex vs …).
