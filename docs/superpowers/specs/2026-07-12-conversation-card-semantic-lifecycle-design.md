# Conversation Card Semantic Lifecycle

**Date:** 2026-07-12

## Context

Humming conversation cards currently combine independent mutable fields such as `status`, `entries`, `meta`, and `cancellable`. Transport ownership is isolated in `ConversationCardDelivery`, but conversation semantics remain distributed across the bridge, `ChatRuntime`, `HummingClient`, the presenter, timers, and card-action routing.

This permits contradictory states that are visible to users:

- an archived card with no header but a live Cancel button;
- several historical cards that all appear actionable;
- a terminal card that is later overwritten by a delayed running render;
- an abandoned or superseded card whose stale Cancel button cancels a newer prompt;
- a Waiting card created after the prompt has already terminated.

The design must make these states unrepresentable, preserve chronological card rotation, and retain the existing transport takeover behavior for rejected Feishu patches.

## Goals

1. Make the semantic lifecycle the single source of truth for card phase, actionability, header, footer, summary, and empty-state rendering.
2. Never create a durable standalone “message received / processing” card that depends on a later patch to become truthful. Use a transient acknowledgement reaction before the first authoritative lifecycle-owned card.
3. Make terminal and archived states monotonic and irreversible.
4. Serialize semantic events so timers, ACP updates, rotation, permission boundaries, cancellation, and finalization cannot race each other.
5. Bind every actionable card to the exact prompt and segment that owns the action.
6. Keep transport ownership and semantic state as separate, focused responsibilities.
7. Route bridge-created starting cards and queued-message cards through explicit lifecycle ownership rather than ad hoc presenter patches.
8. Preserve the current 8192-byte rotation policy and complete-state replay after patch rejection.
9. Add deterministic deferred-transport tests for all previously untested races.

## Non-goals

- Replacing the Feishu card renderer or ACP protocol.
- Persisting in-flight card state across bridge restarts.
- Reliably deleting a card that Feishu no longer accepts patches for.
- Combining permission-card presentation with conversation-card presentation.
- Refactoring unrelated session-control or agent-selection behavior.

## Design principles

### Illegal states must be unrepresentable

The presenter must not accept independently combinable `status` and `cancellable` fields. Actionability is derived from semantic phase and a valid action token.

### One semantic writer

All semantic transitions for one topic runtime are reduced through one ordered event queue. No timer, ACP callback, runtime shutdown path, or bridge helper may mutate conversation-card semantics directly.

### Monotonic lifecycle

Before lifecycle bootstrap completes, Humming may add a transient acknowledgement reaction to the user's message. This is not a card, has no action, and is removed best-effort after the first authoritative card is created or the prompt terminates.

Within one prompt generation, the current segment moves forward while previously archived segments remain immutable historical artifacts:

```text
transient acknowledgement reaction
  -> preparing(segment 1 authoritative card)
  -> active(segment 1)
  -> archive(segment 1) + active(segment 2)
  -> archive(segment 2) + active(segment 3)
  -> terminal(current segment)
```

A permission boundary may temporarily place the prompt in a non-renderable `awaiting_permission` phase between archived and active segments. An archived segment never becomes active again. A terminal prompt never accepts another renderable event. A new active prompt requires a new prompt generation.

### Semantic state and transport ownership are different

- `ConversationCardLifecycle` owns meaning and legal transitions.
- `ConversationCardDelivery` owns active card IDs, serialized patch/send operations, replacement takeover, and stale transport completion handling.
- `LarkCardPresenter` renders an already-valid view model and performs no lifecycle decisions.

## Semantic model

### Prompt and segment identity

```ts
type PromptToken = string & { readonly __brand: "PromptToken" };
type SegmentToken = string & { readonly __brand: "SegmentToken" };
type ActionToken = string & { readonly __brand: "ActionToken" };
```

A prompt receives a fresh `PromptToken`. Every rotated or resumed conversation segment receives a fresh `SegmentToken`. An active segment receives a fresh unguessable `ActionToken` that is revoked before the segment is archived or terminal.

Tokens are never displayed. Logs may include short, non-reversible sequence numbers, but not full chat, thread, or token values.

### Semantic states

```ts
type ConversationCardModel =
  | {
      readonly phase: "starting";
      readonly step: "preparing";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly profile: SessionCardMeta | null;
    }
  | {
      readonly phase: "active";
      readonly activity: "thinking" | "waiting" | "calling_tool" | "responding";
      readonly display: "content" | "idle_slot";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly actionToken: ActionToken;
      readonly entries: readonly ActiveTimelineEntry[];
      readonly profile: SessionCardMeta | null;
    }
  | {
      readonly phase: "archived";
      readonly reason: "rotation" | "permission_boundary" | "idle_rotation";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly entries: readonly ArchivedTimelineEntry[];
    }
  | {
      readonly phase: "terminal";
      readonly outcome: "complete" | "cancelled" | "failed";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken | null;
      readonly entries: readonly TerminalTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly emptyOutput: boolean;
      readonly presentation: "conversation_card" | "permission_card_only";
    };
```

The runtime also has internal, non-renderable `idle` and `awaiting_permission` states. They are not card models because no conversation card is current while the prompt is between segments or no prompt exists.

The lifecycle aggregate stores the current prompt state separately from immutable archived-segment records. `ConversationCardModel` describes one renderable card snapshot; the aggregate may retain archived snapshots for diagnostics but never mutates or re-renders them through the active ownership.

### State invariants

#### Starting

- This is the first authoritative conversation card for a prompt.
- Empty timeline, `preparing` header, and profile snapshot.
- No Cancel action until the prompt is actually forwarded to the Agent.
- It is created by the lifecycle controller, not by a bridge-side standalone receipt path.
- If its first send returns no card ID or fails, the lifecycle retries only on a later semantic transition; there is no stale “processing” card because no prior durable receipt card exists.

#### Active

- The only actionable phase.
- Cancel is derived from `showCancelButton && actionTokenIsCurrent`.
- Always has a status header.
- Profile is captured at prompt/segment creation and is not dynamically reread for archived history.
- `responding` requires at least one text entry in the current segment.
- `calling_tool` requires at least one pending or in-progress tool in the current segment.
- `idle_slot` must have an empty timeline and `activity === "waiting"`.

#### Archived

- Non-empty timeline.
- No header.
- No profile footer.
- No actions.
- Immutable after first successful semantic archive transition.
- May remain externally visible even if a later card becomes active.

#### Terminal

- Absorbing state for its prompt generation.
- Never has actions.
- With `presentation === "conversation_card"`, it has a terminal header, a non-null segment token, and a profile snapshot.
- With `presentation === "permission_card_only"`, the permission artifact is expired/resolved and no extra empty conversation card is created; the segment token is null.
- Any pending or in-progress tool is normalized to `interrupted` or `failed` according to the terminal outcome.
- Late renderable ACP events for the same prompt token are ignored and recorded only as bounded diagnostics.

## Timeline model

Tool transitions are monotonic:

```text
pending -> in_progress -> completed
                       -> failed
                       -> interrupted
```

Terminal tool states never return to a running state. Duplicate tool events update metadata only when they do not violate status monotonicity.

All state snapshots sent to delivery are deeply immutable at the application boundary. Timeline arrays and entries are copied before enqueueing transport work. No later ACP event can mutate an already-enqueued snapshot.

## Event model

All semantic changes enter one per-runtime queue:

```ts
type ConversationCardEvent =
  | {
      type: "prompt_acknowledged";
      promptToken: PromptToken;
      messageId: string;
      acknowledgementReactionId?: string;
    }
  | {
      type: "preparing";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      profile: SessionCardMeta | null;
    }
  | { type: "agent_text"; promptToken: PromptToken; text: string }
  | { type: "agent_thought"; promptToken: PromptToken; text: string }
  | { type: "tool_started"; promptToken: PromptToken; tool: ToolEvent }
  | { type: "tool_updated"; promptToken: PromptToken; tool: ToolEvent }
  | { type: "archive_segment"; promptToken: PromptToken; reason: ArchiveReason }
  | { type: "open_idle_slot"; promptToken: PromptToken; timerGeneration: number }
  | { type: "permission_requested"; promptToken: PromptToken }
  | { type: "permission_resolved"; promptToken: PromptToken }
  | { type: "queued"; promptToken: PromptToken }
  | { type: "interrupting"; promptToken: PromptToken }
  | { type: "finish"; promptToken: PromptToken; outcome: TerminalOutcome };
```

The semantic queue processes one reducer event at a time, but **does not wait for network transport before accepting the next semantic event**. Reduction, token revocation, generation changes, and immutable effect creation are synchronous and ordered. Effects are then submitted to the appropriate delivery ownership generation.

This distinction is required for liveness: a hung Feishu patch must not block `finish`, cancellation, a new segment, or a new prompt. Semantic order is preserved by event sequence and ownership tokens, not by awaiting arbitrary network I/O. Within one still-open ownership generation, Delivery serializes transport effects. Closing a segment uses the atomic close-and-detach operation described below.

Every event carries the prompt token. Events with a stale token are ignored. Segment-scoped events also carry the segment token. Timer events additionally carry a timer generation so a callback that already started cannot create an idle card after cancellation or finalization.

### Terminal priority

When `finish` enters the queue:

1. receive the terminal event at the semantic queue head;
2. revoke the current action token synchronously before any transport wait;
3. invalidate idle/flush generations;
4. transition to terminal and mark the prompt generation absorbing;
5. atomically close the current delivery owner with the immutable terminal view;
6. reject later events for that prompt token.

No reset to a default `thinking` state occurs. The next prompt explicitly creates a new generation.

## Reducer and effect boundary

`ConversationCardLifecycle` exposes intent-oriented methods:

```ts
receivePrompt(...)
markPreparing(...)
startPrompt(...)
applyAgentUpdate(...)
archiveCurrentSegment(...)
openIdleSlot(...)
finishPrompt(...)
```

Internally, these methods enqueue typed events. A pure reducer validates the transition and returns:

```ts
interface TransitionResult {
  readonly next: ConversationLifecycleState;
  readonly effects: readonly CardEffect[];
}
```

Effects are limited to focused operations:

```ts
type CardEffect =
  | { type: "adopt"; cardId: string; owner: OwnershipToken }
  | { type: "render"; view: ConversationCardView; owner: OwnershipToken }
  | { type: "close"; view: ArchivedOrTerminalView; owner: OwnershipToken }
  | { type: "handoff_to_permission"; owner: OwnershipToken }
  | { type: "reconcile_superseded"; cardId: string; fallback: NonActionableView }
  | { type: "revoke_action"; actionToken: ActionToken };
```

`close` is not expressed as separate `render` and `detach` effects. The effect runner atomically captures the old delivery owner, queues the final non-actionable view on that owner, and immediately installs a new detached owner for future effects. Therefore:

- updates reduced before close remain ahead of the close view on the old owner;
- updates reduced after close cannot target the old owner;
- a hung old transport operation cannot head-of-line block the new owner;
- the close transport may fail or time out, but semantic action revocation has already occurred.

This keeps the reducer deterministic and makes all legal state transitions exhaustively testable.

## View derivation

A single pure function converts semantic state to presenter input:

```ts
function deriveConversationCardView(model: ConversationCardModel): ConversationCardView;
```

`ConversationCardView` is itself a discriminated union. It does not contain a free `cancellable` boolean.

```ts
type ConversationCardView =
  | { kind: "receipt"; header: ReceiptHeader; entries: readonly []; route: CardRoute }
  | {
      kind: "active";
      header: ActiveHeader;
      entries: readonly TimelineEntry[];
      profile: SessionCardMeta | null;
      cancelAction?: CancelAction;
      route: CardRoute;
    }
  | {
      kind: "archived";
      entries: readonly [TimelineEntry, ...TimelineEntry[]];
      summary: string;
      route: CardRoute;
    }
  | {
      kind: "terminal";
      header: TerminalHeader;
      entries: readonly TimelineEntry[];
      profile: SessionCardMeta | null;
      emptyOutput: boolean;
      route: CardRoute;
    };
```

Presenter behavior is exhaustive by `kind`:

- only `active` can contain `cancelAction`;
- `archived` has no header/profile/action fields in its type;
- terminal conversation-card views have no action field;
- `permission_card_only` terminal state derives no conversation-card view and instead emits a permission-expiry/resolution effect;
- empty-output rendering is an explicit terminal conversation-card property, not inferred from unrelated booleans.

During migration, the presenter boundary must assert invariants in development/tests and log a concise rejection rather than silently render an invalid model.

## Cancel action safety

The callback payload includes:

```ts
interface CancelActionPayload {
  readonly cancel: true;
  readonly chat: string;
  readonly thread?: string;
  readonly promptToken: string;
  readonly segmentToken: string;
  readonly actionToken: string;
}
```

The bridge routes the action to the topic runtime, then the runtime verifies all three tokens against the current active segment before calling the agent's cancel operation.

Outcomes:

- current token: cancel the current prompt once and revoke the action;
- stale/archived/terminal token: do not cancel anything; best-effort patch the clicked card into a non-actionable expired/archived representation when its message ID is available;
- missing token from legacy cards: treat as stale after the migration release. `/cancel` remains available for intentional topic-level cancellation.

Action revocation is semantic and immediate. Even if Feishu rejects the patch that removes a button, clicking it cannot affect a newer prompt.

## Transport ownership

`ConversationCardDelivery` remains a transport collaborator. It must not inspect semantic phases. It receives immutable `ConversationCardView` snapshots and owns:

- adopted bridge progress-card ID;
- active send/patch serialization;
- patch-rejection abandonment;
- replacement single-flight creation;
- complete-state replay;
- per-lifecycle ownership generation;
- atomic `close(view)` that queues the final view on the old owner and returns a fresh detached owner without awaiting old transport;
- explicit reporting of stale successful sends.

### Superseded sends and abandoned cards

A stale successful send returning a card ID is an external side effect. The lifecycle effect runner must consume `superseded` results and make the returned card non-actionable using a terminal/archived fallback view. It must never silently ignore the ID.

A patch-rejected card may remain visibly stale because Feishu no longer accepts updates. Its action token is nevertheless revoked, so it is visually stale but operationally inert. The replacement becomes authoritative.

### Initial acknowledgement and authoritative first card

The initial acknowledgement must not be a durable card with the text “message received / processing”. Such a card can become permanently misleading when Feishu returns no message ID or rejects its first patch.

The accepted flow is:

1. allocate the prompt token before any user-visible side effect;
2. add a lightweight acknowledgement reaction to the user's message and retain its reaction ID when available;
3. hydrate the prompt and acquire/bootstrap the runtime;
4. let `ConversationCardLifecycle` create the first authoritative `starting/preparing` card;
5. remove the acknowledgement reaction best-effort after the first authoritative card becomes visible or after the prompt reaches terminal without a card.

A failed reaction add/remove is logged but does not affect prompt execution. A leaked reaction is inert and does not state that processing is still active. The bridge never creates a standalone receipt/progress card and never patches a conversation card directly.

For busy follow-ups, a `PendingPromptCardLifecycle` may still create an explicit queued/interrupting card because that message has durable queue semantics. That card must be the same ownership that later becomes active or terminal; the runtime must not leave it queued while creating a second authoritative terminal card.


```text
queued -> interrupting -> active
                    \-> cancelled/failed
```

It uses the same transport ownership primitive and replacement takeover. When the queued prompt becomes active, ownership is explicitly handed to `ConversationCardLifecycle`; no second component may patch the same ID.

Bootstrap failure, queued cancellation, runtime replacement, and shutdown also go through these lifecycle controllers. Direct `presenter.updateUnifiedCard()` calls from bridge/runtime business logic are removed.

## Permission boundary

Permission cards remain separate interactive artifacts because their action model differs from conversation cancellation.

At a permission request:

1. revoke the active Cancel action synchronously;
2. for a non-empty segment, atomically close it with an archived view;
3. for an empty status slot, explicitly hand its card ownership to the permission presenter instead of archiving an empty segment;
4. enter the non-renderable `awaiting_permission` phase;
5. after approval/rejection resolution, create a fresh active segment or terminal state through a semantic event;
6. if the prompt terminates while still awaiting permission, expire/resolve the permission artifact and use `terminal/presentation=permission_card_only`; do not create a phantom empty conversation card.

No `idleStatusCardPending` or `permissionBoundaryThisPrompt` parallel booleans remain. The current phase and explicit handoff result encode the same information.

## Idle status behavior

Idle rotation is represented as a scheduled semantic event, not a direct timer callback mutation.

- Scheduling captures prompt token, segment token, and timer generation.
- Visible content, archive, permission, cancel, and finish invalidate that generation.
- When the timer fires, the event queue revalidates the captured generation.
- A non-empty active segment is archived first, then a fresh `active/waiting/idle_slot` segment is created.
- An initial empty progress card is never rotated merely due to silence.
- A terminal or archived generation cannot open an idle slot.

## Rotation and size budgeting

The existing shared UTF-8 budget remains authoritative:

- rotation threshold: 8192 UTF-8 bytes;
- rotate only at a safe structural boundary;
- archive the current non-empty segment;
- start a new active segment with a new segment/action token;
- emergency hard-limit compaction remains a render guard;
- business paths do not add independent byte or element calculations.

## Failure handling

### Patch rejection

- Delivery abandons the rejected card ID.
- It sends the exact immutable view that failed.
- Later effects for the same still-open ownership generation remain ordered behind takeover.
- A semantic close atomically closes that ownership generation even if takeover is in flight; later segments use a fresh owner immediately.
- If replacement creation fails, no retry loop occurs; a genuinely later transition on the same still-open owner may retry with the newest immutable view.

### Hung transport

Lifecycle generations isolate new prompt/segment ownership from obsolete hung transport. Finalization and shutdown use bounded waits, but action revocation occurs synchronously before waiting. A timed-out external update may leave stale pixels, never stale authority.

### Runtime shutdown or supersede

- enqueue one terminal event for the current prompt;
- revoke actions immediately;
- finalize queued prompt lifecycles;
- reject all later ACP events for obsolete prompt tokens;
- terminate the agent after bounded card delivery.

## Observability

Add structured, non-sensitive diagnostics for every semantic transition and rejected transition:

- runtime-local prompt sequence;
- segment sequence;
- from phase and to phase;
- event type;
- entry count and UTF-8 byte count;
- delivery outcome;
- whether an action was revoked;
- stale-event reason.

Do not log full action tokens, full card contents, chat/thread IDs, local paths, or secrets.

In tests, invariant violations throw. In production, impossible internal transitions are logged and ignored; presenter input is never constructed from them.

## Test strategy

### Pure reducer transition table

Test every legal transition and assert every illegal transition is rejected:

- receipt ordering;
- active activity changes;
- non-empty archive;
- idle-slot creation;
- permission archive/handoff;
- terminal from every live phase;
- terminal absorption;
- stale prompt/segment/timer tokens;
- monotonic tool states.

### View invariants

For every generated view:

- starting views have an empty timeline, a preparing header, and no actions;
- only active views can have a Cancel action;
- archived views have no header, footer, or actions;
- terminal conversation-card views always have a header and no actions;
- permission-card-only terminal states produce no conversation-card view;
- active activity matches timeline content;
- empty-output is possible only for terminal complete;
- archived timeline is non-empty.

Property-based generation should exercise transition sequences and check these invariants after every event.

### Deterministic concurrency tests

Use deferred promises, not sleeps, to cover:

1. running patch blocked, archive requested, later ACP update arrives;
2. terminal patch blocked, late ACP update arrives;
3. idle timer callback entered before finish but queued after finish;
4. multiple render requests while one patch is blocked;
5. patch rejection plus concurrent newer semantic event;
6. replacement send blocked, then archive/finalize;
7. detach/reset while old send never resolves;
8. stale send succeeds after a new lifecycle is active;
9. shutdown timeout while a patch is hung;
10. permission resolution racing cancel or finish;
11. archive close is enqueued behind earlier old-owner renders, then a later event immediately uses a fresh owner without waiting for the old patch;
12. terminal close is enqueued while an old patch never resolves, action revocation remains immediate, and a new prompt can still start;
13. permission handoff races an in-flight render without leaving two owners for the same card ID.

Expected invariant: an externally observed card may be stale after an unrecoverable transport failure, but no stale action token is accepted and no semantic state regresses.

### Action routing tests

- current active token cancels exactly once;
- archived token does not cancel;
- terminal token does not cancel;
- previous prompt token does not cancel the current prompt;
- previous segment token within the same prompt does not cancel the current segment;
- legacy tokenless card does not cancel;
- duplicate click is idempotent;
- clicked stale card is best-effort expired without affecting the current runtime.

### Integration tests

Cover:

- acknowledgement reaction -> lifecycle-owned starting card -> active -> terminal, with no standalone receipt card;
- first authoritative card send fails or returns no ID without leaving any durable “processing” card;
- acknowledgement reaction removal fails without affecting card authority;
- queued follow-up -> interrupting -> active on the same owned card;
- queued cancellation and bootstrap failure;
- long output rotation across multiple archived cards;
- permission before any visible content;
- permission after content;
- idle rotation and reuse;
- patch failure takeover in running and terminal states;
- agent disconnect, explicit cancel, shutdown, supersede, and restart;
- no direct presenter patch path outside lifecycle/presenter infrastructure.

### Real runtime verification

After automated checks:

1. restart the linked development runtime;
2. run both a short prompt and a long, multi-tool prompt that forces several card rotations;
3. verify no standalone “message received / processing” Card exists after either prompt;
4. verify the short prompt has exactly one authoritative Humming Card;
5. verify every historical rotated card has no Cancel button;
6. verify exactly one current card is actionable while the long prompt runs;
7. click an old/expired action fixture and verify the current task continues;
8. finish/cancel and verify no later Waiting or processing card appears;
9. inspect logs for rejected transitions, stale events, patch takeover, and unexpected direct presenter calls.

## Migration plan

### Slice 1: Semantic types and pure derivation

- Introduce semantic model, event types, reducer, and view union.
- Add transition/view invariant tests.
- Keep existing runtime behavior behind an adapter; no production routing changes yet.

### Slice 2: Prompt generation and safe Cancel tokens

- Generate prompt/segment/action tokens.
- Route Cancel through token validation.
- Make legacy/stale buttons inert.
- This is the first deployable safety improvement.

### Slice 3: Ordered HummingClient semantic event queue

- Replace mutable `status`, free `cancellable`, `flushing`, and debounced direct rendering.
- Deep-freeze/copy snapshots at delivery boundary.
- Move ACP updates, archive, idle, permission, and finish into one queue.

### Slice 4: Rotation, idle, and permission handoff

- Migrate safe-boundary rotation.
- Replace idle and permission parallel booleans with explicit states/transitions.
- Preserve current size and permission behavior with deterministic tests.

### Slice 5: Initial acknowledgement and pending-prompt lifecycle

- Replace the standalone initial receipt/progress card with a transient message reaction.
- Let the conversation lifecycle create the first authoritative starting card.
- Introduce pending-prompt lifecycle for queued/interrupting follow-ups.
- Remove direct bridge/runtime conversation-card patches.
- Hand queued-card ownership explicitly into the active conversation lifecycle.

### Slice 6: Superseded/orphan reconciliation and diagnostics

- Consume stale successful send IDs.
- Best-effort neutralize orphan cards.
- Add structured transition/delivery diagnostics and invariant guards.

### Slice 7: Remove compatibility adapter

- Delete legacy `AgentStatus + cancellable` presenter input.
- Make all callers use the semantic view union.
- Search the codebase to prove no direct construction or patch bypass remains.

Each slice requires a failing test first, targeted tests, full tests, build, formatting, independent review, commit, and push before the next slice.

## Acceptance criteria

1. The code cannot construct an archived or terminal card with a Cancel action.
2. A normal non-busy prompt never creates a standalone durable “message received / processing” card; its first card is the lifecycle-owned authoritative starting/active card.
3. A short completed prompt leaves exactly one authoritative Humming Card unless a documented permission or rotation boundary required more.
4. Exactly zero or one card action token is valid per topic runtime; never more than one.
5. A stale Card button cannot cancel a newer prompt or segment.
6. Archived and terminal states cannot regress after delayed ACP, timer, or transport completion.
7. Every card state snapshot is immutable after entering delivery.
8. All conversation-card presenter updates originate from lifecycle infrastructure.
9. Patch rejection preserves replacement takeover without retaining stale authority.
10. All deterministic race, routing, integration, full-suite, build, and formatting checks pass.
11. A real short and multi-rotation Feishu run shows no stale receipt Card, historical cards without Cancel, and no post-terminal Waiting card.
