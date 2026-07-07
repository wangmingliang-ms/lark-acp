# Compact Slash Session Profile Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add slash-only Feishu commands for Agent/model/mode/permission/profile session-profile control, sharing Humming's existing control semantics and notice-card UX.

**Architecture:** Extend the pure Lark interpreter to classify compact slash commands, then keep bridge command handlers as thin adapters into the existing `controlSetAgent`, `controlSetControls`, and notice-building paths. Add an explicit session-control patch type for `/model auto` so the operation can clear a stored model override without persisting a literal `auto` model id.

**Tech Stack:** TypeScript, Node >=20, Vitest, ACP SDK, Feishu/Lark bridge presenter cards.

## Global Constraints

- Slash-only commands: `/agent <agent>`, `/model <model-id|auto>`, `/mode <mode-id>`, `/permission <alwaysAsk|alwaysAllow|alwaysDeny>`, `/profile`.
- No non-slash aliases, no fuzzy matching, no compound parser in v1.
- Slash commands must never be forwarded to the ACP Agent.
- Slash command success/failure/queued cards must reuse Humming command/control behavior and notice builders.
- `/model auto` means clear explicit model override; never persist `modelId: "auto"`.
- Agent switch is a session boundary and does not migrate hidden conversation history.
- Follow existing strict TypeScript style: no `any`, no unsafe casts outside narrow test helpers, named exports, TDD.
- Run `npm run fmt`, `npm run fmt:check`, `npm run build`, `npm test`, and `git diff --check` before final delivery.

---

### Task 1: Parse compact slash commands

**Files:**
- Modify: `src/interpreter/lark-interpreter.ts`
- Test: `src/interpreter/lark-interpreter.test.ts`

**Interfaces:**
- Produces `LarkCommand` variants:
  - `{ kind: "set-agent"; agent: string }`
  - `{ kind: "set-model"; model: string | "auto" }`
  - `{ kind: "set-mode"; mode: string }`
  - `{ kind: "set-permission"; permissionMode: "alwaysAsk" | "alwaysAllow" | "alwaysDeny" }`
  - `{ kind: "profile" }`

- [ ] **Step 1: Write failing parser tests**

Add tests to `src/interpreter/lark-interpreter.test.ts` after existing command tests:

```ts
describe("interpretLarkMessage — compact session profile commands", () => {
  it("parses slash-only session profile commands", () => {
    expect(expectCommand("/agent copilot")).toEqual({ kind: "set-agent", agent: "copilot" });
    expect(expectCommand("/model gpt-5")).toEqual({ kind: "set-model", model: "gpt-5" });
    expect(expectCommand("/model auto")).toEqual({ kind: "set-model", model: "auto" });
    expect(expectCommand("/mode plan")).toEqual({ kind: "set-mode", mode: "plan" });
    expect(expectCommand("/permission alwaysAllow")).toEqual({
      kind: "set-permission",
      permissionMode: "alwaysAllow",
    });
    expect(expectCommand("/profile")).toEqual({ kind: "profile" });
  });

  it("rejects missing args and lookalikes as prompts so the bridge can show usage only for exact command tokens", () => {
    expect(interpretLarkMessage(textEvent("/agent")).kind).toBe("command");
    expect(expectCommand("/agent")).toEqual({ kind: "profile-command-usage", command: "agent" });
    expect(interpretLarkMessage(textEvent("/agentx copilot")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("agent copilot")).kind).toBe("prompt");
    expect(interpretLarkMessage(textEvent("/model")).kind).toBe("command");
    expect(expectCommand("/model")).toEqual({ kind: "profile-command-usage", command: "model" });
    expect(interpretLarkMessage(textEvent("/profile extra")).kind).toBe("prompt");
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/interpreter/lark-interpreter.test.ts
```

Expected: fails because the new command variants are not implemented.

- [ ] **Step 3: Implement parser support**

In `src/interpreter/lark-interpreter.ts`:

- Add `ProfileCommandName` and `ProfilePermissionMode` string unions.
- Extend `LarkCommand` with the variants above plus `{ kind: "profile-command-usage"; command: ProfileCommandName }`.
- Add constants for `/agent`, `/model`, `/mode`, `/permission`, `/profile`.
- Add a `detectProfileCommand(text)` helper using `stripLeadingToken()`.
- Call it from `detectCommand()` before `/bind`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/interpreter/lark-interpreter.test.ts
```

Expected: all interpreter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter/lark-interpreter.ts src/interpreter/lark-interpreter.test.ts
git commit -m "feat: parse compact session profile slash commands"
git push
```

### Task 2: Add control patch semantics for clearing model overrides

**Files:**
- Modify: `src/session-store/session-store.ts`
- Modify: `src/session-store/file-session-store.ts`
- Modify: `src/session-store/file-session-store.test.ts`
- Modify: `src/bridge/control-server.ts`
- Modify: `bin/humming.ts`

**Interfaces:**
- Add `SessionControlPatch` with `clearModelId?: true`.
- `SessionRecord.pendingControls?: SessionControlPatch`.
- `SessionStore.setControls()` and `setPendingControls()` consume `SessionControlPatch`.
- Persisted `SessionRecord.controls` remains `SessionControls` and never stores `clearModelId`.

- [ ] **Step 1: Write failing store tests**

Add tests to `src/session-store/file-session-store.test.ts`:

```ts
it("clears an explicit model override without persisting a clear marker", async () => {
  const store = new FileSessionStore(dir);
  await store.init();
  await store.save({
    chatId: "oc_x",
    threadId: "th_x",
    sessionId: "s1",
    agentCommand: "node",
    agentArgs: [],
    cwd: dir,
    controls: { modelId: "model-old", modeId: "agent" },
    createdAt: 1,
    updatedAt: 1,
  });

  const updated = await store.setControls(
    { chatId: "oc_x", threadId: "th_x" },
    { clearModelId: true },
  );

  expect(updated.controls).toEqual({ modeId: "agent" });
  expect(updated.controls).not.toHaveProperty("clearModelId");
});

it("queues model clearing as a pending control patch", async () => {
  const store = new FileSessionStore(dir);
  await store.init();
  await store.save({
    chatId: "oc_x",
    threadId: "th_x",
    sessionId: "s1",
    agentCommand: "node",
    agentArgs: [],
    cwd: dir,
    controls: { modelId: "model-old" },
    createdAt: 1,
    updatedAt: 1,
  });

  const updated = await store.setPendingControls(
    { chatId: "oc_x", threadId: "th_x" },
    { clearModelId: true },
  );

  expect(updated.pendingControls).toEqual({ clearModelId: true });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/session-store/file-session-store.test.ts
```

Expected: TypeScript/test failure because `clearModelId` is not accepted and merge does not clear.

- [ ] **Step 3: Implement patch types and merge functions**

Update `src/session-store/session-store.ts`:

```ts
export interface SessionControlPatch {
  readonly modelId?: string;
  readonly clearModelId?: true;
  readonly modeId?: string;
  readonly bridgePermissionMode?: PermissionMode;
  readonly config?: Readonly<Record<string, SessionConfigControlValue>>;
}
```

Change `pendingControls` and store method signatures to `SessionControlPatch`.

Update `mergeControls()` in `file-session-store.ts` to delete `modelId` when `clearModelId` is true, then apply any explicit `modelId`. Add a separate `mergeControlPatches()` for `pendingControls` so queued clears are preserved as patch operations.

Update `src/bridge/control-server.ts` and `bin/humming.ts` types/validation so `setControls` accepts `SessionControlPatch` and CLI JSON accepts `{ "clearModelId": true }`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/session-store/file-session-store.test.ts
npm run build
```

Expected: store tests and TypeScript build pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-store/session-store.ts src/session-store/file-session-store.ts src/session-store/file-session-store.test.ts src/bridge/control-server.ts bin/humming.ts
git commit -m "feat: support clearing session model override"
git push
```

### Task 3: Apply model-clear patches in live runtime notices

**Files:**
- Modify: `src/bridge/chat-runtime.ts`
- Test: `src/bridge/chat-runtime.test.ts`

**Interfaces:**
- `ChatRuntime.applyControls(controls: SessionControlPatch, noticeMessageId?: string): Promise<void>`.
- `renderControlSuccessBody()` includes Model change lines for `clearModelId`.
- Clearing model updates Humming's cached snapshot to no current model and persists controls without `modelId`.

- [ ] **Step 1: Write failing runtime test**

Add to `src/bridge/chat-runtime.test.ts`:

```ts
it("clears an explicit live model override for /model auto without sending literal auto", async () => {
  const fake = makeFakeAgent();
  const setModel = vi.fn(async () => ({}));
  fake.agent.connection = {
    ...fake.agent.connection,
    unstable_setSessionModel: setModel,
  } as AgentProcess["connection"];
  spawnAgentMock.mockResolvedValue(fake.agent);

  let latest: SessionRecord | null = null;
  const saved: SessionRecord[] = [];
  const store: SessionStore = {
    ...stubSessionStore(),
    getLatest: async () => latest,
    save: async (record) => {
      latest = record;
      saved.push(record);
    },
  };
  const notices: Array<{ title: string; body: string; template: string }> = [];
  const runtime = new ChatRuntime({
    ...opts(),
    presenter: recordingPresenter([], notices),
    sessionStore: store,
  });

  await runtime.enqueue({
    prompt: [{ type: "text", text: "hello" }],
    messageId: "om_model_auto",
    chatId: "oc_test",
  });
  fake.resolvePrompt("end_turn");
  await vi.waitFor(() => expect(runtime.processing).toBe(false), { timeout: 1_000, interval: 20 });

  await runtime.applyControls({ clearModelId: true }, "om_model_auto_cmd");

  expect(setModel).not.toHaveBeenCalledWith({ sessionId: "sess_fake", modelId: "auto" });
  expect(runtime.capabilities().models?.currentModelId).toBeUndefined();
  expect(saved.at(-1)?.controls).not.toHaveProperty("modelId");
  expect(notices.at(-1)).toMatchObject({ title: "✅ Session profile 已更新", template: "green" });
  expect(notices.at(-1)?.body).toContain("Model：Old → —");
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/bridge/chat-runtime.test.ts -t "clears an explicit live model override"
```

Expected: fails because `clearModelId` is not applied/displayed.

- [ ] **Step 3: Implement live-runtime clear support**

Update `chat-runtime.ts`:

- Import/use `SessionControlPatch`.
- Accept `noticeMessageId?: string` in `applyControls()` and success/failure helpers.
- `validateControls()` skips ACP model validation when only `clearModelId` is present.
- `applyControlsToState()` handles `clearModelId` by updating the local snapshot to `currentModelId: undefined` without calling `unstable_setSessionModel` with `auto`.
- `persistSession()` merges patch via the new clear-aware helper.
- `controlChangeLines()` includes `clearModelId` in Model changes.
- `hasControls()` returns true for `clearModelId` patches.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/bridge/chat-runtime.test.ts
npm run build
```

Expected: runtime tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/chat-runtime.ts src/bridge/chat-runtime.test.ts
git commit -m "feat: apply model auto as clearing model override"
git push
```

### Task 4: Bridge slash commands to shared control operations

**Files:**
- Modify: `src/bridge/bridge.ts`
- Test: `tests/reception-hot-reload.test.ts`

**Interfaces:**
- Slash command handlers call `controlSetAgent()` and `controlSetControls()` instead of duplicating persistence/notice logic.
- `controlSetControls(chatId, threadId, controls, noticeMessageId?)` anchors slash responses to the command message.
- `/agent` probe failure calls `controlAgentProbeFailed()`.

- [ ] **Step 1: Write failing bridge tests**

Add to `tests/reception-hot-reload.test.ts` internals:

```ts
  routeMessage(
    event: unknown,
    userId: string,
    messageId: string,
    chatId: string,
    threadId: string | null,
  ): Promise<void>;
```

Add tests:

```ts
it("handles /model auto through the shared setControls path and replies to the slash message", async () => {
  bridge = makeBridge({ unboundCwd: home });
  const b = asInternals(bridge);
  await sessionStore.save({
    chatId: "oc_x",
    threadId: "th_topic",
    sessionId: "s1",
    agentCommand: CLAUDE.command,
    agentArgs: [...CLAUDE.args],
    agentLabel: CLAUDE.label,
    cwd: repoA,
    controls: { modelId: "opus", modeId: "default" },
    createdAt: 1,
    updatedAt: 1,
  });

  await b.routeMessage(textEvent("/model auto", "oc_x", "th_topic", "om_model_auto"), "ou_user", "om_model_auto", "oc_x", "th_topic");

  expect(await sessionStore.getLatest("oc_x", "th_topic")).toMatchObject({
    controls: { modeId: "default" },
  });
  const notice = presenter.notices.at(-1);
  expect(notice).toMatchObject({ title: "✅ Session profile 已更新", template: "green" });
  expect(notice?.body).toContain("Model：opus → —");
});
```

Also add `/permission alwaysAllow` and `/profile` tests that assert visible cards and no agent runtime is acquired.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- tests/reception-hot-reload.test.ts -t "/model auto"
```

Expected: fails because slash commands are not routed yet.

- [ ] **Step 3: Implement bridge command handlers**

Update `bridge.ts`:

- Add `set-agent`, `set-model`, `set-mode`, `set-permission`, `profile`, and `profile-command-usage` cases in `handleCommand()`.
- Add `handleSetAgentCommand()` that resolves binding, resolves target agent, probes with `probeAgentSessionCapabilities()`, calls `controlAgentProbeFailed()` on failure, then calls `controlSetAgent()` on success.
- Add `handleSetControlsCommand()` that maps `/model auto` to `{ clearModelId: true }`, `/model id` to `{ modelId: id }`, `/mode id` to `{ modeId: id }`, and `/permission mode` to `{ bridgePermissionMode: mode }`, then calls `controlSetControls(..., messageId)`.
- Add `handleProfileCommand()` that shows a profile notice from live runtime capabilities or stored session record.
- Add usage notice builders for missing arguments.
- Update `controlSetControls()` to accept `noticeMessageId?: string | null` and pass it to `ChatRuntime.applyControls()`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- tests/reception-hot-reload.test.ts
npm run build
```

Expected: bridge tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/bridge.ts tests/reception-hot-reload.test.ts
git commit -m "feat: handle compact session profile slash commands"
git push
```

### Task 5: Update home docs and run full verification

**Files:**
- Modify: `templates/home/AGENTS.md`
- Modify: `src/home-templates.test.ts`

**Interfaces:**
- Home guide documents that explicit slash commands are bridge-native and `/model auto` clears explicit model override.

- [ ] **Step 1: Write failing home-template test**

Add expectations in `src/home-templates.test.ts` that installed `AGENTS.md` contains `/agent <agent>` and `/model auto`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/home-templates.test.ts
```

Expected: fails because docs do not mention compact slash commands.

- [ ] **Step 3: Update template**

Add a section to `templates/home/AGENTS.md`:

```md
## Compact slash commands

If the user sends `/agent <agent>`, `/model <model-id|auto>`, `/mode <mode-id>`, `/permission <alwaysAsk|alwaysAllow|alwaysDeny>`, or `/profile`, Humming handles that message in the bridge and does not forward it to the Agent. Do not reinterpret those slash commands yourself.

`/model auto` means clearing the explicit model override so the Agent uses its own default/automatic model. It is not a literal ACP model id.
```

- [ ] **Step 4: Run full gate**

Run:

```bash
npm run fmt
npm run fmt:check
npm run build
npm test
git diff --check
node dist/bin/humming.js help | grep -E "set-agent|set-control|agent-capabilities"
```

Expected: all pass; grep prints existing command help entries.

- [ ] **Step 5: Restart smoke**

Run:

```bash
humming restart
humming status
```

Expected: bridge restarts and reports running.

- [ ] **Step 6: Commit final docs/fixes**

```bash
git add templates/home/AGENTS.md src/home-templates.test.ts
git commit -m "docs: document compact slash profile commands"
git push
```

## Self-review

- Spec coverage: parser, bridge-native Agent switch, model auto clear, shared command/control UX, failure notices, in-flight queueing, `/profile`, docs, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders are present; all tasks have exact files, commands, and expected outcomes.
- Type consistency: `SessionControlPatch` is introduced before use in runtime/control/bridge tasks; slash commands call existing bridge control operations for sharing.
