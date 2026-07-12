# Conversation Card Semantic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Humming's independently mutable card fields and direct patch paths with one token-safe, monotonic per-prompt semantic lifecycle that cannot render stale actionable or misleading receipt cards.

**Architecture:** A pure `PromptCardLifecycle` reducer owns semantic state; `PromptUpdateRouter` scopes ACP callbacks to one prompt turn; `ConversationCardDelivery` owns only transport generations and atomic close/handoff; the presenter renders an exhaustive discriminated view union. Live routing stays behind one `conversationCardLifecycleV2` gate until the single-writer cutover is complete.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest, ACP SDK 0.16, Lark SDK 1.65.

## Global Constraints

- Use strict RED-GREEN-REFACTOR for every behavioral slice.
- Never expose private chat/thread/session IDs, local paths, hostnames, or action tokens in user-facing copy or logs.
- Do not add a standalone durable “message received / processing” card.
- Only an active semantic view may contain a Cancel action.
- Prompt, segment, permission, action, and ownership tokens are opaque and unguessable.
- Semantic reduction never waits for Feishu network I/O.
- Active render updates remain coalesced at 100 ms; close/handoff/terminal effects bypass debounce.
- Conversation-card rotation remains exactly 8192 UTF-8 bytes.
- No intermediate commit enables mixed legacy/v2 semantic writers.
- Each task ends with targeted tests, full relevant tests, build, format check on touched files, an independent spec review, an independent quality review, commit, and push.
- Preserve unrelated worktree changes; stage only task-owned files.

## File map

- Create `src/presenter/conversation-card-view.ts`: semantic view discriminated union and pure rendering helpers shared by lifecycle and presenter.
- Create `src/presenter/conversation-card-view.test.ts`: compile/runtime view invariants.
- Create `src/acp/prompt-card-lifecycle.ts`: pure per-prompt state, event reducer, ToolLedger, render generations, immutable snapshot helper.
- Create `src/acp/prompt-card-lifecycle.test.ts`: transition table, terminal absorption, tool matrix, idle/flush generations.
- Create `src/acp/prompt-update-router.ts`: ACP session-notification turn attribution and quiescence barrier.
- Create `src/acp/prompt-update-router.test.ts`: active/draining/idle routing and barrier tests.
- Modify `src/acp/conversation-card-delivery.ts`: ownership token, atomic close, permission handoff, orphan reconciliation.
- Modify `src/acp/conversation-card-delivery.test.ts`: deferred transport race matrix.
- Create `src/acp/prompt-card-controller.ts`: reducer/effect runner, render coalescing, lifecycle-owned delivery integration.
- Create `src/acp/prompt-card-controller.test.ts`: end-to-end lifecycle with deferred transport.
- Modify `src/acp/humming-client.ts`: retain ACP client responsibilities but delegate prompt rendering/permissions to controller.
- Modify `src/acp/humming-client.test.ts`: adapter behavior and legacy removal tests.
- Modify `src/presenter/presenter.ts`: replace legacy free-form `UnifiedCardState` with v2 `ConversationCardView` at the gated boundary.
- Modify `src/presenter/lark-presenter.ts`: exhaustive render by view kind and v2 action payload.
- Modify `src/presenter/lark-presenter.test.ts`: no illegal action/header combinations.
- Modify `src/lark/lark-http.ts`: add/remove acknowledgement reaction methods.
- Create/modify `src/lark/lark-http.test.ts`: reaction request shape and failure behavior.
- Modify `src/bridge/chat-runtime.ts`: own one PromptCardLifecycle per accepted message, install prompt routes, map terminal reasons.
- Modify `src/bridge/chat-runtime.test.ts`: queue ownership, old update draining, shutdown/supersede.
- Modify `src/bridge/bridge.ts`: reaction acknowledgement, gated v2 routing, token-validated Cancel, remove direct conversation-card patches.
- Modify bridge tests (`src/bridge/bridge-agent-switch.test.ts` and/or a focused new `src/bridge/bridge-card-lifecycle.test.ts`): callback versioning, stale Cancel, no receipt card, no bypass.
- Modify `src/index.ts`, `src/acp/index.ts`, `src/presenter/index.ts` only for final public exports.

---

### Task 1: Legacy Cancel Compatibility Guard

**Files:**
- Modify: `src/bridge/bridge.ts`
- Test: create `src/bridge/bridge-card-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `CardActionPayload` and `handleCardAction` path.
- Produces: version-aware Cancel parser that rejects unknown/tokenized payloads before runtime cancellation; legacy payload remains unchanged while v2 gate is off.

- [ ] **Step 1: Write a failing test**

Add a bridge-level test with a runtime spy:

```ts
it("does not treat an unknown versioned card action as topic-level cancel", async () => {
  await dispatchCardAction({
    v: 2,
    cancel: true,
    c: "chat",
    th: "thread",
    p: "prompt",
    s: "segment",
    a: "action",
  });
  expect(runtime.cancel).not.toHaveBeenCalled();
});
```

Also retain a test proving the current unversioned legacy payload still cancels while the v2 feature gate is off.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- --run src/bridge/bridge-card-lifecycle.test.ts
```

Expected: versioned payload incorrectly reaches `runtime.cancel()`.

- [ ] **Step 3: Implement the compatibility guard**

Add a narrow parser/branch before topic runtime lookup:

```ts
if (value.cancel === true && value.v !== undefined) {
  this.logger.info("ignored unsupported versioned cancel action");
  return;
}
```

Do not enable v2 routing yet.

- [ ] **Step 4: Verify GREEN and regression scope**

Run:

```bash
npm test -- --run src/bridge/bridge-card-lifecycle.test.ts src/bridge/chat-runtime.test.ts
npm run build
npx prettier --check src/bridge/bridge.ts src/bridge/bridge-card-lifecycle.test.ts
```

Expected: all pass.

- [ ] **Step 5: Review, commit, and push**

```bash
git add src/bridge/bridge.ts src/bridge/bridge-card-lifecycle.test.ts
git diff --cached --check
git commit -m "fix(cards): reject unknown versioned cancel actions"
git push origin main
```

---

### Task 2: Semantic View Union

**Files:**
- Create: `src/presenter/conversation-card-view.ts`
- Create: `src/presenter/conversation-card-view.test.ts`
- Modify: `src/presenter/index.ts`

**Interfaces:**
- Produces: `PromptToken`, `SegmentToken`, `ActionToken`, `PermissionToken`, `OwnershipToken`, `ConversationCardView`, `CancelActionPayloadV2`, `cloneCardView(view)`.
- Consumes: existing `TimelineEntry` and `SessionCardMeta` types, temporarily imported from `presenter.ts`.

- [ ] **Step 1: Write failing compile/runtime invariant tests**

Tests must build representative `queued`, `starting`, `active`, `archived`, `terminal`, and `orphaned` views. Add `@ts-expect-error` assertions proving archived and terminal views cannot carry `cancelAction`.

```ts
const archived: ConversationCardView = {
  kind: "archived",
  entries: [text("done")],
  summary: "done",
  route,
  // @ts-expect-error archived cards cannot be actionable
  cancelAction,
};
```

Add a mutation test:

```ts
const snapshot = cloneCardView(activeView);
activeView.entries[0]!.text = "mutated";
expect(snapshot.entries[0]).toMatchObject({ text: "original" });
```

- [ ] **Step 2: Verify RED**

Run `npm test -- --run src/presenter/conversation-card-view.test.ts`.
Expected: module/types missing.

- [ ] **Step 3: Implement focused types and clone helper**

Use a discriminated union with no free `cancellable`. `active.cancelAction` carries `{ v: 2, promptToken, segmentToken, actionToken }`. Implement `cloneCardView` with `structuredClone`; recursively freeze only outside production.

- [ ] **Step 4: Verify GREEN**

Run targeted test, `npm run build`, and Prettier check for the three files.

- [ ] **Step 5: Review, commit, push**

Commit message: `feat(cards): define semantic conversation views`.

---

### Task 3: Pure Prompt Lifecycle Reducer

**Files:**
- Create: `src/acp/prompt-card-lifecycle.ts`
- Create: `src/acp/prompt-card-lifecycle.test.ts`
- Modify: `src/acp/index.ts`

**Interfaces:**
- Consumes: semantic tokens/views from Task 2 and card text budget helpers.
- Produces:

```ts
createPromptLifecycle(input): PromptLifecycleState
reducePromptLifecycle(state, event): TransitionResult
viewForPromptState(state): ConversationCardView | null
```

- [ ] **Step 1: RED — legal transition table**

Table-driven tests:

```ts
it.each([
  ["queued", event.starting(), "starting"],
  ["interrupting", event.starting(), "starting"],
  ["starting", event.forwarded(), "active"],
  ["active", event.archive("rotation"), "active"],
  ["active", event.finish("complete"), "terminal"],
])("moves %s through %o to %s", ...);
```

Assert terminal is absorbing and stale prompt/segment/timer/render generations return `ignored` effects.

- [ ] **Step 2: RED — tool ledger matrix and normalization**

Cover absent/pending/in-progress/completed/failed/interrupted matrix, direct pending->completed, initial completed, duplicate terminal, cross-segment completion marker, and normalization for complete/cancelled/failed/superseded/abandoned.

- [ ] **Step 3: RED — render generation and idle semantics**

Assert active updates update desired semantic state but emit only `schedule_flush`; `flush_due` with current generation emits an immutable render; archive/permission/finish invalidate it. Assert an already-reduced idle slot closed by finish cannot target a new owner.

- [ ] **Step 4: Implement the minimal pure reducer**

Keep this file free of presenter/network calls. Use exhaustive switches and `assertNever`. Store prompt-level ToolLedger separately from current segment entries.

- [ ] **Step 5: Verify**

Run targeted tests, build, and Prettier. Expected: all transition cases pass.

- [ ] **Step 6: Review, commit, push**

Commit message: `feat(cards): add prompt semantic lifecycle reducer`.

---

### Task 4: Prompt Update Router and Turn Barrier

**Files:**
- Create: `src/acp/prompt-update-router.ts`
- Create: `src/acp/prompt-update-router.test.ts`
- Modify: `src/acp/agent-process.ts`
- Modify: `src/acp/agent-process.test.ts`

**Interfaces:**
- Produces:

```ts
class PromptUpdateRouter implements acp.Client {
  activate(promptToken, sink): void
  beginDrain(promptToken): void
  awaitQuiescence(): Promise<void>
  clear(): void
}
```

- Consumes: a session-scoped delegate for filesystem, metadata, and permission operations.

- [ ] **Step 1: RED — active/draining/idle attribution**

Use fake notifications to assert only active renderable updates are stamped with its token; draining/idle updates are rejected; `session_info_update` remains session-scoped.

- [ ] **Step 2: RED — quiescence barrier**

Use fake timers. Assert one quiet event-loop interval closes the barrier, each stale renderable notification extends it, and maximum timeout prevents permanent blocking.

- [ ] **Step 3: Implement router**

The SDK constructs one client per connection, so `spawnAndInit` receives the router/delegate once. Do not read a mutable “current prompt token” inside HummingClient callbacks.

- [ ] **Step 4: Verify**

Run router + agent-process tests, build, Prettier.

- [ ] **Step 5: Review, commit, push**

Commit message: `feat(acp): scope session updates to prompt turns`.

---

### Task 5: Delivery Atomic Close and Permission Handoff

**Files:**
- Modify: `src/acp/conversation-card-delivery.ts`
- Modify: `src/acp/conversation-card-delivery.test.ts`

**Interfaces:**
- Consumes: immutable `ConversationCardView` and ownership token.
- Produces:

```ts
deliver(owner, view)
close(owner, nonActionableView): OwnershipToken
handoffToPermission(owner, patchPermission, sendPermission): Promise<PermissionHandoffResult>
reconcileSuperseded(cardId, orphanedView)
```

- [ ] **Step 1: RED — atomic close ordering**

With deferred patch, assert close queues final view behind old-owner renders, returns a fresh owner immediately, and fresh-owner delivery completes before the old promise resolves.

- [ ] **Step 2: RED — terminal over already-queued Waiting**

Queue Waiting, block transport, call close(terminal), then start a fresh owner. Assert Waiting never migrates after terminal and old action authority is absent.

- [ ] **Step 3: RED — permission handoff matrix**

Cover empty-card reuse success; reuse patch failure then one fresh send; fresh send failure; finish/cancel during handoff; stale successful permission send gets expired/reconciled.

- [ ] **Step 4: RED — superseded send reconciliation and immutable inputs**

Assert every stale successful send ID is patched with `orphaned`, and mutating source state after `deliver` cannot alter transport input.

- [ ] **Step 5: Implement minimal transport ownership changes**

Keep semantic inspection out of Delivery. Ownership identity and queues remain per generation. Do not introduce a global queue.

- [ ] **Step 6: Verify and commit**

Run delivery tests, build, Prettier. Commit: `feat(cards): add atomic lifecycle ownership handoff`.

---

### Task 6: Prompt Card Controller

**Files:**
- Create: `src/acp/prompt-card-controller.ts`
- Create: `src/acp/prompt-card-controller.test.ts`

**Interfaces:**
- Consumes: reducer (Task 3), router tokens (Task 4), delivery (Task 5), presenter ports.
- Produces intent API:

```ts
acknowledge(...)
markQueued()
markInterrupting()
markPreparing(profile)
markForwarded()
applyAgentUpdate(update)
requestPermission(...)
resolvePermission(...)
finish(outcome)
validateCancel(tokens): boolean
```

- [ ] **Step 1: RED — screenshot regressions**

Recording presenter must assert visible state history:

```text
active/actionable -> archived/non-actionable -> new active
```

Never:

```text
archived/actionable
terminal -> active
```

Cover delayed running patch + archive + later update, delayed terminal + late update, idle already queued + finish, and exactly one valid action token.

- [ ] **Step 2: RED — 100 ms coalescing**

Use fake timers: multiple chunks produce one delivery; terminal cancels pending flush and submits close immediately.

- [ ] **Step 3: RED — permission and ToolLedger integration**

Cover content boundary, empty slot reuse, failed handoff, cross-boundary tool completion, finish while awaiting permission.

- [ ] **Step 4: Implement controller/effect runner**

Semantic calls return immediately after reducer commit; effect promises are tracked for bounded shutdown but do not block reducer events.

- [ ] **Step 5: Verify and commit**

Run controller/reducer/delivery tests, build, Prettier. Commit: `feat(cards): orchestrate prompt card lifecycle`.

---

### Task 7: Exhaustive Lark Presenter V2

**Files:**
- Modify: `src/presenter/presenter.ts`
- Modify: `src/presenter/lark-presenter.ts`
- Modify: `src/presenter/lark-presenter.test.ts`
- Modify: `src/presenter/index.ts`

**Interfaces:**
- Consumes: `ConversationCardView`.
- Produces gated v2 `sendConversationCard` / `updateConversationCard` methods while legacy methods remain gate-off only.

- [ ] **Step 1: RED — exhaustive rendering**

For each view kind assert exact header presence, footer presence, summary, body, and actions. Specifically assert archived has no header/footer/button; terminal has header/no button; queued/starting no button; orphaned neutral/no button; only active emits `{ v: 2, ...tokens }`.

- [ ] **Step 2: RED — impossible view rejection**

At runtime boundary, malformed external test fixtures are rejected/logged rather than silently normalized.

- [ ] **Step 3: Implement exhaustive renderer**

No lifecycle conditions outside switch-by-kind. Preserve existing markdown panels and card-size helpers.

- [ ] **Step 4: Verify and commit**

Run presenter + budget tests, build, Prettier. Commit: `feat(cards): render semantic conversation views`.

---

### Task 8: Reaction Acknowledgement Port

**Files:**
- Modify: `src/lark/lark-http.ts`
- Create: `src/lark/lark-http.test.ts` if no focused HTTP test exists.

**Interfaces:**
- Produces:

```ts
addMessageReaction(messageId, emojiType): Promise<string>
removeMessageReaction(messageId, reactionId): Promise<void>
```

- [ ] **Step 1: RED — SDK request shape**

Assert create calls `im.v1.messageReaction.create` with `{ reaction_type: { emoji_type } }` and returns `reaction_id`; delete uses message and reaction IDs.

- [ ] **Step 2: Implement methods**

Methods throw transport errors; bridge/controller decides best-effort behavior.

- [ ] **Step 3: Verify and commit**

Run HTTP tests, build, Prettier. Commit: `feat(lark): support prompt acknowledgement reactions`.

---

### Task 9: HummingClient Adapter Migration Behind Gate

**Files:**
- Modify: `src/acp/humming-client.ts`
- Modify: `src/acp/humming-client.test.ts`

**Interfaces:**
- Consumes: controller and router.
- Produces: ACP client delegate methods without mutable semantic status/timeline/card ID state in v2 mode.

- [ ] **Step 1: RED — delegate behavior**

Assert v2 session updates enter controller with router-provided token; permission request uses PermissionToken; finalization is absorbing; late callback during drain does not reach controller.

- [ ] **Step 2: RED — no parallel v2 state**

Add source-level/behavior test proving v2 path does not own free `status`, `cancellable`, `idleStatusCardPending`, `permissionBoundaryThisPrompt`, or `flushing` state.

- [ ] **Step 3: Implement gated adapter**

Legacy path remains unchanged when gate is false. V2 path delegates semantic behavior; file read/write and session metadata remain session-scoped.

- [ ] **Step 4: Verify and commit**

Run HummingClient and all new ACP tests, build, Prettier. Commit: `refactor(cards): delegate ACP rendering to lifecycle`.

---

### Task 10: ChatRuntime Per-Prompt Ownership

**Files:**
- Modify: `src/bridge/chat-runtime.ts`
- Modify: `src/bridge/chat-runtime.test.ts`

**Interfaces:**
- Consumes: PromptCardController, PromptUpdateRouter, explicit terminal outcome map.
- Produces: one lifecycle per `PendingMessage`, including queued messages.

- [ ] **Step 1: RED — first, second, and third queued prompts**

Assert first follow-up may transition queued->interrupting->starting; later queued prompts transition queued->starting directly; each retains one card ownership.

- [ ] **Step 2: RED — prompt drain barrier**

After prompt response, send stale notification; assert it is rejected and next prompt waits for quiescence before activation.

- [ ] **Step 3: RED — terminal reason table**

Cover normal complete, explicit cancel, agent error, shutdown, supersede, bootstrap failure, permission-pending termination. Assert supersede is not success.

- [ ] **Step 4: Implement runtime integration under v2 gate**

Create prompt token/lifecycle when message is accepted, not when it begins running. Remove v2 direct presenter updates; retain legacy path gate-off.

- [ ] **Step 5: Verify and commit**

Run runtime + ACP tests, build, Prettier. Commit: `refactor(runtime): own cards per prompt lifecycle`.

---

### Task 11: Bridge Single-Writer Cutover and Stale Receipt Removal

**Files:**
- Modify: `src/bridge/bridge.ts`
- Modify: `src/bridge/bridge-card-lifecycle.test.ts`
- Modify: `src/bridge/bridge-agent-switch.test.ts` if affected.

**Interfaces:**
- Consumes: reaction port, v2 runtime lifecycle, v2 Cancel payload.
- Produces: gate-on complete single-writer route.

- [ ] **Step 1: RED — no standalone receipt card**

For a normal short prompt, assert bridge adds reaction, never directly calls conversation-card send/update, runtime creates one authoritative card, and reaction removal is attempted. Reaction add/remove failure must not abort the prompt.

- [ ] **Step 2: RED — token-safe Cancel**

Current tokens cancel exactly once. Previous prompt, previous segment, duplicate, legacy tokenless, and unknown-version buttons do not cancel current work and are best-effort neutralized.

- [ ] **Step 3: RED — no direct conversation-card bypass**

A source-level assertion scans bridge/runtime business files for direct `sendUnifiedCard` / `updateUnifiedCard` calls and fails unless inside lifecycle infrastructure/legacy gate adapter scheduled for deletion in this task.

- [ ] **Step 4: Implement cutover**

Switch acknowledgement to reaction, route all v2 card effects through runtime lifecycle, remove standalone receipt and bootstrap/queued direct patches, enable `conversationCardLifecycleV2` only after all paths are connected.

- [ ] **Step 5: Verify and commit**

Run all bridge/runtime/ACP/presenter tests, full `npm test`, build, fmt check. Commit: `feat(cards): cut over to semantic lifecycle`.

---

### Task 12: Remove Legacy Card State and Compatibility Adapter

**Files:**
- Modify: `src/acp/humming-client.ts`
- Modify: `src/presenter/presenter.ts`
- Modify: `src/presenter/lark-presenter.ts`
- Modify: `src/bridge/chat-runtime.ts`
- Modify: `src/bridge/bridge.ts`
- Modify: `src/index.ts`, `src/acp/index.ts`, `src/presenter/index.ts`
- Modify/delete obsolete tests.

**Interfaces:**
- Removes: legacy `AgentStatus + cancellable` `UnifiedCardState`, legacy rendering branch, direct presenter APIs, obsolete booleans.
- Leaves: v2 semantic view/lifecycle APIs and explicit `/cancel` command.

- [ ] **Step 1: RED — source inventory guard**

Assert no production references remain to free `cancellable`, legacy `UnifiedCardState`, `idleStatusCardPending`, `permissionBoundaryThisPrompt`, direct business-level update methods, or tokenless card Cancel generation.

- [ ] **Step 2: Remove legacy implementation**

Delete only after Task 11 full tests pass with gate on. Keep compatibility rejection for unknown/legacy card button clicks; do not restore topic-level card cancellation.

- [ ] **Step 3: Verify and commit**

Run full suite, build, global fmt check, `git diff --check`. Commit: `refactor(cards): remove legacy card lifecycle`.

---

### Task 13: Final Adversarial Verification and Runtime Deployment

**Files:**
- Tests may add focused regression fixtures only; no feature expansion.

**Interfaces:**
- Validates the entire specification and real Feishu behavior.

- [ ] **Step 1: Run deterministic race matrix**

```bash
npm test -- --run \
  src/acp/prompt-card-lifecycle.test.ts \
  src/acp/prompt-update-router.test.ts \
  src/acp/conversation-card-delivery.test.ts \
  src/acp/prompt-card-controller.test.ts \
  src/bridge/chat-runtime.test.ts \
  src/bridge/bridge-card-lifecycle.test.ts
```

- [ ] **Step 2: Run all quality gates**

```bash
npm test
npm run build
npm run fmt:check
git diff --check
```

Expected: all pass with no skipped tests or warnings attributable to the changes.

- [ ] **Step 3: Independent integration review**

Reviewer checks: one semantic writer, action authority, ACP attribution limitation, terminal absorption, immutable snapshots, permission ownership, tool ledger, no stale receipt, rollback guard.

- [ ] **Step 4: Push any review fix separately**

Every meaningful review fix gets its own commit and immediate push.

- [ ] **Step 5: Build and restart linked runtime**

```bash
npm run build
readlink -f "$(command -v humming)"
humming restart
humming status
```

Expected command target is the active development checkout and bridge is running.

- [ ] **Step 6: Real short-prompt verification**

Send one short prompt. Verify:

- acknowledgement is a transient reaction;
- no standalone “消息已收到/正在处理” card remains;
- exactly one authoritative Humming card remains after completion;
- no Cancel remains after terminal.

- [ ] **Step 7: Real long multi-tool verification**

Send a task that exceeds rotation boundaries. Verify:

- historical cards are archived without headers/footer/Cancel;
- exactly one current card is actionable;
- terminal card cannot reopen;
- no later Waiting card appears.

- [ ] **Step 8: Stale-action verification**

Click a test stale/expired card action and verify current task continues. Inspect logs for stale-token rejection without sensitive identifiers.

- [ ] **Step 9: Final status and commit**

Confirm `git status --short` is clean and `humming status` reports running. No additional commit is needed unless verification added a focused regression fix.
