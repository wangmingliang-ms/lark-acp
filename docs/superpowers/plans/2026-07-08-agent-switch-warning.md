# Agent Switch Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve topic Agent switching while making started-topic switches explicitly destructive via warning + confirmation.

**Architecture:** `/agent <agent>` remains the Feishu-facing switch entrypoint. If the topic has no real session yet, Humming probes and writes the profile-only Agent record immediately; if it has a real session, Humming replies with an interactive warning card and does not probe or mutate state until the user confirms. Confirmation probes the target Agent and reuses the existing `controlSetAgent` session-boundary path; cancellation leaves the old session untouched.

**Tech Stack:** TypeScript, Vitest, Feishu interactive card v2 callback buttons, existing Humming `SessionStore` / `LarkPresenter` abstractions.

## Global Constraints

- Chat bindings stay repo-only; Agent / Model / Mode / Permission / Config are topic/session profile metadata.
- Started-topic Agent switch is a destructive session boundary: old Agent internal session context and switch-message task content are not migrated.
- Target Agent probe must happen before mutating current topic state.
- If target Agent probe fails, the current topic session must remain unchanged.
- The switch confirmation message is a control message, not a task message; the user must send the next task after switching.
- Do not expose full chat/thread/session ids in user-facing cards.

---

### Task 1: Add destructive switch confirmation UI contract

**Files:**

- Modify: `src/presenter/presenter.ts`
- Modify: `src/presenter/lark-presenter.ts`
- Modify: `src/index.ts`
- Modify: `src/presenter/index.ts`
- Test: `src/presenter/lark-presenter.test.ts` (covered indirectly by bridge tests; presenter builds card via new methods)

**Interfaces:**

- Produces `AgentSwitchWarningCardSpec` with `switchId`, `chatId`, `threadId`, `fromAgent`, `toAgent`, `repo`, `body`.
- Produces `AgentSwitchWarningResolution` with `status: confirmed|cancelled|expired|failed` and `text`.
- Extends `LarkPresenter` with optional `replyAgentSwitchWarningCard()` and `updateAgentSwitchWarningCard()`.

- [x] Add presenter types and optional interface methods.
- [x] Render warning card with two callback buttons: `确认切换` and `取消`.
- [x] Patch warning card to terminal resolution state after confirm/cancel/expiry.
- [x] Export new presenter types through public index files.

### Task 2: Make `/agent` warning-first for started topics

**Files:**

- Modify: `src/bridge/bridge.ts`
- Test: `src/bridge/bridge-agent-switch.test.ts`
- Test: `tests/reception-hot-reload.test.ts`

**Interfaces:**

- `PendingAgentSwitch` stores `switchId`, target Agent invocation, topic identity, cwd, and warning card id.
- Card callback payload uses `sw` for switch id and `swa` for `confirm|cancel`.

- [x] Write failing tests showing started-topic `/agent codex` sends a warning and does not probe or mutate sessions.
- [x] Implement warning path when `sessionStore.getLatest(chatId, threadId)` returns a non-`profileOnly` record.
- [x] Keep pre-session/profile-only `/agent` path immediate: probe and write profile-only record.
- [x] Add card-action routing for confirm/cancel.
- [x] On cancel, patch card and keep old session unchanged.
- [x] On confirm, patch card, probe target Agent, then call existing `controlSetAgent()`.
- [x] On stale/invalid confirmation, patch card expired and do nothing.

### Task 3: Update notices/docs and validate

**Files:**

- Modify: `src/interpreter/commands.ts`
- Modify: `templates/home/AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `tests/reception-hot-reload.test.ts`

**Interfaces:**

- Help text says started topics warn before switching.
- Home templates tell agents not to bypass the Feishu warning UI for natural-language switch requests.

- [x] Update help text for `/agent <agent>`.
- [x] Update installed home operating guide and repo CLAUDE.md.
- [x] Update existing integration tests from immediate switch semantics to warning + confirm semantics.
- [x] Run `npm run fmt:check`.
- [x] Run `npm run build`.
- [x] Run `npm test`.
- [x] Run `git diff --check`.

## Verification Results

- `npm run fmt:check` → PASS
- `npm run build` → PASS
- `npm test` → PASS, 20 files / 283 tests
- `git diff --check` → PASS
