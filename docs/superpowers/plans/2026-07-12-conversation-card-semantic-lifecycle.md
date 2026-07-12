# Conversation Card Semantic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Humming's independently mutable card fields and direct patch paths with one token-safe, monotonic per-prompt semantic lifecycle that cannot render stale actionable or misleading receipt cards.

**Architecture:** A pure `PromptCardLifecycle` reducer owns semantic state; `PromptCallbackRouter` scopes ACP callbacks using the protocol response boundary; `ConversationCardDelivery` owns only transport generations and atomic close/handoff; the presenter renders an exhaustive discriminated view union. Live routing stays behind one `conversationCardLifecycleV2` gate until the single-writer cutover is complete.

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
- Create `src/presenter/conversation-card-view.test.ts`: runtime cloning/view invariant checks.
- Create `src/acp/prompt-card-lifecycle.ts`: pure per-prompt state, event reducer, ToolLedger, render generations, immutable snapshot helper.
- Create `src/acp/prompt-card-lifecycle.test.ts`: transition table, terminal absorption, tool matrix, idle/flush generations.
- Create `src/acp/prompt-callback-router.ts`: ACP callback entry-time route capture and protocol response boundary.
- Create `src/acp/prompt-callback-router.test.ts`: active/closed routing, stale permission cancellation, and connection quarantine.
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
- Modify `templates/home/settings.back.json`: document the disabled-by-default feature gate.
- Modify `bin/humming.ts` and `bin/process-control.ts`: feature enable/disable and rollback-safe restart commands.
- Create `tsconfig.type-tests.json` and `type-tests/conversation-card-view.test-d.ts`: compile-time illegal-state checks.

---

### Task 1: Legacy Cancel Compatibility Guard — COMPLETED (`4700e9d`)

**Files:**
- Modified: `src/bridge/bridge.ts`
- Created: `src/bridge/bridge-card-lifecycle.test.ts`

**Verified TDD evidence:**
- [x] RED proved a versioned Cancel reached runtime lookup before the guard.
- [x] GREEN rejects every Cancel payload with an own `v` field before runtime lookup.
- [x] Legacy unversioned Cancel remains functional while v2 is disabled.
- [x] Focused bridge/runtime suite: 30/30 passed.
- [x] Build, Prettier, and diff checks passed.
- [x] Independent specification review: PASS.
- [x] Commit `4700e9d` pushed to `origin/main`.

---

### Task 2: Semantic View Union

**Files:**
- Create: `src/presenter/conversation-card-view.ts`
- Create: `type-tests/conversation-card-view.test-d.ts`
- Create: `tsconfig.type-tests.json`
- Modify: `src/presenter/index.ts`

**Interfaces:**
- Produces: `PromptToken`, `SegmentToken`, `ActionToken`, `PermissionToken`, `OwnershipToken`, `ConversationCardView`, `CancelActionPayloadV2`, `cloneCardView(view)`.
- Consumes: legacy text/thought/tool data shape for conversion, but defines new v2 `ActiveTimelineEntry`, `ArchivedTimelineEntry`, and `TerminalTimelineEntry`. V2 `ToolStatus` includes `interrupted`; it does not reuse the legacy presenter `TimelineEntry` type.

- [ ] **Step 1: Write failing compile/runtime invariant tests**

Put `@ts-expect-error` checks in `type-tests/conversation-card-view.test-d.ts`, which is included by `tsconfig.type-tests.json`; ordinary `*.test.ts` files are excluded from the production `tsconfig.json` and are not valid type tests.

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

Add runtime clone tests in a small colocated Vitest file or the type module's focused test. Mutate nested entry text, tool detail, profile, route/action payload, and nested permission data after cloning and assert the snapshot stays unchanged:

```ts
const snapshot = cloneCardView(activeView);
activeView.entries[0]!.text = "mutated";
expect(snapshot.entries[0]).toMatchObject({ text: "original" });
```

- [ ] **Step 2: Verify RED**

Run `npx tsc -p tsconfig.type-tests.json --noEmit` and the focused runtime test.
Expected: missing module/types and failed type expectations before implementation.

- [ ] **Step 3: Implement focused types and clone helper**

Use a discriminated union with no free `cancellable`. `CardRoute` supplies `{ c, th? }`; `active.cancelAction` supplies `{ p, s, a }`; only the renderer combines them into `{ v: 2, cancel: true, c, th?, p, s, a }`. Define the v2 tool status union with `interrupted`. Implement `cloneCardView` with `structuredClone`; recursively freeze only outside production.

- [ ] **Step 4: Verify GREEN**

Run the focused runtime test, `npx tsc -p tsconfig.type-tests.json --noEmit`, `npm run build`, and Prettier check for all touched files.

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

Assert active updates advance desired state while maintaining at most one timer. The timer reads the latest generation/view when it fires; updates after its callback clears the scheduled marker create a second timer. Archive/permission/finish invalidate pending flush. Assert an already-reduced idle slot closed by finish cannot target a new owner.

- [ ] **Step 4: RED — deterministic generated sequences and diagnostics**

Use a seeded local PRNG to generate thousands of legal/illegal event sequences; after every event assert view invariants and terminal absorption. Assert every accepted/rejected transition emits bounded diagnostics with runtime-local prompt/segment sequence, from/to phase, event, entry/byte counts, delivery outcome placeholder, action revocation, and stale reason—never raw tokens, card content, IDs, or paths.

- [ ] **Step 5: Implement the minimal pure reducer**

Keep this file free of presenter/network calls. Use exhaustive switches and `assertNever`. Store prompt-level ToolLedger separately from current segment entries.

- [ ] **Step 6: Verify**

Run targeted tests, build, and Prettier. Expected: all transition cases pass.

- [ ] **Step 7: Review, commit, push**

Commit message: `feat(cards): add prompt semantic lifecycle reducer`.

---

### Task 4: ACP Prompt Callback Router and Protocol Boundary

**Files:**
- Create: `src/acp/prompt-callback-router.ts`
- Create: `src/acp/prompt-callback-router.test.ts`
- Modify: `src/acp/agent-process.ts`
- Modify: `src/acp/agent-process.test.ts`

**Interfaces:**
- `PromptCallbackRouter` is the sole `acp.Client` supplied to `ClientSideConnection`.
- It owns session-scoped delegates and one optional active prompt route:

```ts
class PromptCallbackRouter implements acp.Client {
  activate(promptToken: PromptToken, callbacks: PromptScopedCallbacks): PromptRouteHandle;
  close(handle: PromptRouteHandle): void;
  isConnectionHealthy(): boolean;
  requestPermission(params): Promise<acp.RequestPermissionResponse>;
  sessionUpdate(params): void;
}
```

- `HummingClient` and `PromptCardController` are active-route callbacks, not second ACP clients.

- [ ] **Step 1: RED — entry-time route capture**

Use a deferred callback: enter `sessionUpdate` under prompt A, close A and activate B before the callback resolves, and assert the update still carries A. Verify session metadata goes only to the session delegate.

- [ ] **Step 2: RED — ACP response boundary and protocol violations**

Assert callback messages that enter before the prompt response belong to the current route. After route close, a session update is rejected and marks the connection unhealthy; a permission request immediately returns `{ outcome: { outcome: "cancelled" } }` and marks unhealthy. No callback is assigned to the next prompt by current-token lookup.

- [ ] **Step 3: RED — cancellation ordering**

Keep route active after `session/cancel`, accept trailing updates, cancel unresolved permission requests, and close only when the cancelled prompt response arrives.

- [ ] **Step 4: Implement router and connection construction**

`spawnAndInit({ client: router })` installs exactly this object. Expose unhealthy state so ChatRuntime restarts the connection before another prompt. Do not use a quiescence timer.

- [ ] **Step 5: Verify**

Run router + agent-process tests, build, and Prettier.

- [ ] **Step 6: Review, commit, push**

Commit message: `feat(acp): scope callbacks to protocol prompt turns`.

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

Cover empty-card reuse success; reuse patch failure then one fresh send; fresh send failure; finish/cancel during handoff; stale successful permission send goes through the permission presenter's expiry path (not conversation-card orphan rendering). Assert prompt and permission tokens are retained for callback validation.

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

For each view kind assert exact header presence, footer presence, summary, body, and actions. Specifically assert archived has no header/footer/button; terminal has header/no button; queued/starting no button; orphaned neutral/no button. Only active emits the exact Cancel wire schema `{ v: 2, cancel: true, c, th?, p, s, a }` by combining route and action fields. Permission cards emit `{ v: 2, c, th?, p, q, r, o }`.

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
- Consumes: PromptCardController, PromptCallbackRouter, explicit terminal outcome map.
- Produces: one lifecycle per `PendingMessage`, including queued messages.

- [ ] **Step 1: RED — first, second, and third queued prompts**

Assert first follow-up may transition queued->interrupting->starting; later queued prompts transition queued->starting directly; each retains one card ownership.

- [ ] **Step 2: RED — prompt drain barrier**

After prompt response, close the route. Send a protocol-violating late update and permission request; assert the update is rejected, permission returns cancelled, the connection is quarantined/restarted, and neither is assigned to the next prompt.

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

- [ ] **Step 1: RED — no standalone receipt card and correct reaction lifetime**

For a normal short prompt, assert bridge adds a fixed receipt-only emoji reaction, never directly calls v2 conversation-card send/update, and the runtime creates one authoritative card. Remove the reaction only after the first authoritative send returns a visible card ID, or after terminal when no card was created. Cover first send throwing and returning null: no durable processing card exists and the reaction is removed at terminal. Reaction add/remove failure must not abort the prompt.

- [ ] **Step 2: RED — token-safe Cancel**

Current tokens cancel exactly once. Previous prompt, previous segment, duplicate, legacy tokenless, and unknown-version buttons do not cancel current work and are best-effort neutralized.

- [ ] **Step 3: RED — token-safe permission actions**

Current prompt+permission token resolves exactly once. Previous prompt, previous permission request, duplicate, legacy tokenless, and unknown-version permission actions never resolve the current ACP permission and are best-effort expired.

- [ ] **Step 4: RED — no direct conversation-card bypass**

A source-level assertion scans all `src/` production files for conversation-card send/update calls against an explicit allowlist containing only lifecycle delivery/presenter and the isolated gate-off legacy adapter.

- [ ] **Step 5: Implement cutover code with gate defaulting off**

Switch the complete v2 route to reaction acknowledgement and lifecycle effects, remove v2 direct patches, but leave `features.conversationCardLifecycleV2` default false. Do not enable the persisted gate in this code commit.

- [ ] **Step 6: Verify and commit**

Run all bridge/runtime/ACP/presenter tests, full `npm test`, build, fmt check. Commit: `feat(cards): cut over to semantic lifecycle`.

---

### Task 12: Feature Gate, Schema Status, and Rollback-Safe CLI

**Files:**
- Modify: `templates/home/settings.back.json`
- Modify: `bin/humming.ts`
- Modify: `bin/humming.test.ts`
- Modify: `bin/process-control.ts`
- Modify: `bin/process-control.test.ts`
- Modify: `src/bridge/control-server.ts`
- Modify: `src/bridge/control-server.test.ts`

**Interfaces:**
- Persists `features.conversationCardLifecycleV2`, default false.
- Live status reports `cardActionSchemaVersion: 2` and effective gate state.
- Provides enable/disable operations; rollback operation writes false before stopping/starting the old binary.

- [ ] **Step 1: RED — default-off and compatibility schema**

Assert missing setting means false; status reports schema 2; persisted true is effective only on a schema-2 binary; gate-off keeps legacy behavior.

- [ ] **Step 2: RED — deployment and rollback command ordering**

With fake process control, prove enable refuses unless the running bridge reports schema >= 2. Prove rollback/disable persists false before any stop/start call.

- [ ] **Step 3: Implement configuration and CLI**

Add the minimal settings merge preserving unrelated keys. Gate remains false in templates and existing installations until an explicit command.

- [ ] **Step 4: Verify and commit**

Run CLI/control tests, full suite, build, and format. Commit: `feat(cards): add rollback-safe lifecycle gate`.

---

### Task 13: Gate-Off Deployment, Explicit Enablement, and Real Verification

**Files:**
- Tests may add focused regression fixtures only; no feature expansion.

- [ ] **Step 1: Run deterministic and full quality gates**

```bash
npm test
npm run build
npx tsc -p tsconfig.type-tests.json --noEmit
npm run fmt:check
git diff --check
```

Expected: all pass with no skipped tests or attributable warnings.

- [ ] **Step 2: Independent integration review**

Review one semantic writer, callback protocol attribution, action authority, terminal absorption, immutable snapshots, permission ownership, ToolLedger, receipt removal, schema gate, and rollback ordering. Fix/re-review before deployment.

- [ ] **Step 3: Deploy new binary with gate OFF**

Build and restart. Confirm linked checkout, bridge health, `cardActionSchemaVersion: 2`, and effective gate false. Exercise one legacy short prompt to prove gate-off behavior remains functional.

- [ ] **Step 4: Simulate rollback ordering while gate is off**

Run the rollback/disable command against process-control fakes in automation and one non-destructive local dry-run. Evidence must show settings write false precedes stop/start. Do not actually downgrade the live checkout.

- [ ] **Step 5: Explicitly enable v2 and restart/reload**

Use the new CLI operation, which refuses unless the running bridge reports schema 2. Verify status reports effective gate true after restart/reload.

- [ ] **Step 6: Real short-prompt verification with screenshot evidence**

Send one short prompt. Capture a screenshot showing transient acknowledgement/no stale receipt, exactly one authoritative final Humming card, and no terminal Cancel.

- [ ] **Step 7: Real deterministic long-prompt verification**

Use a controlled mock or prompt that emits more than 10,000 UTF-8 bytes plus multiple tool states, guaranteeing the 8192-byte rotation threshold is crossed. Capture screenshots proving historical cards have no header/footer/Cancel, exactly one current card is actionable, terminal cannot reopen, and no later Waiting appears.

- [ ] **Step 8: Stale action verification**

Click stale Cancel and stale permission fixtures. Verify the current prompt continues/current permission remains unresolved and logs contain bounded rejection diagnostics without sensitive values.

- [ ] **Step 9: Final status**

Confirm `git status --short` clean, local `HEAD == origin/main`, and `humming status` running with schema 2 and gate true.

---

### Deferred Post-Migration Cleanup (separate future plan)

After an explicit observation window and user approval, remove legacy `AgentStatus + cancellable` and gate-off adapter. The initial deployment keeps them for immediate rollback. Never remove Task 1's unknown-version action guard.
