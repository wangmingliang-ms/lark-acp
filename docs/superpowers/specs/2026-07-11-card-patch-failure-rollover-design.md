# Conversation Card Rollover and Patch-Failure Recovery

**Date:** 2026-07-11

## Problem

A Feishu conversation card can reject an update with `230099 / ErrCode 11310 / element exceeds the limit` even when the visible text and apparent element count are small. Once a card starts rejecting patches, Humming currently continues patching the same card, producing an error storm and leaving the user-visible card in an obsolete “waiting” state.

The fix must not depend on correctly classifying Feishu's opaque rejection. It must bound normal card growth and recover from the first rejected patch by moving the pending state to a fresh card.

## Requirements

1. Use a fixed conversation-card rotation budget of **8192 UTF-8 bytes**. This replaces the previous 50%-of-hard-limit calculation.
2. When the current card reaches the budget, mark it for rotation and rotate at the next safe structural boundary.
3. On the first `updateUnifiedCard` failure for a card:
   - stop patching that card immediately;
   - mark its message id abandoned in the current conversation lifecycle;
   - create a fresh card;
   - resend the complete card state that failed to patch, not only the most recent delta;
   - route all later updates to the fresh card.
4. Do not repeatedly retry the same failed card.
5. If creating the replacement card also fails, do not loop synchronously. Keep the latest desired state in memory and allow one later update/finalization event to try creating a replacement again.
6. Since Feishu rejected the old card's patch, Humming cannot guarantee that the old card can visibly be marked terminal. Internally it is abandoned; the replacement card becomes authoritative.

## Design

### Shared fixed budget

`src/presenter/card-text-budget.ts` remains the single source of truth for card text measurement and splitting. Define:

```ts
CARD_MARKDOWN_ROTATION_BYTE_LIMIT = 8192;
```

The hard element ceiling remains a separate emergency guard. Business code must continue using the shared UTF-8 helpers rather than `.length` or direct byte-count implementations.

### Card ownership state

`HummingClient` owns the active conversation card. Extend its state so it can distinguish:

- `active`: patches may target the current `cardId`;
- `abandoned`: the current `cardId` rejected a patch and must never be used again;
- `replacement pending`: the latest desired `UnifiedCardState` still needs a new card.

A small generation/epoch token should guard concurrent debounced renders. A late failure from an older request must not abandon a newer card.

### Recovery flow

For each render, Humming builds a complete `UnifiedCardState` before invoking the presenter.

```text
patch active card with desired state
  ├─ success → desired state is visible; continue normally
  └─ failure → atomically abandon that card id
               clear active card id
               retain the same complete desired state
               send a new unified card with that state
                 ├─ success → install new card id as active
                 └─ failure → keep replacement pending; do not loop
```

The failed patch's complete desired state is the replay unit. This avoids reconstructing deltas and preserves all currently retained thought, tool, body, status, cancellability, and footer information.

### Concurrency and retry rules

- Only the first failure for the active card starts takeover.
- In-flight or queued renders that still reference the abandoned card must not patch it.
- Replacement creation is single-flight through the existing card-creation promise or an equivalent recovery promise.
- While replacement creation is in flight, newer renders update the retained desired state. After creation succeeds, render the newest state if it differs from the state used to create the card.
- If replacement creation fails, clear the in-flight promise but retain the newest desired state. The next independent render/finalize call may attempt one new creation. No immediate recursive retry is allowed.
- The existing generic failure notice should not be emitted for every failed patch. If a replacement cannot be created, emit at most one notice for that recovery episode, subject to the notice path itself succeeding.

### Normal 8192-byte rotation

When timeline text reaches 8192 UTF-8 bytes, set the rotation-needed flag. At the next safe boundary:

1. render/seal the current card;
2. clear the active card ownership state;
3. start the next timeline segment on a new card.

This proactive path and the reactive patch-failure takeover share the same “new card owns subsequent state” primitive, but differ in payload:

- proactive rotation starts the new card with the next segment;
- reactive recovery replays the complete state whose patch failed.

## Error handling

- Any patch error is treated as terminal for that card id, regardless of Feishu error code. Reusing a rejected card is less safe than rolling over.
- A failed replacement send is logged with card-state diagnostics, but sensitive content is not dumped verbatim.
- Diagnostics should include card epoch, status, timeline entry count, rendered element count where available, markdown UTF-8 bytes, and serialized card UTF-8 bytes where available.
- Recovery must not cancel or restart the Agent. It only transfers presentation ownership.

## Tests

Add regression tests before production changes:

1. Rotation constant equals 8192 UTF-8 bytes.
2. ASCII below 8192 stays on the same card; reaching 8192 rotates at the next safe boundary.
3. Multibyte text rotates according to UTF-8 bytes.
4. First patch failure sends a replacement card containing the exact complete state that failed to patch.
5. Later updates patch the replacement card and never patch the abandoned card id.
6. Multiple queued/in-flight renders after the first failure create only one replacement card.
7. A late failure from an obsolete card epoch cannot abandon the replacement card.
8. Replacement creation failure does not recurse or spin; the next independent update may retry once with the newest complete state.
9. Finalization after a patch failure produces a replacement terminal card rather than leaving only a waiting card.
10. Failure notices are deduplicated per recovery episode.

## Non-goals

- Determining the exact undocumented internal Feishu limit behind every `11310` response.
- Deleting or reliably patching the abandoned card after Feishu has rejected it.
- Persisting recovery state across a bridge process restart.
- Adding an independent element-count budget in this change.
