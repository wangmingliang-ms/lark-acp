import { describe, expect, it } from "vitest";
import {
  hasSessionControls,
  mergePendingSessionConfiguration,
  mergeSessionControlPatches,
  mergeSessionControlPatchesOrUndefined,
  mergeSessionControls,
  pendingConfigurationHasProfileField,
} from "./session-controls.js";
import type { PendingSessionConfiguration, PendingTargetAgent } from "./session-store.js";

const claude: PendingTargetAgent = {
  sessionId: "profile:1",
  profileOnly: true,
  agentCommand: "claude",
  agentArgs: [],
  agentLabel: "claude",
  cwd: "/repo",
};

const copilot: PendingTargetAgent = {
  sessionId: "profile:2",
  profileOnly: true,
  agentCommand: "copilot",
  agentArgs: [],
  agentLabel: "copilot",
  cwd: "/repo",
};

describe("mergeSessionControlPatchesOrUndefined", () => {
  it("returns undefined when both sides are empty", () => {
    expect(mergeSessionControlPatchesOrUndefined(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when the merged patch has no fields", () => {
    expect(mergeSessionControlPatchesOrUndefined({}, {})).toBeUndefined();
  });

  it("merges config keys, keeping keys not mentioned by the later patch", () => {
    const merged = mergeSessionControlPatchesOrUndefined(
      { config: { a: { value: "1" } } },
      { config: { b: { value: "2" } } },
    );
    expect(merged).toEqual({ config: { a: { value: "1" }, b: { value: "2" } } });
  });
});

describe("mergePendingSessionConfiguration — field-level merge (spec §9.4)", () => {
  it("adds a previously absent field without disturbing existing ones", () => {
    const pending = mergePendingSessionConfiguration(undefined, {
      targetAgent: claude,
      controls: { modelId: "claude-model" },
    });
    const merged = mergePendingSessionConfiguration(pending, { controls: { modeId: "agent" } });

    expect(merged.targetAgent).toEqual(claude);
    expect(merged.controls).toEqual({ modelId: "claude-model", modeId: "agent" });
  });

  it("last write wins for a repeated scalar field (Model)", () => {
    const pending = mergePendingSessionConfiguration(undefined, {
      controls: { modelId: "model-a" },
    });
    const merged = mergePendingSessionConfiguration(pending, { controls: { modelId: "model-b" } });

    expect(merged.controls).toEqual({ modelId: "model-b" });
  });

  it("a later message replaces an earlier attached message", () => {
    const pending = mergePendingSessionConfiguration(undefined, {
      controls: { modeId: "agent" },
      message: { prompt: "first", createdAt: 1 },
    });
    const merged = mergePendingSessionConfiguration(pending, {
      message: { prompt: "second", createdAt: 2 },
    });

    expect(merged.message).toEqual({ prompt: "second", createdAt: 2 });
  });

  it("omitting a field never clears the pending value", () => {
    const pending = mergePendingSessionConfiguration(undefined, {
      targetAgent: claude,
      controls: { modelId: "claude-model" },
      message: { prompt: "task", createdAt: 1 },
    });
    const merged = mergePendingSessionConfiguration(pending, { controls: { modeId: "agent" } });

    expect(merged.targetAgent).toEqual(claude);
    expect(merged.message).toEqual({ prompt: "task", createdAt: 1 });
  });

  it("a later request that changes only the Agent revalidates the accumulated controls (caller responsibility) but preserves them in the merge", () => {
    const pending = mergePendingSessionConfiguration(undefined, {
      targetAgent: claude,
      controls: { modelId: "claude-only-model" },
    });
    const merged = mergePendingSessionConfiguration(pending, { targetAgent: copilot });

    expect(merged.targetAgent).toEqual(copilot);
    // The merge itself does not drop or revalidate accumulated controls —
    // the caller (Bridge) must validate the complete candidate against the
    // new Desired Agent before persisting it (spec §9.4, §9.6).
    expect(merged.controls).toEqual({ modelId: "claude-only-model" });
  });

  it("carries forward an existing queued notice card id across merges", () => {
    const pending: PendingSessionConfiguration = {
      controls: { modeId: "agent" },
      noticeMessageId: "card_1",
      createdAt: 1,
      updatedAt: 1,
    };
    const merged = mergePendingSessionConfiguration(pending, { controls: { modelId: "m" } });

    expect(merged.noticeMessageId).toBe("card_1");
  });
});

describe("pendingConfigurationHasProfileField", () => {
  it("is false for a message-only candidate (spec §9.1)", () => {
    expect(pendingConfigurationHasProfileField({})).toBe(false);
    expect(
      pendingConfigurationHasProfileField({ controls: undefined, targetAgent: undefined }),
    ).toBe(false);
  });

  it("is true when a target Agent is present", () => {
    expect(pendingConfigurationHasProfileField({ targetAgent: claude })).toBe(true);
  });

  it("is true when controls contain at least one field", () => {
    expect(pendingConfigurationHasProfileField({ controls: { modeId: "agent" } })).toBe(true);
  });
});

describe("session-level control merge helpers (used directly by FileSessionStore.setControls)", () => {
  it("mergeSessionControls applies a clearModelId patch", () => {
    expect(mergeSessionControls({ modelId: "old" }, { clearModelId: true })).toEqual({});
  });

  it("mergeSessionControlPatches preserves clearModelId until superseded", () => {
    const queued = mergeSessionControlPatches(undefined, { clearModelId: true });
    expect(queued).toEqual({ clearModelId: true });
    expect(mergeSessionControlPatches(queued, { modelId: "new" })).toEqual({ modelId: "new" });
  });

  it("hasSessionControls detects a non-empty patch", () => {
    expect(hasSessionControls({})).toBe(false);
    expect(hasSessionControls({ modeId: "agent" })).toBe(true);
  });
});
