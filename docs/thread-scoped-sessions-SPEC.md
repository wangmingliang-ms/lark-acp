# SPEC: Thread-Scoped Sessions (Feishu 话题 → ACP session)

Status: IMPLEMENTED — code + unit tests green (`npm run build`, `npm test` →
61 passed). Awaiting live validation in a real topic (see §9).
Owner: Miller (wangmingliang-ms/lark-acp fork)

This is the deferred "thread-level routing" foreshadowed in
`multi-repo-routing-SPEC.md` §7 ("Routing key is factored as `routeKey(event)`
… To add thread routing later, `routeKey = chatId + ":" + thread_id`"). This
spec records what was actually built.

## 1. Goal

Map Feishu's **topic mode** (话题模式) onto the ACP **session** concept: each
topic (thread) in a bound chat gets its **own** ACP session and its **own**
agent subprocess, fully isolated from the chat's other topics. A message sent
**outside** any topic behaves exactly as before — one "main" conversation per
chat.

## 2. Model (the decisions)

- **Binding stays chat-scoped.** `/bind` / `/unbind` / `/where` and the
  `bindings["<chatId>"]` settings entry are unchanged — a repo+agent is chosen
  per _chat_, and every topic in that chat inherits it. (One repo, many topics,
  many sessions.)
- **Session is thread-scoped, `threadId` nullable.** Runtime + ACP session are
  keyed by `(chatId, threadId)`. `threadId` is `string | null`; `null` = the
  chat's main (non-topic) conversation, identical to pre-topic behaviour. No
  sentinel string — a genuine `null`.
- **Process-per-thread (Option A).** Each `(chatId, threadId)` pair gets its own
  agent subprocess + FIFO queue, same isolation the bridge already gave each
  chat. Concurrency/eviction limits now count `(chatId, threadId)` runtimes.
- **`/new` and `/cancel` are thread-scoped.** They act on the current topic's
  runtime/session only; the chat's other topics keep running. `/new` in a topic
  is effectively "Reset Thread".
- **`/bind` / `/unbind` / rebind are chat-scoped.** Swapping the repo tears down
  **every** topic runtime of the chat and clears **all** its sessions (a new
  repo invalidates every topic's resumable session).

## 3. Routing key

```ts
// src/bridge/bridge.ts
function runtimeKey(chatId: string, threadId: string | null): string {
  return threadId === null ? chatId : `${chatId}\u0000${threadId}`;
}
```

A `null` threadId **collapses to the bare chatId**, so the chat's main
conversation keeps the exact key (and thus the runtime + persisted session) it
had before topic support — zero migration for existing chats. A topic is
namespaced with a `\u0000` (NUL) separator, which never appears in Feishu ids,
so a topic key can never collide with a bare chatId.

## 4. Data flow

1. **Inbound** — `handleMessage` reads `message.thread_id ?? null` (the Lark SDK
   `RawMessageEvent.message.thread_id?: string` field) and threads it through
   `routeMessage → handleCommand | enqueueWithContext → acquireRuntime`.
2. **Runtime** — `acquireRuntime(chatId, threadId, binding)` looks up / creates
   the `ChatRuntime` under `runtimeKey(chatId, threadId)` and passes `threadId`
   into the runtime.
3. **Session bootstrap** — `ChatRuntime` resumes via
   `sessionStore.getLatest(chatId, threadId)` and persists via
   `sessionStore.save({ chatId, threadId, sessionId, … })`.
4. **Cards** — the card payload carries the topic id as `th`; a card action
   reads `value.th ?? null` and looks the runtime up by the same
   `runtimeKey`, so a permission/cancel button resolves against the correct
   per-topic runtime.

## 5. Changed code points

- **`src/session-store/session-store.ts`** — `SessionRecord.threadId:
string | null`; new `listByThread(chatId, threadId)`;
  `getLatest(chatId, threadId)` now topic-filtered; `listByChat` retained for
  chat-wide clears.
- **`src/session-store/file-session-store.ts`** — persists/filters by
  `threadId`; `init()` backfills `threadId: null` on legacy records; legacy
  single-object migration sets `threadId: null`. **Durability fix:** `close()`
  now flushes a pending deferred write synchronously and `scheduleFlush`'s
  `setImmediate` is wrapped in try/catch → stderr — aligned with the sibling
  `FileBindingStore` (previously `close()` was a no-op, losing a
  just-before-exit write and racing temp-dir teardown in tests).
- **`src/bridge/chat-runtime.ts`** — `ChatRuntimeOptions.threadId`; logger child
  tagged with `threadId`; `getLatest` / `save` / `setContext` all pass
  `this.opts.threadId`. (`PendingMessage` deliberately unchanged — the runtime
  is thread-scoped, so `opts.threadId` is authoritative, mirroring `chatId`.)
- **`src/bridge/bridge.ts`** — `runtimeKey` helper; `chats` map re-keyed by it;
  `threadId` threaded through the whole message + card path; `CardActionPayload.th`;
  thread-scoped `teardownThread` / `clearThreadSessions` (for `/new`) vs
  chat-scoped `teardownChat` / `clearChatSessions` (for bind/unbind/rebind, now
  iterating all of a chat's keys); eviction logs `runtime.chatId` / `.threadId`.
- **`src/acp/lark-acp-client.ts`** — tracks `currentThreadId`;
  `setContext(messageId, chatId, threadId)`; feeds `threadId` into the interrupt
  card + `UnifiedCardState`.
- **`src/presenter/presenter.ts`** — `UnifiedCardState.threadId`;
  `sendInterruptCard(…, threadId)`.
- **`src/presenter/lark-presenter.ts`** — `buildPermissionCard` /
  `buildUnifiedCard` add `th` to button payloads **only when non-null**, so
  non-topic cards stay byte-identical to pre-topic ones.

## 6. Backward compatibility

- Existing chats: main-conversation runtime + session key unchanged (`null →
chatId`).
- Existing `sessions.json`: legacy records read back as `threadId: null` (main).
- Existing/in-flight cards without `th`: `?? null` maps them to the main
  conversation.
- `/bind` semantics unchanged (still chat-scoped, still one `bindings` entry).

## 7. Non-goals

- Per-topic _repo_ binding (each topic → different repo). Binding stays
  chat-scoped; all topics share the chat's repo+agent.
- Cross-topic memory / shared context between a chat's topics.
- Changing the concurrency/eviction _policy_ (only the counting unit changed
  from chat to `(chatId, threadId)`).

## 8. Tests

- **`src/session-store/file-session-store.test.ts`** (new, 6 white-box tests):
  `getLatest` topic isolation, `null` for an empty topic, most-recent within a
  topic, `listByThread` vs `listByChat`, `threadId` survives a store reopen,
  legacy records backfill `threadId: null`.
- **`tests/binding-routing.test.ts`** — `handleCommand` gains a `threadId`
  param; call sites pass `null`.
- **`tests/reception-hot-reload.test.ts`** — `acquireRuntime` gains a `threadId`
  param; call sites pass `null`.
- **`src/bridge/chat-runtime.test.ts`** — opts include `threadId: null`.
- Full suite: **61 passed**. (Store `flush failed` stderr lines under the temp
  teardown are the _designed_ caught fallback, not failures.)

## 9. Live validation (pending hand-off)

`handleMessage` still contains a `TEMP(thread-probe)` block that appends every
raw inbound event to `/tmp/lark-acp-thread-probe.jsonl`. Plan:

1. Restart the bridge.
2. Post a message **inside a Feishu topic** (and one outside) in the bound chat.
3. Read the probe file to confirm the real `thread_id` shape and that topic vs
   main route to distinct runtimes/sessions.
4. Remove the `TEMP(thread-probe)` block once confirmed.
