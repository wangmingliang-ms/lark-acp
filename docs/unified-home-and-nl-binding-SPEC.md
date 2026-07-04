# SPEC: Unified `~/.lark-acp/` home dir + natural-language binding

Status: DRAFT — implementing on branch `feat/unified-home-dir` (based on
`feat/per-chat-repo-routing`).
Owner: Miller (wangmingliang-ms/lark-acp fork)
Decided interactively; this doc is the durable record so context survives.

---

## Motivation

1. **Scattered state.** lark-acp currently spreads its files across three
   places — confirmed on this machine:
   - `~/.config/lark-acp/config.json` (credentials + runtime + agents)
   - `~/.local/share/lark-acp/sessions.json` + `bindings.json`
   - log wherever the launcher points (`/tmp/lark-acp.log` in our runs)
2. **Binding UX is clumsy.** Binding a chat needs an absolute path
   (`/bind ~/workspace/copilot-rewrite claude`), painful from a phone.
   Miller wants to bind by _talking to the agent_ in natural language.

Miller's decisions:

- Consolidate everything under a single home dir **`~/.lark-acp/`**, created
  on startup if missing. It holds config, logs, session/binding state — the
  one place lark-acp manages.
- Merge config into a single **`~/.lark-acp/settings.json`** (credentials +
  runtime + agents + bindings all in one file).
- Natural-language binding **without MCP**: the agent edits `settings.json`
  using its own file tools; lark-acp watches the file and hot-reloads. No new
  server, no new protocol — reuse what the agent already has.

---

## Two-phase plan (do phase 1 fully, verify, then phase 2)

### PHASE 1 — Unify to `~/.lark-acp/` (pure infra refactor, no behaviour change)

Goal: one home dir, one settings file, old data migrated, everything still
works exactly as before.

#### 1.1 Home dir resolution

- New precedence for the home dir:
  1. `--home <dir>` CLI flag (new, optional)
  2. `LARK_ACP_HOME` env (new)
  3. default `~/.lark-acp/`
- On startup: `mkdirSync(home, { recursive: true })`.
- Layout inside:
  ```
  ~/.lark-acp/
    settings.json      # credentials + runtime + agents + bindings (see 1.2)
    sessions.json      # ACP session resume state (moved from ~/.local/share)
    lark-acp.log       # default log target (see 1.4)
    inbox/             # reserved for future received-file storage
  ```
  NOTE: bindings move _into_ settings.json (1.2), so there is no separate
  bindings.json in the new layout.

#### 1.2 `settings.json` schema (superset of today's config.json)

```jsonc
{
  "credentials": { "appId": "cli_...", "appSecret": "..." },
  "runtime": {
    "cwd": "...", // optional default cwd (unchanged)
    "idleTimeoutMinutes": 1440,
    "maxChats": 10,
    "hideThoughts": false,
    "hideTools": false,
    "hideCancelButton": false,
    "permissionMode": "alwaysAsk",
    "groupRequireMention": false, // already implemented on prior branch
    "unboundCwd": "~/.lark-acp", // phase 2: reception area for unbound chats
  },
  "agents": {/* user preset patches, unchanged */},
  "bindings": {
    // chatId -> binding (moved out of bindings.json)
    "oc_xxxx": { "cwd": "/abs/path", "agent": "claude" },
  },
}
```

- `credentials` / `runtime` / `agents` — identical shape to today's
  `config.json`, so parsing logic is reused verbatim.
- `bindings` — NEW top-level block. This is what the agent edits (phase 2)
  and what the file-watcher reloads.

#### 1.3 Store changes

- `FileSessionStore` — point at `~/.lark-acp/sessions.json` (constructor
  already takes a dir; just pass the home dir).
- Bindings — today `FileBindingStore(dataDir)` writes `bindings.json`. Phase 1
  keeps `FileBindingStore` but repoints it at the `bindings` block of
  settings.json. Two viable shapes; chosen: **a `SettingsBindingStore` that
  reads/writes the `bindings` key of settings.json** (so bindings live in the
  one file, per Miller). It implements the existing `BindingStore` interface,
  so `LarkBridge` is unchanged. `FileBindingStore` is kept for compatibility /
  tests but no longer wired by the CLI.

#### 1.4 Logging

- CLI default: write pino output to `~/.lark-acp/lark-acp.log` when no TTY /
  when run as a daemon. Keep stdout when interactive so `--help` etc. still
  print. (Minimal: document the log path; the launcher currently redirects
  manually — make the code default to it.)

#### 1.5 Migration (must-have — do not lose Miller's live creds/bindings)

On startup, if `~/.lark-acp/settings.json` does NOT exist:

1. If old `~/.config/lark-acp/config.json` exists → read it, and read old
   `~/.local/share/lark-acp/bindings.json` if present → compose a fresh
   `settings.json` (config fields + `bindings` block) and write it.
2. Copy `~/.local/share/lark-acp/sessions.json` → `~/.lark-acp/sessions.json`
   if the new one is absent.
3. Leave the old files in place (non-destructive); log a one-line
   "migrated to ~/.lark-acp" notice.
   Idempotent: once settings.json exists, migration is skipped.

#### 1.6 Backward-compat / flags

- `--config <path>` still honoured (overrides settings.json location).
- `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET` / `LARK_ACP_PERMISSION_MODE` env
  still override.
- `--data-dir` deprecated → treated as `--home` alias with a warning (keeps
  old invocations working).

#### 1.7 Phase-1 acceptance

- `tsc` zero errors; `vitest` all green (add tests for settings merge +
  migration).
- Fresh start with no `~/.lark-acp` → dir + settings.json created.
- Existing install (our machine) → creds + the current binding migrate; the
  live bot keeps working with no re-`/bind`.
- Real-run smoke: bridge boots reading `~/.lark-acp/settings.json`, Feishu WS
  connects, an existing chat still routes to its repo.

---

### PHASE 2 — Natural-language binding via agent-edited settings + hot-reload

Depends on Phase 1's `~/.lark-acp/` + settings.json.

Three pieces, each with a real pitfall to handle:

#### 2.1 Reception area for unbound chats

- Today an unbound chat (no binding, no default) replies "please /bind" and
  does nothing. Change: if `runtime.unboundCwd` is set (default
  `~/.lark-acp`), spawn the agent there so the user can converse immediately.
- The agent running in the reception area is what the user talks to in order
  to bind.

#### 2.2 chatId injection (so the agent knows which chat to bind)

- Pitfall: the agent subprocess doesn't know which Feishu chat it serves.
- Fix: when spawning, inject `LARK_ACP_CHAT_ID=<chatId>` into the agent env,
  AND drop a short instruction file into the reception cwd (an
  `AGENTS.md` / `CLAUDE.md` the agent auto-reads) explaining:
  "To bind this chat to a repo, set bindings[<this chatId>] = { cwd, agent }
  in ~/.lark-acp/settings.json. Your chat id is $LARK_ACP_CHAT_ID."
- So the agent writes the correct `bindings[chatId]` entry, not a guess.

#### 2.3 Hot-reload (NEW — does not exist today)

- Pitfall: lark-acp reads config only at startup; nothing watches files.
- Fix: `fs.watch(settingsPath)` (debounced ~300ms; watchers double-fire).
  On change:
  1. Re-read settings.json atomically; if parse fails (agent mid-write /
     half-written file) → ignore this event, wait for the next (never crash).
  2. Diff the `bindings` block against in-memory state.
  3. For each chat whose binding was added/changed: update the in-memory
     `chatId -> {cwd,agent}` map, tear down that chat's live runtime, and let
     the next message respawn in the new cwd. Other chats + the Feishu WS are
     untouched — no full restart, no reconnect.
- Concurrency pitfall: lark-acp ALSO writes settings.json (e.g. its own
  `/bind` command, migration). Guard with atomic writes (write temp file +
  rename) on lark-acp's side, and tolerate transient parse failures on the
  read side (step 1). The agent writes via its own editor; if it corrupts the
  file, the bad parse is ignored and the user is told to retry — no state loss
  because the last-good in-memory map stays.

#### 2.4 Phase-2 acceptance

- Unbound chat → can chat with the agent in `~/.lark-acp`.
- User says "bind me to copilot-rewrite" → agent edits settings.json →
  lark-acp hot-reloads → next message runs in `~/workspace/copilot-rewrite`.
- No service restart, no Feishu reconnect, other chats unaffected.
- Malformed agent write → ignored gracefully, previous binding preserved.

---

## Out of scope (both phases)

- MCP tool injection (explicitly rejected in favour of file-editing).
- Fuzzy `/bind` short-name matching (superseded by NL binding).
- Preinstalling the claude ACP adapter to kill npx cold-start (separate perf
  task; noted, deferred).

## Open questions (resolve as they come up, not blockers)

1. Log rotation for `~/.lark-acp/lark-acp.log` — probably out of scope v1.
2. Should the reception-area instruction file be `AGENTS.md` (codex) vs
   `CLAUDE.md` (claude)? Likely write both, or pick per configured agent.
3. Whether `/bind` command stays as a manual fallback (yes — keep it).
