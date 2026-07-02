# SPEC: Per-Chat Repo Routing (one Lark App, one group = one repo)

Status: DRAFT — awaiting Miller's confirmation before implementation.
Owner: Miller (wangmingliang-ms/lark-acp fork)

## 1. Goal

Run a **single Lark bot / single App** that serves **multiple project groups**,
where **each Lark group is bound to its own repo directory (cwd) and its own
ACP agent** (e.g. `claude`, `codex`). Messages in group A drive an agent in
repo A; messages in group B drive a separate agent in repo B. Sessions are
fully isolated per group.

This mirrors Miller's current Hermes usage: one bot, each Feishu chat pinned to
one project (Azure-IntelliJ / Copilot-IntelliJ / Copilot-Rewrite / Daily-Work).

## 2. Non-Goals (this iteration)

- Thread-level routing (one group, many topics → many repos). Deferred; the
  routing key chosen here is forward-compatible with it (see §7).
- Reverse Lark tools for the agent (MCP injection), proactive push, persistent
  personal memory. Tracked separately — out of scope for routing.

## 3. Why this is a small change (code facts)

Confirmed by reading the source:

- The router key is **already `chatId`**. `LarkBridge.acquireRuntime(chatId)`
  (`src/bridge/bridge.ts:361`) creates one `ChatRuntime` per chat, each with its
  own agent subprocess and ACP session. Groups are already isolated.
- `ChatRuntime` **already accepts per-chat** `agentCommand` / `agentArgs` /
  `agentCwd` / `agentEnv` (`src/bridge/chat-runtime.ts:20`). The bridge just
  happens to feed every chat the same global values from `this.agentOpts`
  (`src/bridge/bridge.ts:178`, `:367-380`).
- `SessionStore.save()` **already persists** `cwd` / `agentCommand` /
  `agentArgs` per chatId (`src/bridge/chat-runtime.ts:302-313`).

So the only thing hardcoded "global" is the choice of which cwd/agent a chat
gets. We make that a per-chat lookup. Core streaming / card / permission /
cancel logic is untouched.

## 4. Binding mechanism (the one open decision)

Support BOTH, dynamic preferred:

### 4a. Dynamic command (primary UX)

In a group (after @mention), the user sends bridge-level commands:

- `/bind <path> [agent]` — bind this chat to `<path>` running `[agent]`
  (agent defaults to a configured default preset, e.g. `claude`).
  Example: `/bind ~/workspace/copilot-intellij claude`
- `/unbind` — remove this chat's binding (agent torn down).
- `/where` — show this chat's current binding (path + agent).

`/bind` on an already-bound chat = rebind: tear down the old runtime + clear its
session mapping, next message spawns fresh in the new cwd/agent.

### 4b. Static config (optional, for known chat_ids)

`config.json` gains a `bindings` map so stable chats can be pre-wired:

```jsonc
{
  "bindings": {
    "oc_xxxxxxxx": { "cwd": "~/workspace/copilot-intellij", "agent": "claude" },
    "oc_yyyyyyyy": { "cwd": "~/workspace/copilot-rewrite", "agent": "codex" },
  },
  "defaultAgent": "claude",
}
```

Precedence: live `/bind` (persisted) overrides static config for that chat.

## 5. Behavior when a chat is UNBOUND

First message in an unbound chat does **not** spawn against a wrong default.
Instead the bridge replies with a notice card: "This chat isn't bound to a repo
yet — send `/bind <path> [agent]`." (Optional escape hatch: a configured
`defaultCwd` that, if set, auto-binds unbound chats to it.)

## 6. Affected code points (implementation sketch)

1. **Binding store** — new `src/binding-store/` (JSON file `bindings.json` under
   `dataDir`), map `chatId → { cwd, agent }`. Mirrors `FileSessionStore` shape.
2. **Interpreter** — `src/interpreter/lark-interpreter.ts`: extend `LarkCommand`
   with `bind` / `unbind` / `where`; parse args in `detectCommand` (currently
   only exact-match `cancel` / `new`, line 217).
3. **Bridge** — `src/bridge/bridge.ts`:
   - `handleCommand` (line 295): handle the 3 new commands.
   - `acquireRuntime` (line 361): resolve binding → per-chat `{cwd, command,
args}`; if none, return null and let caller send the "please /bind" card.
   - Bridge needs a **preset→command resolver** (today that mapping lives in the
     CLI layer `bin/agents.ts`). Pass the resolved registry (or a resolver fn)
     into `LarkBridge` so it can map an agent id → `{command, args, env}` at
     spawn time.
4. **CLI** — `bin/lark-acp.ts`: parse `bindings` / `defaultAgent` / `defaultCwd`
   from config; build the registry and hand it (plus binding store) to the
   bridge. `--cwd` / `--agent` become the _default_ binding, not a global lock.

`ChatRuntime` and `SessionStore`: **no change** (already per-key).

## 7. Forward-compatibility with thread routing

Routing key is factored as `routeKey(event)`. Today `routeKey = chatId`. To add
thread routing later, `routeKey = chatId + ":" + thread_id` (the Lark SDK
message event already carries `thread_id` — confirmed present in
`@larksuiteoapi/node-sdk` typings). No structural rework needed.

## 8. Edge cases

- Path must exist + be a directory; `~` expanded; relative resolved against a
  configured root (or require absolute). Reject with a clear card otherwise.
- Rebind mid-session: graceful teardown, fresh session next message.
- Group chats still require @mention (unchanged, `bridge.ts:262-278`).
- **Security note:** `/bind` lets a Lark user point the agent at any local dir.
  Acceptable for a single-user personal bridge; optionally constrain to an
  allowlist root via config. Flag for Miller's call.

## 9. Testing plan

- Unit: binding parse/validate, preset resolver, routeKey.
- Manual E2E: two Lark groups → `/bind` each to a different repo → confirm (a)
  isolation, (b) correct cwd per group, (c) persistence across bridge restart,
  (d) rebind works, (e) unbound chat gets the notice card.
- Self-tested & working before handing back (per Miller's quality gate).

## 10. Open questions for Miller

1. Binding UX: dynamic `/bind` primary + static config, OK? (recommended)
2. Unbound chat: notice-card-and-wait (recommended) vs. auto-bind to a default cwd?
3. Security: allow binding to any absolute path, or restrict to an allowlist root?
