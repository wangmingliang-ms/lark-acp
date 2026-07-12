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

## One per-prompt lifecycle

There is one `PromptCardLifecycle` aggregate per accepted user message. It owns that prompt's semantic state from acknowledgement through queued/interrupting/starting/active/awaiting-permission/terminal phases. `ConversationCardModel` variants describe its currently renderable artifact; they are not separate competing controllers.

- A prompt accepted while the runtime is idle skips queued states and moves from transient acknowledgement to starting.
- A prompt accepted while another prompt is active owns one queued card, may move to interrupting if it is the message that triggered acceleration, and later hands the same card ownership into starting/active.
- Second and later queued prompts remain queued; when they reach the head they move directly `queued -> starting -> active` without requiring an interrupting step.
- Exactly one component owns a given card ID. Ownership transfer is an atomic delivery operation, never two controllers patching the same ID.

Queued-state handling is therefore an implementation facet/helper of `PromptCardLifecycle`, not an independent state machine or writer.

## Semantic model

### Prompt and segment identity

```ts
type PromptToken = string & { readonly __brand: "PromptToken" };
type SegmentToken = string & { readonly __brand: "SegmentToken" };
type ActionToken = string & { readonly __brand: "ActionToken" };
type PermissionToken = string & { readonly __brand: "PermissionToken" };
type OwnershipToken = string & { readonly __brand: "OwnershipToken" };
```

A prompt receives a fresh `PromptToken` and allocates its initial `SegmentToken` and profile snapshot as soon as the message is accepted, before acknowledgement, queue rendering, or bootstrap. Every rotated or resumed conversation segment receives a fresh `SegmentToken`. An active segment receives a fresh unguessable `ActionToken` that is revoked before the segment is archived or terminal. Every permission request receives a fresh `PermissionToken`. Every delivery ownership generation receives a fresh `OwnershipToken`.

Tokens are never displayed. Logs may include short, non-reversible sequence numbers, but not full chat, thread, or token values.

### Semantic states

```ts
type ConversationCardModel =
  | {
      readonly phase: "queued" | "interrupting";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly profile: SessionCardMeta | null;
    }
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
      readonly outcome:
        | "complete"
        | "cancelled"
        | "failed"
        | "superseded"
        | "abandoned";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken | null;
      readonly entries: readonly TerminalTimelineEntry[];
      readonly profile: SessionCardMeta | null;
      readonly presentation:
        | { readonly kind: "conversation_card"; readonly body: "content" | "empty_complete" }
        | { readonly kind: "permission_card_only" };
    };
```

The runtime also has internal, non-renderable `idle` and `awaiting_permission` states. They are not card models because no conversation card is current while the prompt is between segments or no prompt exists.

The lifecycle aggregate stores the current prompt state separately from immutable archived-segment records. `ConversationCardModel` describes one renderable card snapshot; the aggregate may retain archived snapshots for diagnostics but never mutates or re-renders them through the active ownership.

### State invariants

#### Queued / Interrupting

- Empty timeline, explicit queue/interrupt header, no profile footer, and no Cancel action.
- Allocate and retain the prompt's initial segment token and profile even though they are not rendered yet. This makes queued cancellation, bootstrap failure, and abandonment valid conversation-card terminal transitions without inventing identity at finish time.
- Own one card ID from first queued render through ownership handoff or terminal failure/cancellation.
- `queued -> interrupting` is optional and only applies to the follow-up that triggered acceleration.
- `queued -> starting` and `interrupting -> starting` are both legal.

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
- With `presentation.kind === "conversation_card"`, it has a terminal header, a non-null segment token, and a profile snapshot. `body === "empty_complete"` is legal only for `outcome === "complete"` with no entries.
- With `presentation.kind === "permission_card_only"`, the permission artifact is expired/resolved and no extra empty conversation card is created; the segment token is null.
- Any pending or in-progress tool is normalized to `interrupted` or `failed` according to the terminal outcome.
- Late renderable ACP events for the same prompt token are ignored and recorded only as bounded diagnostics.

## Timeline model

Tool transitions are monotonic. Agents may omit intermediate states, so the full accepted matrix is:

| Current | Incoming pending | Incoming in_progress | Incoming completed | Incoming failed |
|---|---:|---:|---:|---:|
| absent | create pending | create in_progress | create completed | create failed |
| pending | no-op/metadata | advance | advance | advance |
| in_progress | ignore regression | no-op/metadata | advance | advance |
| completed | ignore regression | ignore regression | metadata only | ignore conflicting terminal |
| failed | ignore regression | ignore regression | ignore conflicting terminal | metadata only |
| interrupted | ignore | ignore | ignore | ignore |

The lifecycle keeps a prompt-level `ToolLedger` keyed by `toolCallId`, separate from any one segment's immutable entries. Rotation or permission archive snapshots the current display entry, but a later tool update advances the ledger. When the next active segment opens, a terminal update for a tool last shown in an archived segment is represented by one compact completion marker in the new segment; archived content is never mutated.

Terminal normalization is explicit:

| Prompt outcome | pending/in_progress tool becomes |
|---|---|
| complete | interrupted (`agent ended before reporting tool completion`) |
| cancelled | interrupted (`prompt cancelled`) |
| failed | failed (`prompt failed`) |
| superseded | interrupted (`runtime superseded`) |
| abandoned/bootstrap failure | failed if tool execution started, otherwise interrupted |

Duplicate or conflicting terminal tool updates are logged and ignored. Terminal tool states never return to running.

Snapshots entering delivery are produced by `structuredClone`, recursively frozen in development/tests, and treated as immutable in production. This includes timeline arrays, every timeline entry, profile metadata, route/action payloads, tool details, and nested permission view data. Delivery tests mutate the source objects after submission and assert that the captured transport snapshot does not change.

### ACP prompt attribution and protocol boundary

ACP `session/update` and `session/request_permission` identify only the ACP session, not the prompt turn. Humming relies on the ACP v1 prompt-turn ordering contract rather than a timing heuristic. The protocol requires all pending updates to be sent before the Agent responds to the original `session/prompt`; after that response, the Client may send the next prompt.

The implementation installs one connection-scoped `PromptCallbackRouter` as the sole `acp.Client` supplied to `ClientSideConnection`:

```ts
interface PromptScopedCallbacks {
  readonly onSessionUpdate: (promptToken: PromptToken, params: acp.SessionNotification) => void;
  readonly onPermissionRequest: (
    promptToken: PromptToken,
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
}

type PromptRoute =
  | { phase: "idle" }
  | { phase: "bootstrap"; mode: "new" | "load" | "resume"; callbacks: BootstrapCallbacks }
  | { phase: "active"; promptToken: PromptToken; callbacks: PromptScopedCallbacks }
  | { phase: "closed"; completedPromptToken: PromptToken };
```

The router also receives a `SessionCallbacks` delegate for filesystem, terminal, and session metadata. Construction is unambiguous: `spawnAndInit({ client: promptCallbackRouter })`; `HummingClient`/`PromptCardController` are callbacks owned by the active route, not a second ACP Client.

ACP `loadSession` is special: it may replay historical `user_message_chunk`, `agent_message_chunk`, thought, plan, and tool notifications before returning. ChatRuntime installs a `bootstrap/load` route before calling `loadSession`. That route consumes replay notifications into bootstrap/session reconstruction only; it never forwards them to a current PromptCardLifecycle or renders new conversation cards. `session_info_update`, mode/config, commands, and usage updates go to `SessionCallbacks`. `newSession` and `resumeSession` use bootstrap routes too, although resume is expected not to replay history. The bootstrap route closes only when the corresponding setup response returns.

Rules:

1. `ChatRuntime` installs a bootstrap route around new/load/resume, closes it on setup response, and installs the active prompt route immediately before `connection.prompt()`.
2. At the synchronous entry of every session-update or permission callback, the router captures the active route object and its prompt token. The callback continues using that captured route even if the prompt response is processed while asynchronous work is pending.
3. The SDK reads JSON-RPC messages in stream order and invokes the handler for an earlier notification/request before processing the later prompt response. The prompt response therefore closes the active route only after every protocol-compliant update/request has entered with the old route captured.
4. Immediately after `connection.prompt()` resolves, Humming atomically closes that route before terminal reduction. The next prompt may then install its route; no quiescence delay guesses attribution.
5. A session update received while idle/closed is a protocol violation: reject it, log a bounded non-sensitive diagnostic, and mark the connection unhealthy so the runtime restarts it before another prompt.
6. A permission request received while idle/closed is also a protocol violation. Return `{ outcome: { outcome: "cancelled" } }` immediately, log it, and mark the connection unhealthy.
7. During explicit cancellation, Humming keeps the route active and accepts trailing updates until the required cancelled prompt response arrives. All unresolved permission requests are synchronously resolved as cancelled, as required by ACP.
8. Humming supports ACP-compliant adapters. It never assigns a callback that entered after route closure to the next prompt merely because that prompt is current.

Tests prove bootstrap replay isolation, session-metadata routing, entry-time active-route capture, response-boundary closure, trailing updates before cancelled response, stale update rejection/connection quarantine, stale permission cancellation, and next-prompt activation only on a healthy route.

## Event model

All semantic changes enter one per-runtime queue:

```ts
type ConversationCardEvent =
  | {
      type: "prompt_acknowledged";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      profile: SessionCardMeta | null;
      messageId: string;
      acknowledgementReactionId?: string;
    }
  | {
      type: "preparing";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      profile: SessionCardMeta | null;
    }
  | { type: "forwarded"; promptToken: PromptToken; segmentToken: SegmentToken; actionToken: ActionToken }
  | { type: "agent_text"; promptToken: PromptToken; segmentToken: SegmentToken; text: string }
  | { type: "agent_thought"; promptToken: PromptToken; segmentToken: SegmentToken; text: string }
  | { type: "tool_started"; promptToken: PromptToken; displaySegmentToken: SegmentToken; tool: ToolEvent }
  | { type: "tool_updated"; promptToken: PromptToken; displaySegmentToken: SegmentToken | null; tool: ToolEvent }
  | {
      type: "archive_segment";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      reason: ArchiveReason;
      nextSegmentToken: SegmentToken;
      nextActionToken: ActionToken;
      nextProfile: SessionCardMeta | null;
    }
  | {
      type: "open_idle_slot";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      timerGeneration: number;
      nextSegmentToken: SegmentToken;
      nextActionToken: ActionToken;
      nextProfile: SessionCardMeta | null;
    }
  | {
      type: "permission_requested";
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      permissionToken: PermissionToken;
      permission: PermissionViewData;
    }
  | {
      type: "permission_resolved";
      promptToken: PromptToken;
      permissionToken: PermissionToken;
      nextSegmentToken: SegmentToken;
      nextActionToken: ActionToken;
      nextProfile: SessionCardMeta | null;
    }
  | { type: "queued"; promptToken: PromptToken }
  | { type: "interrupting"; promptToken: PromptToken }
  | { type: "flush_due"; promptToken: PromptToken; segmentToken: SegmentToken }
  | { type: "acknowledgement_visible"; promptToken: PromptToken; cardId: string }
  | { type: "acknowledgement_terminal_without_card"; promptToken: PromptToken }
  | { type: "acknowledgement_removed"; promptToken: PromptToken }
  | { type: "acknowledgement_remove_failed"; promptToken: PromptToken }
  | { type: "finish"; promptToken: PromptToken; outcome: TerminalOutcome };
```

The semantic queue processes one reducer event at a time, but **does not wait for network transport before accepting the next semantic event**. Reduction, token revocation, generation changes, and immutable effect creation are synchronous and ordered. Effects are then submitted to the appropriate delivery ownership generation.

This distinction is required for liveness: a hung Feishu patch must not block `finish`, cancellation, a new segment, or a new prompt. Semantic order is preserved by event sequence and ownership tokens, not by awaiting arbitrary network I/O. Within one still-open ownership generation, Delivery serializes transport effects. Closing a segment uses the atomic close-and-detach operation described below.

Every event carries the prompt token. Events with a stale token are ignored. Text, thought, archive, idle, forwarded, and flush events are segment-scoped and carry the current segment token. Tool events are prompt-ledger-scoped: they update `ToolLedger` by `toolCallId`; `displaySegmentToken` identifies where a new/compact marker may appear and is null when no active segment exists. Archive/idle/permission-resolution events carry fresh preallocated next segment/action tokens because the pure reducer never generates randomness. Timer events additionally carry a timer generation so a callback that already started cannot create an idle card after cancellation or finalization.

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
  | {
      type: "begin_permission_handoff";
      owner: OwnershipToken;
      promptToken: PromptToken;
      segmentToken: SegmentToken;
      permissionToken: PermissionToken;
      permission: PermissionViewData;
    }
  | { type: "remove_acknowledgement"; promptToken: PromptToken; messageId: string; reactionId: string }
  | { type: "expire_permission"; promptToken: PromptToken; permissionToken: PermissionToken; reason: string }
  | { type: "reconcile_permission_artifact"; cardId: string; promptToken: PromptToken; permissionToken: PermissionToken; reason: string }
  | { type: "reconcile_superseded"; cardId: string; view: Extract<ConversationCardView, { kind: "orphaned" }> }
  | { type: "revoke_action"; actionToken: ActionToken };
```

`reconcile_superseded` always carries the dedicated non-actionable `orphaned` view.

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
  | { kind: "queued" | "interrupting"; header: QueueHeader; entries: readonly []; route: CardRoute }
  | { kind: "starting"; header: StartingHeader; entries: readonly []; profile: SessionCardMeta | null; route: CardRoute }
  | { kind: "orphaned"; header: OrphanHeader; entries: readonly TimelineEntry[]; reason: "superseded_send" | "stale_handoff"; route: CardRoute }
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
      body: "content" | "empty_complete";
      route: CardRoute;
    };
```

Presenter behavior is exhaustive by `kind`:

- queued, interrupting, starting, and orphaned views never contain a Cancel action;
- only `active` can contain `cancelAction`;
- `archived` has no header/profile/action fields in its type;
- terminal conversation-card views have no action field;
- `permission_card_only` terminal state derives no conversation-card view and instead emits a permission-expiry/resolution effect;
- empty-output rendering is an explicit terminal conversation-card property, not inferred from unrelated booleans.

During migration, the presenter boundary must assert invariants in development/tests and log a concise rejection rather than silently render an invalid model.

## Cancel action safety

The callback payload includes a versioned shape:

```ts
interface CancelActionPayloadV2 {
  readonly v: 2;
  readonly cancel: true;
  readonly c: string;
  readonly th?: string;
  readonly p: string;
  readonly s: string;
  readonly a: string;
}
```

`CardRoute` owns `c` and optional `th`; `CancelAction` owns `p`, `s`, and `a`. The Lark renderer is the only place that combines them into the exact wire payload above. No verbose alias is accepted on input.

The bridge routes the action to the topic runtime, then the runtime verifies all three tokens against the current active segment before calling the agent's cancel operation.

Outcomes:

- current token: cancel the current prompt once and revoke the action;
- stale/archived/terminal token: do not cancel anything; best-effort patch the clicked card into a non-actionable expired/archived representation when its message ID is available;
- missing token from legacy cards: treat as stale after the migration release. `/cancel` remains available for intentional topic-level cancellation.

Action revocation is semantic and immediate. Even if Feishu rejects the patch that removes a button, clicking it cannot affect a newer prompt.

## Transport ownership

`ConversationCardDelivery` remains a transport collaborator. It must not inspect semantic phases. It receives immutable `ConversationCardView` snapshots and owns:

- lifecycle-created starting-card ID or queued-card ID;
- active send/patch serialization;
- patch-rejection abandonment;
- replacement single-flight creation;
- complete-state replay;
- per-lifecycle ownership generation;
- atomic `close(view)` that queues the final view on the old owner and returns a fresh detached owner without awaiting old transport;
- explicit reporting of stale successful sends.

### Superseded sends and abandoned cards

A stale successful send returning a card ID is an external side effect. The lifecycle effect runner must consume `superseded` results and patch the returned ID with the dedicated non-actionable `orphaned` view. It must never silently ignore the ID or ambiguously reuse an archived/terminal view.

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

Removal has an explicit feedback path. The Delivery effect runner emits `acknowledgement_visible` only after `send` or replacement takeover returns a non-null authoritative card ID. If the prompt becomes terminal before any visible card exists, the controller emits `acknowledgement_terminal_without_card`. Either event makes the reducer emit exactly one `remove_acknowledgement` effect when a reaction ID exists. The reaction port reports `acknowledgement_removed` or `acknowledgement_remove_failed`; both mark the removal attempt complete, and neither retries in a loop. Merely submitting a render effect never removes the reaction.

For busy follow-ups, the same `PromptCardLifecycle` creates an explicit queued/interrupting view because that message has durable queue semantics. Its delivery ownership later becomes active or terminal; the runtime must not leave it queued while creating a second authoritative terminal card.


```text
queued -> interrupting -> active
                    \-> cancelled/failed
```

It uses the same transport ownership primitive and replacement takeover. When the queued prompt starts, its existing ownership token and card ID remain attached to the same `PromptCardLifecycle`; no second component may patch the ID.

Bootstrap failure, queued cancellation, runtime replacement, and shutdown also go through these lifecycle controllers. Direct `presenter.updateUnifiedCard()` calls from bridge/runtime business logic are removed.

## Permission ownership handoff

Permission cards remain separate interactive artifacts because their action model differs from conversation cancellation. Each request receives a `PermissionToken` stored in the prompt lifecycle; a resolution must match the current prompt and permission token.

Permission action wire payloads use `{ v: 2, c, th?, p, q, r, o }`, where `p` is prompt token, `q` is permission token, `r` is the internal request ID, and `o` is the selected option ID. The renderer combines route and permission action data. Before runtime lookup/ACP resolution, the bridge validates `v`, then the runtime validates both `p` and `q`. Previous-prompt, previous-permission, duplicate, legacy tokenless, and unknown-version permission clicks are inert and best-effort expired.

The reducer never reads or emits a card ID. It emits a semantic `begin_permission_handoff` effect containing the prompt/segment/permission tokens and permission view data. The effect runner performs the transport-owned atomic operation:

```ts
type PermissionHandoffResult =
  | { outcome: "reused"; permissionCardId: string }
  | { outcome: "sent_fresh"; permissionCardId: string }
  | { outcome: "failed" };
```

Protocol:

1. synchronously revoke the active Cancel action and transition the prompt to `awaiting_permission(permissionToken)`;
2. for a non-empty segment, atomically close it with an archived view and send a fresh permission card;
3. for an empty idle/status slot, Delivery atomically takes the active card ID, detaches conversation ownership, and asks the permission presenter to patch that ID;
4. if the reuse patch fails, the ID is abandoned and one fresh permission card is sent; conversation ownership is never restored to that ID;
5. if fresh send also fails, resolve the ACP permission as cancelled and terminalize the prompt according to the resulting agent outcome; do not reopen the old conversation owner;
6. concurrent finish/cancel wins semantically by revoking the permission token. A later handoff completion is stale; any newly returned permission card ID is handled by `reconcile_permission_artifact` through the permission presenter, never by the conversation-card orphan view;
7. approval/rejection callbacks validate prompt token and permission token before resolving the pending ACP request;
8. termination while awaiting permission expires/resolves the permission artifact and uses `terminal/presentation=permission_card_only`; it creates no phantom conversation card.

The prompt-level ToolLedger continues across the boundary. A terminal tool update after permission resolution advances the ledger and appears as a compact completion marker in the newly opened active segment; the archived segment is never modified.

No `idleStatusCardPending` or `permissionBoundaryThisPrompt` parallel booleans remain. The semantic phase plus `PermissionToken` and the handoff result encode the same information.

## Idle status behavior

Idle rotation is represented as a scheduled semantic event, not a direct timer callback mutation.

- Scheduling captures prompt token, segment token, and timer generation.
- Visible content, archive, permission, cancel, and finish invalidate that generation synchronously in semantic state.
- When the timer fires, the reducer revalidates the captured generation before it can create any render effect.
- If the idle event reduced first and its Waiting effect is already queued or hung in transport, a later finish still synchronously closes that ownership generation, revokes authority, and submits terminal on the close barrier. The Waiting effect cannot migrate to the fresh owner or appear after a successfully delivered terminal view.
- A non-empty active segment is archived first, then a fresh `active/waiting/idle_slot` segment is created.
- No empty starting card is rotated merely due to silence.
- A terminal or archived generation cannot open an idle slot.

## Rotation and size budgeting

The existing shared UTF-8 budget remains authoritative:

- rotation threshold: 8192 UTF-8 bytes;
- rotate only at a safe structural boundary;
- archive the current non-empty segment;
- start a new active segment with a new segment/action token;
- emergency hard-limit compaction remains a render guard;
- business paths do not add independent byte or element calculations.

## Render coalescing

Semantic reduction is immediate, but visible active-card rendering remains coalesced to avoid one Feishu patch per text chunk.

- Each open ownership generation keeps `desiredView`, `submittedView`, a monotonic `renderGeneration`, and at most one scheduled flush timer.
- Active text/thought/tool events update `desiredView` and `renderGeneration` synchronously. If no timer exists, schedule one 100 ms `flush_due(promptToken, segmentToken)` event; later updates do not schedule duplicates.
- When that timer fires, it clears the scheduled marker and reads the **current** render generation and desired view. It validates prompt, segment, and ownership, submits that latest immutable snapshot, and records the submitted generation. It does not compare against the generation captured when the timer was originally scheduled.
- If an update arrives after the timer callback cleared the marker but before/during transport submission, it schedules the next timer; therefore the newest desired generation cannot be permanently omitted.
- Archive/permission/terminal synchronously invalidate pending flush generations and submit their close/handoff effects immediately; they never wait for the debounce.
- A timer already queued before terminal becomes a stale event and cannot render Waiting or active state afterward.
- Delivery may coalesce queued active renders to newest-state wins, but it must never coalesce across close, ownership handoff, or terminal barriers.

## Failure handling

### Patch rejection

- Delivery abandons the rejected card ID.
- It sends the exact immutable view that failed.
- Later effects for the same still-open ownership generation remain ordered behind takeover.
- A semantic close atomically closes that ownership generation even if takeover is in flight; later segments use a fresh owner immediately.
- If replacement creation fails, no retry loop occurs; a genuinely later transition on the same still-open owner may retry with the newest immutable view.

### Hung transport

Lifecycle generations isolate new prompt/segment ownership from obsolete hung transport. Finalization and shutdown use bounded waits, but action revocation occurs synchronously before waiting. A timed-out external update may leave stale pixels, never stale authority.

### Runtime shutdown, supersede, and abandonment

Outcome mapping is explicit and does not claim success for administrative replacement:

| Cause | Active/starting prompt | Queued prompt | Awaiting permission |
|---|---|---|---|
| normal end turn | complete | n/a | permission artifact resolved/expired; complete only if the agent returned complete |
| explicit user cancel | cancelled | cancelled | expire permission, then cancelled |
| agent/protocol error | failed | abandoned | expire permission, then failed |
| bridge shutdown/restart | cancelled | abandoned | expire permission, then cancelled |
| session/repo/agent supersede | superseded | abandoned | expire permission, then superseded |
| bootstrap failure | abandoned | abandoned | n/a |

`superseded` renders neutral administrative copy, never a success checkmark. `abandoned` renders that work did not start or could not continue. Shutdown/supersede handling:

- synchronously commit terminal state and revoke actions;
- invalidate pending renders and timers;
- finalize queued prompt lifecycles using the mapping above;
- reject all later ACP events for obsolete prompt routes;
- allow a bounded best-effort card delivery wait;
- terminate the agent without waiting indefinitely for transport.

## Migration and rollback safety

The state-machine migration is not deployed as partially active slices. Implementation may be committed in reviewed steps, but production routing remains behind one `conversationCardLifecycleV2` gate until the complete single-writer path is ready.

Rules:

1. Gate off: all current legacy behavior remains byte-compatible; no v2 action payload is emitted. Gate state is stored in the existing local settings file as `features.conversationCardLifecycleV2`, defaults to `false`, and is read at bridge startup.
2. Gate on: initial acknowledgement, queued/active/terminal rendering, permission handoff, direct bridge/runtime updates, and Cancel routing all switch together to v2 ownership.
3. The v2 action payloads include `v: 2` plus prompt and action-specific tokens. The bridge checks payload version before runtime lookup. A missing/unknown version is stale on the v2 route and never falls through to topic-level cancellation.
4. `/cancel` remains the explicit topic-level operation and is unaffected by card payload versioning.
5. Compatibility is represented by `cardActionSchemaVersion: 2` in the running bridge's local status/control response. Enabling the feature requires both the persisted gate and a running bridge reporting schema >= 2; otherwise startup keeps v2 disabled and logs a fixed diagnostic.
6. Deployment order is mandatory: deploy/restart the new binary with gate false; verify health and schema 2; persist gate true; restart/reload; verify v2. Rollback tooling/steps first persist gate false, then start the old binary. Task 1's guard is backported to every rollback candidate before any v2 enablement.
7. No intermediate commit may have two semantic writers for the same card. Adapter code can construct v2 types for tests, but live presenter calls stay entirely legacy until the final gated cutover.
8. The cutover includes a full-`src/` allowlist assertion that only lifecycle infrastructure and the isolated legacy adapter call conversation-card send/update methods.

Each implementation commit remains independently testable, but only the compatibility guard and final gated cutover are independently deployable behavior changes.

### Diagnostics correlation contract

A single runtime-owned `LifecycleDiagnosticSink` is injected into reducer controller, delivery, router, and acknowledgement runner:

```ts
interface DiagnosticCorrelation {
  readonly runtimeSequence: number;
  readonly promptSequence: number;
  readonly segmentSequence: number | null;
  readonly ownerSequence: number | null;
}
interface LifecycleDiagnosticSink {
  record(event: LifecycleDiagnosticEvent): void;
}
```

It keeps at most 256 structured events per runtime in a ring buffer and streams the same bounded fields to the logger. Transition and delivery events share `runtimeSequence + promptSequence`; segment/owner sequence are local monotonically allocated integers, never tokens or IDs. The controller owns allocation and passes correlation into state/effects/Delivery. Tests join transition and delivery records by these fields and assert no token, card content, chat/thread/message/card ID, path, or secret appears.

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

- queued/starting ordering;
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

Property-style deterministic generation (implemented with a seeded local PRNG, no new dependency) exercises thousands of transition sequences and checks these invariants after every event.

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

Cancel actions:

- current active token cancels exactly once;
- archived token does not cancel;
- terminal token does not cancel;
- previous prompt token does not cancel the current prompt;
- previous segment token within the same prompt does not cancel the current segment;
- legacy tokenless card does not cancel;
- duplicate click is idempotent;
- clicked stale card is best-effort expired without affecting the current runtime.

Permission actions:

- current prompt and permission tokens resolve exactly once;
- previous prompt, previous permission, duplicate, legacy tokenless, and unknown-version clicks do not resolve ACP permission;
- stale permission cards are best-effort expired without touching the current prompt.

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

### Slice 2: Compatibility guard and inert legacy actions

- Reject any versioned Cancel payload before runtime lookup while the v2 route is disabled.
- Keep gate-off legacy rendering byte-compatible.
- Do not emit or accept v2 actions yet.
- This compatibility guard is the first deployable safety improvement and must reach every rollback candidate before v2 enablement.

### Slice 3: Prompt generation and v2 Cancel tokens behind the disabled gate

- Generate prompt/segment/action tokens in v2-only code paths and tests.
- Implement token validation and versioned routing without enabling production v2 rendering.
- Make stale v2 buttons inert in tests; live behavior remains legacy until final cutover.

### Slice 4: Ordered HummingClient semantic event queue

- Replace mutable `status`, free `cancellable`, `flushing`, and debounced direct rendering.
- Deep-freeze/copy snapshots at delivery boundary.
- Move ACP updates, archive, idle, permission, and finish into one queue.

### Slice 5: Rotation, idle, and permission handoff

- Migrate safe-boundary rotation.
- Replace idle and permission parallel booleans with explicit states/transitions.
- Preserve current size and permission behavior with deterministic tests.

### Slice 6: Initial acknowledgement and pending-prompt lifecycle

- Replace the standalone initial receipt/progress card with a transient message reaction.
- Let the conversation lifecycle create the first authoritative starting card.
- Introduce pending-prompt lifecycle for queued/interrupting follow-ups.
- Remove direct bridge/runtime conversation-card patches.
- Hand queued-card ownership explicitly into the active conversation lifecycle.

### Slice 7: Superseded/orphan reconciliation and diagnostics

- Consume stale successful send IDs.
- Best-effort neutralize orphan cards.
- Add structured transition/delivery diagnostics and invariant guards.

### Post-migration cleanup (not part of first deployment)

- After real runtime verification and an explicit observation/rollback window, delete legacy `AgentStatus + cancellable` presenter input in a separate project.
- Until then, gate-off behavior remains available in the new binary as the immediate rollback path.
- Cleanup must not remove the compatibility guard for old/unknown card actions.

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
