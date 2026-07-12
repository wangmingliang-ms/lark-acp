# Card Patch-Failure Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotate conversation cards at a fixed 8192-byte budget and recover from the first rejected patch by replaying the complete desired state to a fresh card without retrying the rejected card.

**Architecture:** Keep `HummingClient` responsible for timeline semantics, but move card ownership, epoch checks, single-flight replacement creation, and replay state into a small focused `ConversationCardDelivery` collaborator. `HummingClient.renderCard()` only builds `UnifiedCardState`, delegates delivery, and schedules idle behavior from the result. This avoids enlarging the existing 1000-line client and gives recovery concurrency a narrow unit-test surface.

**Tech Stack:** TypeScript, Vitest, ACP client, Feishu/Lark presenter interfaces.

## Global Constraints

- The rotation threshold is exactly `8192` UTF-8 bytes.
- Card size consumers use the shared helpers in `src/presenter/card-text-budget.ts`; no local `.length` budget checks or direct byte counting.
- A rejected card id is never patched again in the current delivery lifecycle.
- The failed patch's complete `UnifiedCardState` is replayed to the replacement card.
- Replacement creation is single-flight and never recursively retries after a send failure.
- New code must be split into focused units with descriptive names; do not add another large method to `HummingClient`.
- Keep unrelated existing WIP files out of every commit.
- Follow strict RED → GREEN TDD for each behavior slice.

---

## File Structure

- `src/presenter/card-text-budget.ts`: shared fixed 8192-byte rotation constant and UTF-8 helpers.
- `src/presenter/card-text-budget.test.ts`: threshold and UTF-8 helper tests.
- `src/acp/conversation-card-delivery.ts`: focused card ownership state machine; no timeline logic.
- `src/acp/conversation-card-delivery.test.ts`: deterministic delivery, takeover, concurrency, and retry tests.
- `src/acp/humming-client.ts`: construct card state and delegate transport; retain timeline/rotation/finalization semantics.
- `src/acp/humming-client.test.ts`: integration tests proving replay and terminal UX through the real client boundary.

### Task 1: Fixed 8192-byte rotation budget

**Files:**

- Modify: `src/presenter/card-text-budget.ts:3-7`
- Modify: `src/presenter/card-text-budget.test.ts`
- Modify: `src/acp/humming-client.test.ts:780-845`

**Interfaces:**

- Produces: `CARD_MARKDOWN_ROTATION_BYTE_LIMIT: number` with value `8192`.
- Consumes: existing `utf8ByteLength()` and conversation rotation flow.

- [ ] **Step 1: Write the failing constant and boundary assertions**

Update the budget test:

```ts
it("uses a fixed 8192-byte conversation rotation budget", () => {
  expect(CARD_MARKDOWN_ROTATION_BYTE_LIMIT).toBe(8192);
  expect(CARD_MARKDOWN_ROTATION_BYTE_LIMIT).toBeLessThan(CARD_MARKDOWN_ELEMENT_BYTE_LIMIT);
});
```

Rename the client boundary tests so they describe `8192-byte budget`, not `50%`, and keep these inputs:

```ts
const belowBudget = "A".repeat(CARD_MARKDOWN_ROTATION_BYTE_LIMIT - 1);
const atBudget = "A".repeat(CARD_MARKDOWN_ROTATION_BYTE_LIMIT);
```

Assert below-budget plus a tool remains one card and at-budget plus a tool seals the old card and creates a new one.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run src/presenter/card-text-budget.test.ts src/acp/humming-client.test.ts
```

Expected: FAIL because the current constant is `15000`, not `8192`.

- [ ] **Step 3: Replace the derived threshold with the fixed constant**

In `card-text-budget.ts`:

```ts
/** Rotate conversation cards at the fixed product safety budget. */
export const CARD_MARKDOWN_ROTATION_BYTE_LIMIT = 8_192;
```

Do not change the separate 30,000-byte emergency ceiling.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
npx vitest run src/presenter/card-text-budget.test.ts src/acp/humming-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated budget change**

```bash
git add src/presenter/card-text-budget.ts src/presenter/card-text-budget.test.ts src/acp/humming-client.test.ts
git commit -m "fix(cards): rotate at fixed 8192 byte budget"
```

### Task 2: Extract card delivery ownership into a focused state machine

**Files:**

- Create: `src/acp/conversation-card-delivery.ts`
- Create: `src/acp/conversation-card-delivery.test.ts`

**Interfaces:**

- Consumes:
  - `send(state: UnifiedCardState): Promise<string | null>`
  - `patch(cardId: string, state: UnifiedCardState): Promise<boolean>`
  - optional diagnostic callback `onReplacementSendFailure(error: unknown): void`
- Produces:

```ts
export interface CardDeliveryTransport {
  send(state: UnifiedCardState): Promise<string | null>;
  patch(cardId: string, state: UnifiedCardState): Promise<boolean>;
}

export type CardDeliveryResult =
  { outcome: "visible"; cardId: string } | { outcome: "pending" } | { outcome: "skipped" };

export class ConversationCardDelivery {
  constructor(transport: CardDeliveryTransport);
  deliver(state: UnifiedCardState): Promise<CardDeliveryResult>;
  detach(): void;
  reset(): void;
  hasCard(): boolean;
}
```

Implementation state remains private and small:

```ts
private active: { cardId: string; epoch: number } | null = null;
private epoch = 0;
private creation: Promise<CardDeliveryResult> | null = null;
private latestDesiredState: UnifiedCardState | null = null;
```

- [ ] **Step 1: Write a failing test for first send followed by patch**

```ts
it("sends the first complete state and patches the active card afterward", async () => {
  const transport = makeTransport();
  const delivery = new ConversationCardDelivery(transport);

  await delivery.deliver(state("thinking", "first"));
  await delivery.deliver(state("responding", "second"));

  expect(transport.sends).toEqual([state("thinking", "first")]);
  expect(transport.patches).toEqual([{ cardId: "card-1", state: state("responding", "second") }]);
});
```

- [ ] **Step 2: Run this single test and verify RED**

Run:

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts -t "sends the first complete state"
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal send/patch ownership path**

Create `ConversationCardDelivery` with short private methods:

```ts
async deliver(state: UnifiedCardState): Promise<CardDeliveryResult> {
  this.latestDesiredState = state;
  if (this.creation) return this.creation;
  if (!this.active) return this.createCard();
  return this.patchActiveCard(state, this.active);
}
```

`createCard()` sends once, stores the returned card id with the current epoch, and returns `pending` when send returns `null`.

- [ ] **Step 4: Run the test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write a failing takeover test**

```ts
it("abandons a rejected card and replays the complete failed state to a replacement", async () => {
  const transport = makeTransport({ patchResults: [false] });
  const delivery = new ConversationCardDelivery(transport);
  const initial = state("thinking", "initial");
  const failed = state("responding", "initial + missing output");

  await delivery.deliver(initial);
  await delivery.deliver(failed);

  expect(transport.patches).toEqual([{ cardId: "card-1", state: failed }]);
  expect(transport.sends).toEqual([initial, failed]);
});
```

- [ ] **Step 6: Run takeover test and verify RED**

Run:

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts -t "abandons a rejected card"
```

Expected: FAIL because failed patches do not yet trigger replacement creation.

- [ ] **Step 7: Implement one-way abandonment and replay**

Use a dedicated method, not extra branching in `deliver()`:

```ts
private async patchActiveCard(
  state: UnifiedCardState,
  target: ActiveCard,
): Promise<CardDeliveryResult> {
  const updated = await this.transport.patch(target.cardId, state);
  if (this.active?.epoch !== target.epoch) return { outcome: "skipped" };
  if (updated) return { outcome: "visible", cardId: target.cardId };
  this.abandon(target);
  return this.createCard();
}
```

`abandon()` clears `active` only if the epoch still matches and increments `epoch`, preventing late failures from affecting newer ownership.

- [ ] **Step 8: Run delivery tests and verify GREEN**

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the focused delivery component**

```bash
git add src/acp/conversation-card-delivery.ts src/acp/conversation-card-delivery.test.ts
git commit -m "feat(cards): recover rejected patches on a new card"
```

### Task 3: Make takeover single-flight and safe under concurrent renders

**Files:**

- Modify: `src/acp/conversation-card-delivery.ts`
- Modify: `src/acp/conversation-card-delivery.test.ts`

**Interfaces:**

- Retains the public API from Task 2.
- `detach()` increments the epoch, clears active ownership, and leaves no reusable card id.
- `reset()` clears active ownership, retained desired state, and in-flight state at prompt teardown.

- [ ] **Step 1: Write the failing concurrent takeover test**

Use deferred promises so two calls overlap:

```ts
it("creates one replacement while concurrent renders update the desired state", async () => {
  const patch = deferred<boolean>();
  const replacement = deferred<string | null>();
  const transport = makeTransport({ patchDeferred: patch, replacementDeferred: replacement });
  const delivery = new ConversationCardDelivery(transport);

  await delivery.deliver(state("thinking", "initial"));
  const first = delivery.deliver(state("responding", "failed snapshot"));
  patch.resolve(false);
  const second = delivery.deliver(state("responding", "newest snapshot"));
  replacement.resolve("card-2");
  await Promise.all([first, second]);

  expect(transport.sends).toHaveLength(2);
  expect(transport.patches.filter((x) => x.cardId === "card-1")).toHaveLength(1);
  expect(transport.patches.at(-1)).toEqual({
    cardId: "card-2",
    state: state("responding", "newest snapshot"),
  });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts -t "creates one replacement"
```

Expected: FAIL because replacement creation/newest-state reconciliation is not single-flight.

- [ ] **Step 3: Implement single-flight creation and newest-state reconciliation**

Keep `createCard()` small by splitting creation and reconciliation:

```ts
private createCard(): Promise<CardDeliveryResult> {
  if (this.creation) return this.creation;
  const state = this.latestDesiredState;
  if (!state) return Promise.resolve({ outcome: "skipped" });
  const epoch = ++this.epoch;
  this.creation = this.sendAndInstall(state, epoch).finally(() => {
    this.creation = null;
  });
  return this.creation;
}
```

After `sendAndInstall()` installs the new card, call `patchNewestStateIfChanged(cardId, epoch, sentState)` once. Never patch an obsolete epoch.

- [ ] **Step 4: Run and verify GREEN**

Run all delivery tests. Expected: PASS.

- [ ] **Step 5: Write and verify a late-obsolete-failure regression**

```ts
it("ignores a late failed patch from an obsolete card epoch", async () => {
  const oldPatch = deferred<boolean>();
  const transport = makeTransport({ patchDeferred: oldPatch });
  const delivery = new ConversationCardDelivery(transport);

  await delivery.deliver(state("thinking", "initial"));
  const lateResult = delivery.deliver(state("responding", "old in-flight state"));
  delivery.detach();
  await delivery.deliver(state("responding", "new card state"));
  oldPatch.resolve(false);
  await lateResult;
  await delivery.deliver(state("complete", "new card terminal state"));

  expect(transport.sends).toHaveLength(2);
  expect(transport.patches.at(-1)).toEqual({
    cardId: "card-2",
    state: state("complete", "new card terminal state"),
  });
});
```

Run the single test first and confirm RED, then add only the epoch comparison required to make it GREEN.

- [ ] **Step 6: Write and verify replacement-send failure retry semantics**

```ts
it("does not spin when replacement send fails and retries on the next independent delivery", async () => {
  const transport = makeTransport({ sendResults: ["card-1", null, "card-2"] });
  const delivery = new ConversationCardDelivery(transport);

  await delivery.deliver(state("thinking", "initial"));
  await delivery.deliver(state("responding", "failed patch"));
  expect(transport.sends).toHaveLength(2);

  await delivery.deliver(state("complete", "newest terminal state"));
  expect(transport.sends).toHaveLength(3);
  expect(transport.sends.at(-1)).toEqual(state("complete", "newest terminal state"));
});
```

Run RED, then make `creation` clear after failure while retaining `latestDesiredState`. Do not call `createCard()` recursively.

- [ ] **Step 7: Run all delivery tests and commit**

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts
git add src/acp/conversation-card-delivery.ts src/acp/conversation-card-delivery.test.ts
git commit -m "fix(cards): serialize replacement card takeover"
```

### Task 4: Integrate delivery into HummingClient without growing renderCard

**Files:**

- Modify: `src/acp/humming-client.ts:504-522, 741-751, 859-875, 926-953, 956-1037`
- Modify: `src/acp/humming-client.test.ts:962-990`

**Interfaces:**

- Consumes: `ConversationCardDelivery` from Tasks 2–3.
- Produces: unchanged public `HummingClient` API.
- The presenter adapter is created once in the constructor:

```ts
this.cardDelivery = new ConversationCardDelivery({
  send: (state) => this.presenter.sendUnifiedCard(this.currentMessageId, state),
  patch: (cardId, state) => this.presenter.updateUnifiedCard(cardId, state),
});
```

- [ ] **Step 1: Replace the old notice test with a failing takeover integration test**

Configure the presenter so the first patch returns `false` and later patches succeed:

```ts
it("moves the complete failed update to a replacement card and never reuses the rejected id", async () => {
  const ops: RenderOp[] = [];
  const client = makeClient(ops, { updateResults: [false, true] });

  await client.sessionUpdate(textChunk("hello"));
  await waitForFlush();
  await client.sessionUpdate(textChunk(" world"));
  await waitForFlush();
  await client.sessionUpdate(textChunk("!"));
  await waitForFlush();

  const sends = unifiedSends(ops);
  const patches = unifiedUpdates(ops);
  expect(sends).toHaveLength(2);
  expect(sends[1]?.state.entries).toEqual([{ kind: "text", text: "hello world" }]);
  expect(patches.filter((op) => op.cardId === "card-1")).toHaveLength(1);
  expect(patches.at(-1)).toMatchObject({ cardId: "card-2" });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run src/acp/humming-client.test.ts -t "moves the complete failed update"
```

Expected: FAIL because the client currently emits a notice and retains the rejected card id.

- [ ] **Step 3: Introduce the collaborator and shrink renderCard**

Add one field:

```ts
private readonly cardDelivery: ConversationCardDelivery;
```

Extract state construction:

```ts
private buildUnifiedCardState(cancellable: boolean): UnifiedCardState {
  return {
    status: this.status,
    entries: this.previewEntriesForRender(),
    cancellable: cancellable && this.showCancelButton,
    chatId: this.currentChatId,
    threadId: this.currentThreadId,
    meta: this.metaProvider?.(),
  };
}
```

Keep `renderCard()` orchestration under roughly 25 lines:

```ts
private async renderCard(opts: { cancellable: boolean }): Promise<void> {
  if (!this.currentMessageId && !this.cardDelivery.hasCard()) return;
  this.flushing = true;
  try {
    const state = this.buildUnifiedCardState(opts.cancellable);
    const result = await this.cardDelivery.deliver(state);
    if (result.outcome === "visible") {
      this.scheduleIdleStatusTimer(state.entries, opts.cancellable);
    }
  } finally {
    this.flushing = false;
  }
}
```

Remove `notifyCardUpdateFailure()` and its phase set from the conversation path. Replacement-send failure diagnostics belong in the delivery transport callback, not a repeated user notice.

- [ ] **Step 4: Route lifecycle detach/reset through named methods**

Replace direct `cardId/cardCreating` clearing in segment rotation and status-card transitions with:

```ts
this.cardDelivery.detach(); // old visible card remains, next state starts a new card
```

At prompt teardown:

```ts
this.cardDelivery.reset();
```

If permission-card reuse still needs a raw message id, expose a narrowly named method such as `takeActiveCardId(): string | null`; do not reintroduce ownership fields into `HummingClient`.

- [ ] **Step 5: Run takeover test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Add terminal replay regression**

```ts
it("replays terminal state to a replacement when final patch is rejected", async () => {
  const ops: RenderOp[] = [];
  const client = makeClient(ops, { updateResults: [false] });
  await client.sessionUpdate(textChunk("finished answer"));
  await waitForFlush();
  await client.finalize("complete");

  const replacement = unifiedSends(ops).at(-1);
  expect(replacement?.state).toMatchObject({
    status: "complete",
    cancellable: false,
    entries: [{ kind: "text", text: "finished answer" }],
  });
});
```

Run it first to confirm RED; implement only the lifecycle adjustments needed to pass.

- [ ] **Step 7: Run client and delivery suites and commit**

```bash
npx vitest run src/acp/conversation-card-delivery.test.ts src/acp/humming-client.test.ts
git add src/acp/conversation-card-delivery.ts src/acp/conversation-card-delivery.test.ts src/acp/humming-client.ts src/acp/humming-client.test.ts
git commit -m "fix(cards): hand off rejected updates to replacement cards"
```

### Task 5: Diagnostics, full verification, deployment

**Files:**

- Modify if needed: `src/acp/conversation-card-delivery.ts`
- Modify if needed: `src/acp/conversation-card-delivery.test.ts`
- Modify: `docs/superpowers/specs/2026-07-11-card-patch-failure-rollover-design.md` only if implementation names differ from the approved design.

**Interfaces:**

- Diagnostics callback receives structured metadata only; no timeline body text.

- [ ] **Step 1: Add a failing diagnostic deduplication test**

```ts
it("reports replacement send failure once per failed creation attempt", async () => {
  const failures: unknown[] = [];
  const delivery = new ConversationCardDelivery(transport, {
    onReplacementSendFailure: (error) => failures.push(error),
  });
  // Reject one replacement creation while multiple renders wait on it.
  expect(failures).toHaveLength(1);
});
```

Run RED, then invoke the callback only from the single-flight `sendAndInstall()` catch path.

- [ ] **Step 2: Run focused tests**

```bash
npx vitest run \
  src/presenter/card-text-budget.test.ts \
  src/acp/conversation-card-delivery.test.ts \
  src/acp/humming-client.test.ts \
  src/presenter/lark-presenter.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run repository verification**

```bash
npm test
npm run build
npx prettier --check \
  src/presenter/card-text-budget.ts \
  src/presenter/card-text-budget.test.ts \
  src/acp/conversation-card-delivery.ts \
  src/acp/conversation-card-delivery.test.ts \
  src/acp/humming-client.ts \
  src/acp/humming-client.test.ts
git diff --check
```

Expected: all tests/build/format checks pass. If full-repo formatting sees unrelated WIP, do not format or commit it; keep the check scoped to touched files.

- [ ] **Step 4: Review structure and naming before final commit**

Verify:

- `ConversationCardDelivery` contains transport ownership only.
- No new method is larger than necessary; split `deliver`, `createCard`, `sendAndInstall`, `patchActiveCard`, and epoch checks by responsibility.
- `HummingClient.renderCard()` remains short and contains no retry state machine.
- No duplicate byte-budget calculation exists.
- `git diff --cached --name-only` contains only files from this plan.

- [ ] **Step 5: Commit and push any final diagnostics/document alignment**

```bash
git add src/presenter/card-text-budget.ts src/presenter/card-text-budget.test.ts \
  src/acp/conversation-card-delivery.ts src/acp/conversation-card-delivery.test.ts \
  src/acp/humming-client.ts src/acp/humming-client.test.ts
git commit -m "test(cards): cover replacement takeover failures"
git push origin main
```

If Step 5 has no remaining diff, push the existing task commits without creating an empty commit.

- [ ] **Step 6: Update and verify the running bridge**

```bash
humming update
humming status
git -C ~/.humming/humming-project log -1 --oneline
```

Expected: bridge is running and the managed checkout reports the final implementation commit.

- [ ] **Step 7: Inspect startup logs**

```bash
tail -n 60 ~/.humming/bridge.log
```

Expected: bridge started, WebSocket connected, and no startup error is present.
