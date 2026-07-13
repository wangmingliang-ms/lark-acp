# Cross-Platform Graceful Stop and Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stop and Restart use one cross-platform two-phase lifecycle protocol that drains active sessions before process exit and lets an independent coordinator complete Stop or relaunch Humming.

**Architecture:** A platform adapter arms a coordinator before contacting the Bridge. The Bridge enters a persisted in-memory lifecycle intent (`stop` or `restart`), stops ingress, drains every runtime through ACP cancellation and semantic `interrupted` completion, sends lifecycle notices, acknowledges `readyToExit`, and exits normally. The coordinator waits for the old PID, escalates only on timeout, and for restart launches the saved descriptor and waits for the new Bridge to become ready; Windows uses a detached child, WSL/systemd uses a separate transient unit/cgroup, and non-systemd POSIX uses a detached child.

**Tech Stack:** TypeScript, Node.js child_process/net/fs, systemd-run on WSL/Linux when available, Windows detached Node helper, Vitest.

## Global Constraints

- `Update` performs build/update work and then uses the exact Restart protocol.
- Stop and Restart share drain semantics but remain distinct lifecycle intents.
- Normal Stop/Restart must not begin with SIGTERM and must not infer intent from signal/error text.
- The coordinator must be armed before Bridge drain begins and must outlive the Bridge/Agent process tree.
- Bridge owns Session/Card semantics; Agent only receives ACP cancellation; coordinator owns only process lifecycle.
- Active Responses finish as `interrupted`, never `failed`, and expected ACP close/SIGTERM/internal error emits no crash card.
- New ingress after quiescing is rejected with an explicit not-queued notice.
- Coordinator uses SIGTERM/force kill only after bounded graceful-drain/exit timeouts.
- Restart must end in `restarted` or `restartFailed`; it must never remain indefinitely `restarting`.
- Preserve unrelated untracked `docs/2026-07-12-design-first-card-lifecycle-case.md`.

---

### Task 1: Lifecycle transaction model and coordinator contract

**Files:**

- Create: `bin/lifecycle-coordinator.ts`
- Create: `bin/lifecycle-coordinator.test.ts`
- Modify: `src/bridge/control-server.ts`
- Modify: `src/bridge/control-server.test.ts`

**Interfaces:**

- Produces `LifecycleIntent = "stop" | "restart"`.
- Produces `LifecycleTransaction` with transaction id, intent, old PID, home, launch descriptor, deadlines, and state file path.
- Adds Control request `beginLifecycle` and result `{ accepted: true, transactionId, readyToExit: true }`.

- [ ] Write failing tests proving transaction serialization, state validation, and Control request routing.
- [ ] Run `npx vitest run bin/lifecycle-coordinator.test.ts src/bridge/control-server.test.ts`; expect missing exports/request failure.
- [ ] Implement the minimal transaction types, atomic state-file persistence, and Control schema.
- [ ] Rerun the targeted tests; expect PASS.
- [ ] Commit `feat(runtime): define lifecycle transaction protocol`.

### Task 2: Independent cross-platform coordinator launch

**Files:**

- Modify: `bin/lifecycle-coordinator.ts`
- Modify: `bin/lifecycle-coordinator.test.ts`
- Modify: `bin/process-control.ts`
- Modify: `bin/process-control.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces `armLifecycleCoordinator(transaction, platformCapabilities)`.
- WSL/systemd adapter creates a separate transient unit whose command is the coordinator CLI.
- Windows and non-systemd adapter spawn a detached coordinator with ignored stdio and `unref()`.

- [ ] Write failing tests asserting command/argv/cgroup strategy for Windows, systemd, and detached POSIX.
- [ ] Run the targeted tests; expect strategy/launcher failures.
- [ ] Implement platform selection and coordinator CLI entry point without initiating shutdown yet.
- [ ] Test that helper launch is acknowledged before any Bridge control request.
- [ ] Rerun targeted tests and build; expect PASS.
- [ ] Commit `feat(runtime): arm cross-platform lifecycle coordinator`.

### Task 3: Bridge quiescing and Runtime graceful drain

**Files:**

- Modify: `src/bridge/bridge.ts`
- Modify: `src/bridge/bridge-card-lifecycle.test.ts`
- Modify: `src/bridge/chat-runtime.ts`
- Modify: `src/bridge/chat-runtime.test.ts`

**Interfaces:**

- Adds Bridge lifecycle state `running | quiescing(intent, transactionId) | readyToExit`.
- Adds `ChatRuntime.drain(intent): Promise<DrainResult>`.
- Drain order: commit intent/suppress crash → revoke actions and interrupt Response → ACP cancel → bounded wait/persist → close Agent.

- [ ] Write a failing Runtime test where prompt rejection follows intentional drain and assert no crash notice, Response `interrupted`, and ACP cancel precedes process kill.
- [ ] Run the single test; verify RED for existing shutdown behavior.
- [ ] Implement the minimum `drain()` path and make the test GREEN.
- [ ] Write a failing Bridge test proving ingress after quiescing is not queued and all runtimes drain before lifecycle notice.
- [ ] Implement Bridge lifecycle state and ordering.
- [ ] Add timeout tests proving escalation is reported as expected interruption, not crash.
- [ ] Rerun Runtime/Bridge test suites; expect PASS.
- [ ] Commit `feat(runtime): gracefully drain sessions before shutdown`.

### Task 4: Coordinator stop/restart execution and terminal outcomes

**Files:**

- Modify: `bin/lifecycle-coordinator.ts`
- Modify: `bin/lifecycle-coordinator.test.ts`
- Modify: `src/lark/lifecycle-notifier.ts`
- Modify: `src/lark/lifecycle-notifier.test.ts`

**Interfaces:**

- Coordinator waits for Bridge `readyToExit`, then old PID exit.
- Stop terminates transaction.
- Restart starts saved launch descriptor, waits for control socket/readiness, and records `restarted` or `restartFailed`.
- Adds lifecycle notice `restartFailed` with patch-or-fallback delivery.

- [ ] Write failing coordinator tests for graceful success, Bridge timeout→SIGTERM, restart success, startup timeout, and restart failure.
- [ ] Implement bounded state machine and readiness probe.
- [ ] Write failing lifecycle card tests for `restartFailed` patch and fallback.
- [ ] Implement terminal lifecycle notices.
- [ ] Rerun targeted tests and build; expect PASS.
- [ ] Commit `feat(runtime): complete coordinated stop and restart`.

### Task 5: Integrate CLI Stop, Restart, and Update

**Files:**

- Modify: `bin/humming.ts`
- Modify: `bin/humming.test.ts`
- Modify: `bin/process-control.ts`
- Modify: `bin/process-control.test.ts`

**Interfaces:**

- Stop/Restart arm coordinator, call `beginLifecycle`, and return without owning post-exit work.
- Update calls Restart after successful fetch/install/build/link.
- Remove the systemd-only exit-code self-restart special case and direct Windows stop-then-start ownership.

- [ ] Write failing CLI tests proving arm-before-control ordering and `Update → Restart` reuse.
- [ ] Implement Stop/Restart transaction creation and helper handoff.
- [ ] Remove duplicate old execution paths only after tests are green.
- [ ] Add regression for Windows self-update where caller dies but coordinator starts the new Bridge.
- [ ] Add regression for WSL/systemd helper in a different cgroup.
- [ ] Rerun CLI/process tests and build; expect PASS.
- [ ] Commit `refactor(runtime): route lifecycle commands through coordinator`.

### Task 6: Verification, publication, and live acceptance

**Files:**

- Modify only task-owned files if verification finds a regression.

- [ ] Run scoped Prettier on all task-owned files.
- [ ] Run `npm test`; expect all tests passing.
- [ ] Run `npm run build`; expect success.
- [ ] Run scoped `prettier --check`; report the unrelated untracked document separately.
- [ ] Inspect `git diff`, stage only task-owned files, run `git diff --cached --check`, commit, push, and verify upstream SHA.
- [ ] Deploy WSL managed checkout and verify Stop and Restart with active prompt: interrupted card, no crash card, helper survives, restart card patches to success.
- [ ] Deploy Windows managed checkout and repeat the same active-prompt Stop and Restart acceptance.
- [ ] Force one startup failure on each platform and verify restart card patches to failure rather than hanging.
- [ ] Verify source/upstream/managed/running revision alignment on both platforms.
