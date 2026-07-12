import { describe, expect, it } from "vitest";
import type {
  ActionToken,
  OwnershipToken,
  PermissionToken,
  PromptToken,
  SegmentToken,
} from "../presenter/conversation-card-view.js";
import {
  createPromptLifecycle,
  reducePromptLifecycle,
  viewForPromptState,
} from "./prompt-card-lifecycle.js";

const promptToken = "prompt-1" as PromptToken;
const segmentToken = "segment-1" as SegmentToken;
const actionToken = "action-1" as ActionToken;
const nextSegmentToken = "segment-2" as SegmentToken;
const nextActionToken = "action-2" as ActionToken;
const ownershipToken = "owner-1" as OwnershipToken;
const permissionToken = "permission-1" as PermissionToken;
const profile = { agent: "copilot", mode: "agent", model: "gpt", permission: "ask" };

function create(initialPhase: "queued" | "interrupting" | "starting" = "queued") {
  return createPromptLifecycle({
    promptToken,
    initialSegmentToken: segmentToken,
    ownershipToken,
    initialPhase,
    profile,
    route: { c: "chat", th: "thread" },
    correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
    acknowledgement: { messageId: "message", reactionId: "reaction" },
  });
}

describe("prompt lifecycle creation and queue transitions", () => {
  it("retains prompt identity, initial segment, profile, route, correlation, and acknowledgement", () => {
    const state = create();

    expect(state).toMatchObject({
      phase: "queued",
      promptToken,
      segmentToken,
      ownershipToken,
      profile,
      route: { c: "chat", th: "thread" },
      correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
      acknowledgement: { phase: "attached", messageId: "message", reactionId: "reaction" },
    });
    expect(viewForPromptState(state)).toEqual({
      kind: "queued",
      header: "queued",
      entries: [],
      route: { c: "chat", th: "thread" },
    });
  });

  it.each(["queued", "interrupting"] as const)("moves %s to starting", (initialPhase) => {
    const result = reducePromptLifecycle(create(initialPhase), {
      type: "preparing",
      promptToken,
      segmentToken,
      profile,
    });

    expect(result.next.phase).toBe("starting");
    expect(viewForPromptState(result.next)?.kind).toBe("starting");
    expect(result.effects).toEqual([
      { type: "render", view: viewForPromptState(result.next), ownershipToken },
    ]);
  });

  it("moves a queued prompt through interrupting without making it actionable", () => {
    const result = reducePromptLifecycle(create(), { type: "interrupting", promptToken });

    expect(result.next.phase).toBe("interrupting");
    expect(viewForPromptState(result.next)).toEqual({
      kind: "interrupting",
      header: "interrupting",
      entries: [],
      route: { c: "chat", th: "thread" },
    });
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.type).toBe("render");
  });

  it("forwards starting into the only actionable active phase", () => {
    const starting = createPromptLifecycle({
      promptToken,
      initialSegmentToken: segmentToken,
      ownershipToken,
      initialPhase: "starting",
      profile,
      route: { c: "chat", th: "thread" },
      correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
    });

    const result = reducePromptLifecycle(starting, {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    });

    expect(result.next).toMatchObject({ phase: "active", activity: "thinking", actionToken });
    expect(viewForPromptState(result.next)).toMatchObject({
      kind: "active",
      header: "thinking",
      cancelAction: { p: promptToken, s: segmentToken, a: actionToken },
    });
  });

  it("coalesces current-segment text and thought while ignoring stale segment content", () => {
    const active = reducePromptLifecycle(
      createPromptLifecycle({
        promptToken,
        initialSegmentToken: segmentToken,
        ownershipToken,
        initialPhase: "starting",
        profile,
        route: { c: "chat", th: "thread" },
        correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
      }),
      { type: "forwarded", promptToken, segmentToken, actionToken },
    ).next;

    const withText = reducePromptLifecycle(active, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "hel",
    }).next;
    const coalesced = reducePromptLifecycle(withText, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "lo",
    }).next;
    const withThought = reducePromptLifecycle(coalesced, {
      type: "agent_thought",
      promptToken,
      segmentToken,
      text: "hmm",
    }).next;
    const stale = reducePromptLifecycle(withThought, {
      type: "agent_text",
      promptToken,
      segmentToken: "old-segment" as SegmentToken,
      text: "ignored",
    });

    expect(viewForPromptState(withThought)).toMatchObject({
      kind: "active",
      header: "responding",
      entries: [
        { kind: "text", text: "hello" },
        { kind: "thought", text: "hmm" },
      ],
    });
    expect(stale.next).toBe(withThought);
    expect(stale.diagnostic.staleReason).toBe("stale_segment");
  });

  it("archives only non-empty active segments and opens the preallocated next segment", () => {
    const active = reducePromptLifecycle(
      createPromptLifecycle({
        promptToken,
        initialSegmentToken: segmentToken,
        ownershipToken,
        initialPhase: "starting",
        profile,
        route: { c: "chat", th: "thread" },
        correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
      }),
      { type: "forwarded", promptToken, segmentToken, actionToken },
    ).next;
    const withText = reducePromptLifecycle(active, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "answer",
    }).next;

    const result = reducePromptLifecycle(withText, {
      type: "archive_segment",
      promptToken,
      segmentToken,
      reason: "rotation",
      nextSegmentToken,
      nextActionToken,
      nextProfile: profile,
    });

    expect(result.next).toMatchObject({
      phase: "active",
      segmentToken: nextSegmentToken,
      actionToken: nextActionToken,
      entries: [],
      archived: [{ reason: "rotation", segmentToken, entries: [{ kind: "text", text: "answer" }] }],
    });
    expect(result.effects).toEqual([
      { type: "revoke_action", actionToken },
      {
        type: "close",
        view: {
          kind: "archived",
          entries: [{ kind: "text", text: "answer" }],
          summary: "answer",
          route: { c: "chat", th: "thread" },
        },
        ownershipToken,
      },
    ]);
  });

  it.each(["complete", "cancelled", "failed", "superseded", "abandoned"] as const)(
    "finishes active as absorbing %s and normalizes running tools",
    (outcome) => {
      const starting = createPromptLifecycle({
        promptToken,
        initialSegmentToken: segmentToken,
        ownershipToken,
        initialPhase: "starting",
        profile,
        route: { c: "chat", th: "thread" },
        correlation: { runtimeSequence: 1, promptSequence: 2, segmentSequence: 3 },
      });
      const active = reducePromptLifecycle(starting, {
        type: "forwarded",
        promptToken,
        segmentToken,
        actionToken,
      }).next;
      const running = reducePromptLifecycle(active, {
        type: "tool_started",
        promptToken,
        displaySegmentToken: segmentToken,
        tool: { toolCallId: "tool", title: "run", toolKind: "shell", status: "in_progress" },
      }).next;

      const finished = reducePromptLifecycle(running, { type: "finish", promptToken, outcome });
      const late = reducePromptLifecycle(finished.next, {
        type: "agent_text",
        promptToken,
        segmentToken,
        text: "late",
      });

      expect(finished.next).toMatchObject({ phase: "terminal", outcome });
      expect(viewForPromptState(finished.next)).toMatchObject({
        kind: "terminal",
        header: outcome,
        entries: [{ kind: "tool", status: outcome === "failed" ? "failed" : "interrupted" }],
      });
      expect(finished.effects[0]).toEqual({ type: "revoke_action", actionToken });
      expect(late.next).toBe(finished.next);
      expect(late.effects).toEqual([]);
      expect(late.diagnostic.staleReason).toBe("terminal_absorbed");
    },
  );

  it("uses content rather than empty-complete presentation for empty non-complete terminals", () => {
    const finished = reducePromptLifecycle(create("starting"), {
      type: "finish",
      promptToken,
      outcome: "failed",
    });

    expect(viewForPromptState(finished.next)).toMatchObject({
      kind: "terminal",
      header: "failed",
      entries: [],
      body: "content",
    });
  });

  it("enforces monotonic prompt-scoped tool transitions including direct and conflicting terminals", () => {
    const active = reducePromptLifecycle(create("starting"), {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    }).next;
    const statuses = ["pending", "in_progress", "completed"] as const;
    let current = active;
    for (const status of statuses) {
      current = reducePromptLifecycle(current, {
        type: status === "pending" ? "tool_started" : "tool_updated",
        promptToken,
        displaySegmentToken: segmentToken,
        tool: { toolCallId: "tool", title: "run", toolKind: "shell", status },
      }).next;
    }
    const duplicate = reducePromptLifecycle(current, {
      type: "tool_updated",
      promptToken,
      displaySegmentToken: segmentToken,
      tool: { toolCallId: "tool", title: "renamed", toolKind: "shell", status: "completed" },
    });
    const conflicting = reducePromptLifecycle(duplicate.next, {
      type: "tool_updated",
      promptToken,
      displaySegmentToken: segmentToken,
      tool: { toolCallId: "tool", title: "bad", toolKind: "shell", status: "failed" },
    });
    const direct = reducePromptLifecycle(conflicting.next, {
      type: "tool_updated",
      promptToken,
      displaySegmentToken: segmentToken,
      tool: { toolCallId: "direct", title: "direct", toolKind: "shell", status: "failed" },
    });

    expect(duplicate.next.toolLedger.tool?.title).toBe("renamed");
    expect(conflicting.next).toBe(duplicate.next);
    expect(conflicting.diagnostic.staleReason).toBe("conflicting_terminal");
    expect(direct.next.toolLedger.direct?.status).toBe("failed");
  });

  it("places cross-segment completion in the new segment without mutating archived history", () => {
    const active = reducePromptLifecycle(create("starting"), {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    }).next;
    const running = reducePromptLifecycle(active, {
      type: "tool_started",
      promptToken,
      displaySegmentToken: segmentToken,
      tool: { toolCallId: "tool", title: "run", toolKind: "shell", status: "in_progress" },
    }).next;
    const rotated = reducePromptLifecycle(running, {
      type: "archive_segment",
      promptToken,
      segmentToken,
      reason: "rotation",
      nextSegmentToken,
      nextActionToken,
      nextProfile: profile,
    }).next;
    const completed = reducePromptLifecycle(rotated, {
      type: "tool_updated",
      promptToken,
      displaySegmentToken: nextSegmentToken,
      tool: { toolCallId: "tool", title: "run", toolKind: "shell", status: "completed" },
    }).next;

    expect(completed.archived[0]?.entries).toMatchObject([{ status: "interrupted" }]);
    expect(viewForPromptState(completed)).toMatchObject({
      kind: "active",
      entries: [{ kind: "tool", toolCallId: "tool", status: "completed" }],
    });
  });

  it("keeps one flush marker, flushes the latest generation, then schedules subsequent updates", () => {
    const active = reducePromptLifecycle(create("starting"), {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    }).next;
    const first = reducePromptLifecycle(active, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "a",
    });
    const second = reducePromptLifecycle(first.next, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "b",
    });
    const flush = reducePromptLifecycle(second.next, {
      type: "flush_due",
      promptToken,
      segmentToken,
    });
    const after = reducePromptLifecycle(flush.next, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "c",
    });

    expect(first.effects).toEqual([{ type: "schedule_flush", promptToken, segmentToken }]);
    expect(second.effects).toEqual([]);
    expect(flush.effects).toMatchObject([
      { type: "render", generation: 2, view: { entries: [{ text: "ab" }] } },
    ]);
    expect(after.effects).toEqual([{ type: "schedule_flush", promptToken, segmentToken }]);
  });

  it("removes acknowledgement exactly once across visible/finish races and accepts only removal feedback after terminal", () => {
    const attached = create("starting");
    const visible = reducePromptLifecycle(attached, {
      type: "acknowledgement_visible",
      promptToken,
      cardId: "card",
    });
    const finishedAfterVisible = reducePromptLifecycle(visible.next, {
      type: "finish",
      promptToken,
      outcome: "complete",
    });
    const lateVisible = reducePromptLifecycle(finishedAfterVisible.next, {
      type: "acknowledgement_visible",
      promptToken,
      cardId: "late-card",
    });
    const removed = reducePromptLifecycle(finishedAfterVisible.next, {
      type: "acknowledgement_removed",
      promptToken,
    });

    expect(visible.effects).toEqual([
      {
        type: "remove_acknowledgement",
        promptToken,
        messageId: "message",
        reactionId: "reaction",
      },
    ]);
    expect(
      finishedAfterVisible.effects.filter((effect) => effect.type === "remove_acknowledgement"),
    ).toEqual([]);
    expect(lateVisible.effects).toEqual([]);
    expect(lateVisible.diagnostic.staleReason).toBe("terminal_absorbed");
    expect(removed.next).toMatchObject({
      phase: "terminal",
      acknowledgement: { phase: "removal_attempted", outcome: "removed" },
    });

    const finishFirst = reducePromptLifecycle(create("starting"), {
      type: "finish",
      promptToken,
      outcome: "abandoned",
    });
    expect(
      finishFirst.effects.filter((effect) => effect.type === "remove_acknowledgement"),
    ).toHaveLength(1);
    const failedRemoval = reducePromptLifecycle(finishFirst.next, {
      type: "acknowledgement_remove_failed",
      promptToken,
    });
    expect(failedRemoval.next).toMatchObject({
      phase: "terminal",
      acknowledgement: { phase: "removal_attempted", outcome: "failed" },
    });
  });

  it("archives for permission, emits handoff, resumes with preallocated identity, and expires pending permission on finish", () => {
    const active = reducePromptLifecycle(create("starting"), {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    }).next;
    const withText = reducePromptLifecycle(active, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "before permission",
    }).next;
    const permission = {
      requestId: "request",
      title: "permission",
      toolKind: "shell",
      toolTitle: "run",
      options: [{ id: "allow", label: "Allow" }],
    };
    const waiting = reducePromptLifecycle(withText, {
      type: "permission_requested",
      promptToken,
      segmentToken,
      permissionToken,
      permission,
    });

    expect(waiting.next).toMatchObject({ phase: "awaiting_permission", permissionToken });
    expect(waiting.effects.map((effect) => effect.type)).toEqual([
      "revoke_action",
      "close",
      "begin_permission_handoff",
    ]);

    const resumed = reducePromptLifecycle(waiting.next, {
      type: "permission_resolved",
      promptToken,
      permissionToken,
      nextSegmentToken,
      nextActionToken,
      nextProfile: profile,
    });
    expect(resumed.next).toMatchObject({
      phase: "active",
      segmentToken: nextSegmentToken,
      actionToken: nextActionToken,
      entries: [],
    });

    const expired = reducePromptLifecycle(waiting.next, {
      type: "finish",
      promptToken,
      outcome: "cancelled",
    });
    expect(viewForPromptState(expired.next)).toBeNull();
    expect(expired.effects).toContainEqual({
      type: "expire_permission",
      promptToken,
      permissionToken,
      reason: "cancelled",
    });
  });

  it("survives deterministic generated event sequences while preserving terminal and view invariants", () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };

    for (let sequence = 0; sequence < 64; sequence += 1) {
      let state = reducePromptLifecycle(create("starting"), {
        type: "forwarded",
        promptToken,
        segmentToken,
        actionToken,
      }).next;
      let currentSegment = segmentToken;
      let segmentNumber = 2;

      for (let step = 0; step < 64; step += 1) {
        const choice = random() % 8;
        const beforeTerminal = state.phase === "terminal";
        const event = (() => {
          switch (choice) {
            case 0:
              return {
                type: "agent_text" as const,
                promptToken,
                segmentToken: currentSegment,
                text: "x",
              };
            case 1:
              return {
                type: "agent_thought" as const,
                promptToken,
                segmentToken: currentSegment,
                text: "y",
              };
            case 2:
              return {
                type: "tool_updated" as const,
                promptToken,
                displaySegmentToken: currentSegment,
                tool: {
                  toolCallId: `tool-${random() % 8}`,
                  title: "tool",
                  toolKind: "shell",
                  status: (
                    ["pending", "in_progress", "completed", "failed", "interrupted"] as const
                  )[random() % 5]!,
                },
              };
            case 3:
              return { type: "flush_due" as const, promptToken, segmentToken: currentSegment };
            case 4: {
              const next = `segment-${segmentNumber++}` as SegmentToken;
              const event = {
                type: "archive_segment" as const,
                promptToken,
                segmentToken: currentSegment,
                reason: "rotation" as const,
                nextSegmentToken: next,
                nextActionToken: `action-${segmentNumber}` as ActionToken,
                nextProfile: profile,
              };
              if (state.phase === "active" && state.entries.length > 0) currentSegment = next;
              return event;
            }
            case 5:
              return {
                type: "agent_text" as const,
                promptToken: "stale-prompt" as PromptToken,
                segmentToken: currentSegment,
                text: "ignored",
              };
            case 6:
              return {
                type: "agent_text" as const,
                promptToken,
                segmentToken: "stale-segment" as SegmentToken,
                text: "ignored",
              };
            default:
              return {
                type: "finish" as const,
                promptToken,
                outcome: (["complete", "cancelled", "failed", "superseded", "abandoned"] as const)[
                  random() % 5
                ]!,
              };
          }
        })();

        const transitioned = reducePromptLifecycle(state, event);
        if (beforeTerminal) expect(transitioned.next.phase).toBe("terminal");
        state = transitioned.next;

        const view = viewForPromptState(state);
        if (view?.kind === "active") {
          expect(view.cancelAction).toBeDefined();
        } else if (view !== null) {
          expect("cancelAction" in view).toBe(false);
        }
        if (view?.kind === "archived" || view?.kind === "terminal") {
          for (const entry of view.entries) {
            if (entry.kind === "tool") {
              expect(["completed", "failed", "interrupted"]).toContain(entry.status);
            }
          }
        }
      }
    }
  });

  it("invalidates queued flush on finish and prevents a late idle Waiting view", () => {
    const active = reducePromptLifecycle(create("starting"), {
      type: "forwarded",
      promptToken,
      segmentToken,
      actionToken,
    }).next;
    const pending = reducePromptLifecycle(active, {
      type: "agent_text",
      promptToken,
      segmentToken,
      text: "a",
    }).next;
    const terminal = reducePromptLifecycle(pending, {
      type: "finish",
      promptToken,
      outcome: "complete",
    }).next;
    const lateFlush = reducePromptLifecycle(terminal, {
      type: "flush_due",
      promptToken,
      segmentToken,
    });
    const lateIdle = reducePromptLifecycle(terminal, {
      type: "open_idle_slot",
      promptToken,
      segmentToken,
      timerGeneration: 0,
      nextSegmentToken,
      nextActionToken,
      nextProfile: profile,
    });

    expect(lateFlush.effects).toEqual([]);
    expect(lateIdle.effects).toEqual([]);
    expect(viewForPromptState(lateIdle.next)?.kind).toBe("terminal");
  });
});
