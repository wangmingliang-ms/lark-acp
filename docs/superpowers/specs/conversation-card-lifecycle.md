# Conversation Card Lifecycle — Canonical Specification

**Status:** Normative source of truth
**Date:** 2026-07-12

This document defines the product semantics for conversation cards. Implementation plans, reducers, routers, delivery code, tests, and older dated design documents are subordinate to this specification. If a new case changes these semantics, update and review this document first; only then change code and tests.

## 1. Domain model

```text
Topic
└── Turn[]
    ├── Request
    └── Response
        └── Card[] (ordered)
```

- A **Turn** is exactly one user `Request` plus its corresponding `Response`.
- A **Response** may be rendered as multiple ordered Cards because content is too long, waiting lasts too long, a permission boundary is crossed, or the current Card must be replaced.
- Every Response with a visible Card has exactly one **tail Card**: the last Card in that Response.
- Every earlier Card in that Response is an **intermediate Card**.
- A Card is only a projection of its Response. Card-local state must never independently decide execution ownership or lifecycle.

## 2. Topic execution ownership

A Topic has at most one **Execution Owner Response**.

```ts
type Topic = {
  turns: Turn[];
  executionOwnerResponseId: ResponseId | null;
};
```

Execution ownership answers only this question:

> Which Response currently owns the Agent execution slot for this Topic?

The newest Turn is not necessarily the Execution Owner. During an interrupt handoff, the new Turn already exists while the previous Response still owns execution until that previous Response is sealed as terminal.

Ownership handoff is always:

```text
old Response -> no owner -> new Response
```

It must never be:

```text
old Response -> old and new Responses simultaneously -> new Response
```

## 3. Response phases

The product-level Response phases are:

```text
received / queued
interrupting
preparing
active
terminal:
  - complete
  - failed
  - interrupted
  - cancelled
  - merged
```

Implementation-only substates may exist, but they must not change the rules in this document.

- `received / queued`: accepted but not taking over execution.
- `interrupting`: this Response is waiting for the current Execution Owner to terminate.
- `preparing`: the previous owner is terminal; this Response is preparing to execute.
- `active`: this Response is the Execution Owner and the Agent is executing it.
- `terminal`: the Response has ended and can never become active again.

## 4. Universal Card projection rules

Let:

```ts
const isTail = card.id === response.tailCardId;
```

Then the canonical projection is:

```ts
showTitle = isTail;
showMetadata = isTail;
showCancel =
  isTail &&
  card.kind === "response" &&
  response.isInProgress &&
  topic.executionOwnerResponseId === response.id;
```

### 4.1 Intermediate Card

Every intermediate Card in a Response is an immutable content artifact:

```text
Title: hidden
Metadata: hidden
Cancel: hidden
Other execution actions: hidden
Content: retained
```

This rule is independent of why the successor Card was created.

### 4.2 Tail Card while non-terminal

The tail Card retains Title and Metadata in all non-terminal phases:

| Response phase                       | Title | Metadata | Cancel |
| ------------------------------------ | ----: | -------: | -----: |
| received / queued                    |   yes |      yes |     no |
| interrupting                         |   yes |      yes |     no |
| preparing                            |   yes |      yes |     no |
| active, not Execution Owner          |   yes |      yes |     no |
| active, Execution Owner              |   yes |      yes |    yes |
| awaiting permission, Execution Owner |   yes |      yes |    yes |

`active, not Execution Owner` should normally be unreachable. If observed, it is an invariant violation and must not render Cancel.

### 4.3 Tail Card after Response termination

The final tail Card retains Title and Metadata for every terminal outcome:

| Outcome     |                                       Title | Metadata | Cancel |
| ----------- | ------------------------------------------: | -------: | -----: |
| complete    |           retained as successful completion | retained |     no |
| failed      |                   retained as failure/error | retained |     no |
| interrupted | retained as interrupted/neutral error state | retained |     no |
| cancelled   |         retained as cancelled/neutral state | retained |     no |
| merged      |  retained as merged-into-next-message state | retained |     no |

A terminal tail is the final status of the Response. It must not be stripped into a plain content Card.

### 4.4 Consequence

For one Response containing Cards `C1, C2, ..., Cn`:

```text
C1 ... C(n-1): no Title, no Metadata, no actions
Cn: Title and Metadata retained
Cn has Cancel only while its Response is in progress, owns execution, and Cn is a Response Card rather than a Permission Card
```

## 5. When a Card is created

### 5.1 First Card of a Response

Create or adopt one lifecycle-owned Card when a Request is accepted as a Response.

- If the Topic is idle, that Card moves in place through `received -> preparing -> active -> terminal`.
- If another Response owns execution, that Card moves in place through `received -> interrupting -> preparing -> active -> terminal`.
- Do not create a standalone durable receipt Card and then create a second task Card for the same Response.
- A transient acknowledgement Reaction may exist before the first authoritative Card is visible, but it is not a Card and owns no action.

### 5.2 Additional Card in the same Response

Create a successor Card only when the same Response requires a new visual segment, for example:

- content length rotation;
- waiting-time/idle rotation;
- permission boundary and continuation;
- a transport replacement only when the current Card itself can no longer receive updates.

A transport replacement caused by a failed patch is not the normal sealing path. See Section 5.3.

The tail handoff is atomic at the semantic layer:

```text
1. Revoke the old tail's action.
2. Make the old tail intermediate:
   - hide Title;
   - hide Metadata;
   - hide all actions.
3. Create/adopt the successor as the new tail.
4. Render Title and Metadata on the new tail.
5. Render Cancel on the new tail only if the Response is in progress and is Execution Owner.
```

There must never be an interval in semantic state where both old and new tails own a valid Cancel action. Transport may complete asynchronously, but stale action tokens must already be invalid.

### 5.3 Feishu rejects a Card update

A Feishu patch rejection is a transport/presentation failure, not a lifecycle transition failure.

When Humming semantically seals or demotes a Card:

```text
1. The domain transition completes immediately.
2. The old action token is revoked immediately.
3. Execution ownership may proceed normally.
4. Humming attempts to patch the old Card projection.
```

If Feishu rejects that patch or the update fails:

- do not roll back the Response transition;
- do not block execution-owner handoff;
- do not create a special no-Cancel mode;
- allow the next valid active Response tail to show its own Cancel normally;
- treat the old visual Cancel as stale; clicking it must be inert and must never cancel the newer Response;
- append a visible informational entry to the following Response tail stating that the previous Card could not be updated and its old Cancel button may remain visible but is no longer valid;
- record the failure as a transport diagnostic.

The resulting Feishu UI may contain a stale visual Cancel button and a current valid Cancel button. This is an accepted external inconsistency caused by Feishu refusing the update, not overlapping semantic ownership. The domain invariant is therefore about valid Cancel authority, not the number of stale buttons still visible in an unpatchable external Card.

## 6. Normal idle-to-complete branch

```text
Topic has no Execution Owner
  -> Request A accepted
  -> Response A created
  -> A tail: received/preparing, no Cancel
  -> executionOwner = A
  -> A active
  -> A tail: Title + Metadata + Cancel
  -> A complete/failed/cancelled
  -> executionOwner = null
  -> A final tail: terminal Title + Metadata, no Cancel
```

If A rotates from `A1` to `A2` while active:

```text
A1 -> intermediate: no Title, no Metadata, no Cancel
A2 -> tail: Title + Metadata + Cancel
```

When A ends, `A2` remains the final tail with terminal Title and Metadata and without Cancel.

## 7. New Request while another Response is active or activating

Suppose Response A is active and owns execution, or has already been admitted as the earliest unfinished Response but is still bootstrapping/preparing. Request B arrives.

Admission ordering—not only `executionOwnerResponseId`—defines whether B is a follow-up. Before A becomes active it is the provisional owner; B must enter `interrupting` and a collecting batch immediately rather than appearing as an independent received Response.

Runtime Agent bootstrap is single-flight per topic. Concurrent enqueues await one bootstrap and must never spawn duplicate Agents. Consecutive pre-activation follow-ups merge exactly like active follow-ups, with only the newest Response retaining carrier authority. A hydrated carrier already present in the Runtime queue satisfies handoff immediately; merged non-carriers are skipped before Agent dispatch.

Streaming text and thought chunks are semantic continuations, not separate visual rows. Adjacent chunks of the same kind on the same Card are coalesced; tool, notice, kind-change, and Card-rotation boundaries end coalescing.

### 7.1 B is accepted immediately

Create/adopt B's first Card immediately and show:

```text
Response B: interrupting
B tail: "message received; interrupting the current Response"
Title: yes
Metadata: yes
Cancel: no
```

At this moment A has not ended:

```text
Response A: active, Execution Owner
A tail: Title + Metadata + Cancel
Response B: interrupting, not owner
B tail: Title + Metadata, no Cancel
```

This temporary two-Card view is legal. Two Cancel buttons are never legal.

### 7.2 Interrupt A

Request interruption of A. Until interruption is confirmed and A is sealed:

- A remains Execution Owner.
- A may retain Cancel on its tail.
- B remains `interrupting` and has no Cancel.
- Agent output from A must only update A.
- B must not receive A's callbacks or become active early.

### 7.3 Seal A, then release ownership

When A's interruption is confirmed:

```text
1. Close A's callback route.
2. Revoke A's action token.
3. Set A terminal outcome to interrupted.
4. Update A's final tail:
   - keep interrupted Title;
   - keep Metadata;
   - remove Cancel.
5. Set executionOwner = null.
```

Late A callbacks are ignored and must never restore a running Title or Cancel.

### 7.4 Start B using the same Card

Do not create another B task Card. Update B's existing tail in place:

```text
B interrupting -> B preparing
B tail: Title + Metadata, no Cancel

executionOwner = B
B preparing -> B active
B tail: Title + Metadata + Cancel
```

The legal ownership sequence is therefore:

```text
A active / B interrupting:
  Cancel owner = A

A interrupted / B preparing:
  Cancel owner = nobody

A interrupted / B active:
  Cancel owner = B
```

### 7.5 Additional Requests during handoff: merge and transfer the carrier Response

Suppose A still owns execution, B is already `interrupting` A, and C arrives before A has been sealed.

B and C must be sent to the Agent together after A is interrupted because C may supplement or correct B. However, every user message still receives immediate visual feedback beneath that message. Therefore the pending input has two related but distinct concepts:

```text
PendingRequestBatch
  messages: ordered [B, C, ...]
  carrierResponseId: the Response associated with the newest message
```

When B first arrives:

```text
batch.messages = [B]
batch.carrierResponseId = Response B
Response B = interrupting
B tail = "message received; interrupting the previous Response"
```

When C arrives before A's interruption completes:

```text
1. Append C to the same ordered batch: [B, C].
2. Seal Response B as terminal(merged).
3. Update B's final tail:
   - keep Title and Metadata;
   - show "merged into the next message";
   - no Cancel.
4. Create Turn C and Response C.
5. Move batch carrier ownership from Response B to Response C.
6. Render C's tail beneath message C:
   - "2 messages received; interrupting the previous Response";
   - Title and Metadata retained;
   - no Cancel.
```

A remains the Execution Owner throughout this collection window. Neither B nor C has Cancel.

If D arrives before A's interruption completes, repeat the same carrier transfer:

```text
batch = [B, C, D]
Response C -> terminal(merged)
Response D -> interrupting and becomes carrier
```

When A is finally sealed:

```text
1. A -> terminal(interrupted); revoke A's Cancel.
2. executionOwner = null.
3. Atomically seal PendingRequestBatch against further appends.
4. Move the current carrier Response (C in [B,C], D in [B,C,D]) to preparing.
5. Forward every batch message to the Agent once, preserving order and message boundaries.
6. Acquire execution ownership for the carrier Response.
7. Move the carrier Response to active and grant Cancel to its tail.
```

The batch collection window closes at the handoff boundary where A has been sealed and the batch is committed for Agent forwarding. A message arriving after that boundary creates a new Turn/Response and follows the normal busy-follow-up rule against the new Execution Owner; it is not appended to the sealed batch.

Required consequences:

- B and C are not independently executed.
- Their message ordering and boundaries are retained when forwarded.
- Every user message has its own Turn, Response, and visible feedback.
- Only the latest Response is the carrier of the still-pending batch.
- Every previous carrier ends as `merged`, not failed, cancelled, or interrupted.
- A `merged` Response never becomes Execution Owner and never shows Cancel.

## 8. Permission boundary

A Permission Card is a permission artifact in the visual timeline; it is not counted in the ordered `ResponseCard[]` used to determine the Response tail. Every permission request creates this sequence:

```text
current Response tail
  -> sealed as an intermediate Response Card
Permission Card
  -> shows the current permission choices
new continuation Response Card
  -> becomes the Response tail immediately
  -> shows waiting-for-permission status, Metadata, and Cancel
```

The Response remains in progress and remains the Topic Execution Owner while waiting for permission. Therefore its continuation tail retains the Response-level Cancel action. The Permission Card independently holds the permission-choice actions. These actions have different scopes:

- Permission actions resolve only the current permission request.
- Cancel terminates the entire Response and expires the current permission request.

The exact transition is:

```text
1. Revoke Cancel from the old Response tail.
2. Demote the old tail to an intermediate Response Card:
   - hide Title;
   - hide Metadata;
   - hide all actions;
   - retain content.
3. Present the Permission Card.
4. Immediately create the continuation Response Card below it.
5. Make the continuation Card the new Response tail.
6. Show Title, Metadata, waiting-for-permission status, and the Response-level Cancel on it.
7. Resolve or expire the Permission Card exactly once.
8. After permission resolution, reuse the same continuation tail for resumed Agent output.
```

If another permission request occurs later, repeat the same transition:

```text
A1 -> P1 -> A2 -> P2 -> A3
```

where `A1` and `A2` are intermediate Response Cards, `A3` is the current continuation tail, and `P1`/`P2` are Permission Cards. Only `A3` holds the Response-level Cancel. Only the current unresolved Permission Card holds permission-choice actions.

If the Response terminates while awaiting permission:

```text
1. Expire the Permission Card and remove its choices.
2. Seal the continuation tail as complete/failed/interrupted/cancelled as appropriate.
3. Retain the continuation tail's terminal Title and Metadata.
4. Remove its Cancel.
```

If the Permission Card cannot be sent or made visible:

```text
1. Revoke the Permission token immediately.
2. Resolve the internal pending Permission as unavailable; do not represent it as a user denial.
3. Stop the Agent execution for this Response.
4. Seal the Response as terminal(failed).
5. Update the continuation tail with a clear failure such as "Permission request could not be displayed; execution failed".
6. Retain the continuation tail's failure Title and Metadata.
7. Remove Cancel and release Execution Ownership.
```

The Response must not continue after an undisplayed mandatory Permission request.

A permission followed immediately by another permission may leave a continuation Card with little or no Agent output. Before demotion, that Card must retain a truthful short status entry so it does not become a blank intermediate Card.

### 8.1 New Request while awaiting permission

If Response A owns execution and is awaiting permission when Request B arrives, B follows the normal busy-follow-up path, with immediate permission revocation:

```text
A1: intermediate Response Card
P1: current Permission Card with choices
A2: continuation tail with waiting status, Metadata, and Cancel
B arrives
```

The transition is:

```text
1. Accept B and render B's interrupting tail without Cancel.
2. Immediately revoke P1's Permission token.
3. Immediately expire/remove P1's permission-choice buttons.
4. Resolve the pending Permission Promise as cancelled.
5. Keep A as Execution Owner until Agent interruption is confirmed.
6. Keep A2's Response-level Cancel valid until A actually terminates.
7. On interruption confirmation, seal A as terminal(interrupted):
   - retain A2's interrupted Title and Metadata;
   - remove A2's Cancel.
8. Release A's Execution Ownership.
9. Start B, or the latest carrier of B's PendingRequestBatch, through preparing -> active.
```

Permission authority is revoked immediately because the new Request expresses intent to replace A. It must not race with the interruption completion. Response-level Cancel authority is different: it remains with A until A actually stops.

If C arrives before A is sealed, the confirmed PendingRequestBatch carrier-transfer rules still apply: B becomes `merged`, C becomes the interrupting carrier, and P1 remains expired.

## 9. Cancellation, failure, disconnect, and late callbacks

All terminal paths use one sealing operation:

```text
1. Close the Response callback route.
2. Revoke its action token.
3. Mark running tools terminal as appropriate.
4. Set terminal outcome.
5. Update only its final tail:
   - retain terminal Title;
   - retain Metadata;
   - remove Cancel.
6. Reject all later renderable callbacks.
```

An old Card's stale visual button must be harmless because its action token has been revoked. An unversioned/tokenless legacy Cancel must never cancel a newer Response.

### 9.1 Response-scoped Card Cancel

A tokenized Cancel button is bound to exactly one Response and its current tail. Consuming it cancels only that Response.

If A owns execution while a PendingRequestBatch `[B, C]` is waiting to take over:

```text
Card Cancel on A
  -> revoke A's Cancel token immediately
  -> request Agent cancellation
  -> keep A as Execution Owner until the Agent actually stops
  -> A terminal(cancelled) after stop confirmation
  -> expire any Permission owned by A
  -> release A's Execution Ownership
  -> preserve [B, C]
  -> current batch carrier C moves preparing -> active
```

The button must not clear, cancel, or otherwise mutate B, C, or any other Response. A stale A token is inert immediately after the click. Execution ownership is released only after A actually stops; pending work must not start concurrently with a still-running A.

### 9.2 Topic-scoped `/cancel`

The explicit `/cancel` command cancels all unfinished work in the Topic:

```text
1. Revoke the current Execution Owner's Cancel and Permission authority immediately, then request Agent cancellation.
2. Keep the current Execution Owner non-terminal and ownership intact until the Agent actually stops.
3. Discard any unsealed PendingRequestBatch immediately.
4. Seal its current carrier and every other waiting Response as cancelled, except former carriers already terminal(merged).
5. After Agent stop confirmation, seal the Execution Owner as cancelled and clear the remaining Topic scheduling state.
```

This command is intentionally broader than a Card Cancel. The UI and tests must keep the two scopes distinct.

## 10. Restart semantics

Restart is intentionally simple and non-durable.

- When restart begins, the current Execution Owner Response is sealed as `interrupted`; its final tail keeps Title and Metadata and loses Cancel.
- Waiting Responses may be abandoned/interrupted without replay.
- Messages arriving during the restart window may be dropped.
- If the old process is still alive and chooses to reply, it may send a non-actionable informational notice saying Humming is restarting and the user should resend later.
- If no process is alive, no response is possible.
- Do not persist, compensate, recover, or replay restart-window Requests.
- A restart notice is not a task Response Card and never has Cancel.

## 11. Compaction and rotation wording

Rotation and content compaction are separate concerns.

- Rotating a Response creates a new tail and demotes the previous tail to an intermediate Card according to Section 5.2.
- If a tool is still pending or running when the tail rotates, its entry in the old tail is normalized once to a truthful sealed marker such as "continues in the next Card".
- The old intermediate Card is immutable after that seal; do not patch it when the tool later changes state.
- A later completion or failure for that tool is rendered once as a compact completion/failure entry in the current tail.
- Do not duplicate the full tool transcript across Cards.
- Compaction copy must describe what was actually compacted:
  - response text -> earlier response content;
  - tool entries -> earlier tool activity;
  - thought entries -> earlier thought activity.
- Tool/thought activity must not be described as hidden response text.
- Compaction must never create another Execution Owner or another actionable Card.

## 12. Reactive state, reconciliation, and bounded retention

Conversation Card rendering is declarative. Business and application logic modify state; they do not choose or sequence Feishu Card API calls.

The required one-way data flow is:

```text
Event / Command
  -> atomic Domain State transition
  -> immutable Snapshot revision
  -> pure Card projection
  -> Reconciler observes dirty desired projections
  -> Feishu send / patch effect
  -> Delivery Result transition
  -> reconciliation continues until settled
```

### 12.1 Layer boundaries

The observable application/presentation store uses **Redux Toolkit**. Redux is used as a general TypeScript state container and does not imply React or React-Redux. `configureStore`, slices, selectors, and listener middleware provide the revisioned immutable Snapshot, subscriptions, and effect wake-ups described below. The Domain Snapshot may contain immutable typed collections such as `ReadonlySet`, so Redux serializability checks may be disabled for that slice; the Delivery Slice itself must remain serializable. Promise workers, timers, abort handles, and transport clients never enter Redux State.

The implementation has four distinct responsibilities:

1. **Domain Aggregate + Redux Domain Slice** — the aggregate enforces Responses, tails, Execution Ownership, Cancel/Permission authority, pending batches, and semantic Card content inside one transaction; the completed immutable Snapshot is committed to Redux as the observable source of truth.
2. **Projection selectors** — pure selectors from the current Redux State plus presentation diagnostics to a desired `ConversationCardView`.
3. **Redux Delivery Slice** — owns Feishu message IDs, desired/delivered revisions, in-flight status, retries, and delivery diagnostics. It is not business authority.
4. **Reconciler listener/effect** — the only writer allowed to send or patch managed V2 Conversation and Permission Cards in Feishu. Redux listener middleware wakes reconciliation after relevant actions; the Reconciler drives remote Cards toward the current desired projections and dispatches delivery results back to Redux. Gate-off legacy writers and best-effort cleanup of an orphaned, unowned legacy Permission Card are explicit compatibility boundaries; they must never write an artifact currently managed by the V2 Store.

Domain commands and ACP callbacks must not call `sendConversationCard` or `updateConversationCard`, directly or through command-specific render branches. They complete after the atomic state transition has been published. A state revision is observable only after all invariants for that transition hold; rotation must never publish an intermediate snapshot with two semantic tails or two valid Cancel authorities. Transactions use copy-on-write aggregates: a command runs against a temporary aggregate hydrated from the last committed Snapshot, replaces the committed aggregate only on success, and publishes only when the resulting Snapshot is semantically different. An exception discards the temporary aggregate completely. Request payloads and other caller-owned mutable values are deeply isolated before entering a committed Snapshot.

Projection must be deterministic:

```text
project(snapshotRevision, cardId, deliveryDiagnostics)
  -> desired Card view
```

Projection does not inspect network requests, mutate the Domain Store, or decide retry timing.

### 12.2 Desired state and delivered state

Every retained delivery record has an explicit convergence target:

```ts
type CardDeliveryRecord = {
  cardId: CardId;
  externalMessageId: string | null;
  desiredRevision: number;
  deliveredRevision: number | null;
  status: "dirty" | "rendering" | "retrying" | "settled" | "failed";
};
```

Equivalent representations are allowed, but these semantics are mandatory:

- state changes mark every affected Card dirty;
- the desired view is read from the latest Snapshot when reconciliation actually runs, not captured before waiting in an effect queue;
- each Card has at most one in-flight writer;
- different Cards may reconcile independently;
- after an effect returns, the Reconciler checks whether the desired revision advanced while the effect was in flight;
- an older successful write never marks a newer desired revision settled;
- if the desired revision advanced, reconciliation continues with a freshly projected view;
- delivery failure does not roll back Domain State or restore authority.

A transport implementation may not treat "one API call was attempted" as equivalent to "the Card is settled".

### 12.3 Delivery failure diagnostics

A failed old-Card patch creates presentation/delivery state, not a new business lifecycle transition. The failure record must identify at least the failed Card and its Response, and whether the current tail has successfully displayed the warning.

```text
old Card patch fails
  -> old Card remains semantically intermediate and its old action remains stale
  -> record a pending delivery diagnostic
  -> mark the current legal tail dirty
  -> project the warning onto that current tail
  -> keep reconciling until the warning is delivered or the tail is replaced
```

The warning follows the Response's current tail across further rotations. It must not be appended to one tail while a stale render request targets another tail. Multiple failures may be represented individually or safely coalesced, but a single mutable global failed-Card slot must not allow one failure to overwrite or strand another.

The visible wording must state that a prior Card could not be updated and that any stale processing title or old button is no longer authoritative.

### 12.4 Bounded active working set

Humming is not an in-memory replica of the complete Feishu Card history. The hot state retains only Cards or artifacts that still have semantic authority or unfinished delivery work.

The retained working set consists of:

- the current Response tail, while live or terminalizing;
- the current unresolved Permission/Approval Card;
- retiring Cards whose final immutable projection is not yet delivery-settled;
- pending delivery diagnostics;
- the minimum current authority and interaction tombstones needed to reject stale actions.

Earlier Card content is not retained merely because it remains visible in Feishu.

The canonical Card retention lifecycle is:

```text
Live
  -> Retiring (semantically immutable, final projection still dirty/in flight)
  -> Delivery-finalized
       -> Settled (final projection successfully delivered)
       OR
       -> Exhausted (bounded retry policy ended; failure retained only as a minimal tombstone/log)
  -> Evicted
```

Failure may compact a Retiring Card into a minimal tombstone/diagnostic after retry policy permits:

```text
Retiring
  -> final patch failed
  -> minimal tombstone + pending warning/retry metadata
  -> warning delivered and no further legal operation remains
  -> Evicted
```

The safe eviction condition is:

```text
semantically immutable
&& final desired projection is delivery-finalized (settled or retry-exhausted)
&& owns no Cancel or Permission authority
&& has no pending diagnostic or retry
```

Therefore:

- semantic `sealed`/`closed` alone is not sufficient for eviction;
- retry exhaustion is not reported as successful delivery, but it may finalize retention after a minimal failure tombstone/log has been recorded;
- having a Title is not sufficient for retention;
- a newly demoted Card without a Title remains retained until its archived projection settles;
- a terminal tail with a Title may be evicted after its terminal projection settles;
- stale-action rejection normally requires only comparison against current authority; historical Card objects are not retained solely to reject old tokens.

Retention must be bounded in steady state. A normal Topic should hold approximately one current tail, zero or one current Permission/Approval Card, and a small set of unsettled retiring records/diagnostics. Implementations must define retry, coalescing, or tombstone compaction so persistent Feishu failures cannot grow memory without bound.

### 12.5 Restart and reconstruction

Restart remains non-durable as specified in Section 10. The Reconciler need not replay arbitrary historical Cards. It reconstructs desired work only from the retained current snapshot and delivery records available in the running process. No design may require a full in-memory Card history for correctness.

## 13. Required invariants

These invariants are mandatory in production and tests:

```text
I1. Every visible Response has exactly one tail Card.
I2. Only a Response tail displays Title and Metadata.
I3. Intermediate Cards display no Title, Metadata, or actions.
I4. A Topic has at most one Execution Owner Response.
I5. Only an in-progress Execution Owner's tail Response Card displays Cancel.
I6. Therefore a Topic has at most one semantically valid Cancel authority; stale visual buttons left by failed Feishu patches do not regain authority.
I7. A current Permission Card may show permission choices while the owner Response's continuation tail independently shows the one Response-level Cancel.
I8. Terminal Responses never accept renderable callbacks.
I9. Ownership handoff is old -> none -> new, never overlapping.
I10. A new Request's interrupting Card is reused for preparing/active; no duplicate task Card.
I11. Terminal final tails retain Title and Metadata for success, failure, interruption, and cancellation.
I12. Every Permission Card is immediately followed by a continuation Response tail; Permission Cards do not participate in Response-tail position.
I13. Failed external patches do not roll back domain state; their stale action tokens remain invalid.
I14. During interrupt handoff, all messages collected before the handoff boundary form one ordered PendingRequestBatch and are forwarded to the Agent once.
I15. The newest message's Response is the batch carrier; every previous carrier terminates as merged.
I16. A tokenized Card Cancel affects only its bound Response; `/cancel` cancels all unfinished work in the Topic.
I17. A new Request immediately revokes any Permission authority owned by the Response it will interrupt, while Response-level Cancel remains valid until that Response stops.
I18. Running tools in a rotated tail are sealed as continuing; their later terminal result is rendered only in the current tail.
I19. If a mandatory Permission Card cannot be shown, its Response fails; the system must not treat the failure as a user denial or continue execution.
I20. Domain/Application commands publish state transitions but never directly sequence Conversation Card send/patch effects.
I21. The Reconciler is the only Conversation Card writer and projects from the latest observable Snapshot when an effect actually runs.
I22. An effect for an older revision never settles a newer desired revision; reconciliation continues until desired and delivered revisions agree.
I23. A failed old-Card patch marks the current legal tail dirty and its warning follows that tail across later rotations until successfully delivered.
I24. A Card is evicted only after it is semantically immutable, delivery-finalized (settled or retry-exhausted), authority-free, and free of pending diagnostics/retries.
I25. Historical Card retention is bounded; stale action rejection does not require retaining all historical Card objects or tokens.
```

## 14. Conformance matrix

| Situation                                    | Previous Response tail                                                             | New Response tail                                                   | Cancel owner                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| Idle Request accepted                        | none                                                                               | received/preparing                                                  | none                                    |
| Response active                              | active Title + Metadata                                                            | none                                                                | active Response                         |
| New Request arrives                          | A active Title + Metadata                                                          | B interrupting Title + Metadata                                     | A only                                  |
| C arrives before A is sealed                 | B becomes merged terminal; batch becomes [B,C]                                     | C interrupting as newest carrier                                    | A only                                  |
| More messages arrive before A is sealed      | each former carrier becomes merged terminal                                        | newest Response carries the growing ordered batch                   | A only                                  |
| A interruption confirmed                     | A interrupted Title + Metadata                                                     | B preparing Title + Metadata                                        | none                                    |
| B starts                                     | A interrupted Title + Metadata                                                     | B active Title + Metadata                                           | B only                                  |
| Same Response rotates                        | old tail becomes plain intermediate; running tools become "continues in next Card" | successor tail Title + Metadata; later tool result appears here     | successor only if owner in progress     |
| Permission requested                         | old tail becomes plain intermediate; Permission Card shows choices                 | continuation tail waiting + Metadata                                | continuation tail                       |
| Consecutive Permission requested             | prior continuation becomes intermediate; next Permission Card shows choices        | next continuation tail waiting + Metadata                           | next continuation tail                  |
| Permission Card send fails                   | old tail remains intermediate; no user decision is fabricated                      | continuation terminal(failed) Title + Metadata                      | none                                    |
| Response ends during Permission              | Permission Card expires; prior Cards unchanged                                     | continuation terminal Title + Metadata                              | none                                    |
| New Request during Permission                | old Permission Card expires immediately; A continuation remains current until stop | B interrupting without Cancel                                       | A until stopped                         |
| Feishu rejects old-tail seal patch           | domain treats old tail as intermediate; stale visual button may remain inert       | current tail is marked dirty and shows warning after reconciliation | current valid owner tail                |
| State changes while Card effect is in flight | older effect may finish but cannot settle the newer desired revision               | Reconciler re-projects latest state and continues                   | determined only by current Domain state |
| Retiring Card final projection settles       | Card is immutable and may be evicted from hot state                                | current tail remains retained only while live/terminalizing         | unchanged                               |
| Response completes                           | final tail complete Title + Metadata                                               | none                                                                | none                                    |
| Response fails                               | final tail failed Title + Metadata                                                 | none                                                                | none                                    |
| Response is cancelled                        | final tail cancelled Title + Metadata                                              | none                                                                | none                                    |
| Card Cancel on A while [B,C] waits           | A cancelled Title + Metadata                                                       | carrier C continues preparing/active                                | C once active                           |
| `/cancel` with unfinished work               | owner and waiting carrier tails become cancelled; merged tails stay merged         | no successor starts                                                 | none                                    |
| Bridge restarts                              | final tail interrupted Title + Metadata                                            | optional non-actionable notice only                                 | none                                    |
| Late callback arrives                        | no change                                                                          | no new Card                                                         | none                                    |

## 15. Change-control rule

This specification is changed before implementation.

For every newly discovered lifecycle case:

1. Add or modify the branch and conformance row in this document.
2. Review the resulting ownership, tail, Title, Metadata, and Cancel behavior.
3. Add failing tests directly from the normative row/invariant.
4. Change the implementation through the single lifecycle writer.
5. Verify the real Feishu path, not only reducer/unit tests.

No implementation patch may introduce a new Card lifecycle branch that is absent from this specification. If implementation details conflict with this document, this document wins until it is explicitly revised.
