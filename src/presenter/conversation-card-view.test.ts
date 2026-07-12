import { describe, expect, it } from "vitest";
import {
  cloneCardView,
  type ActionToken,
  type ConversationCardView,
  type PromptToken,
  type SegmentToken,
} from "./conversation-card-view.js";

describe("cloneCardView", () => {
  it("detaches every nested active-view value from its mutable source", () => {
    const route = { c: "chat", th: "thread" };
    const profile = { agent: "agent", mode: "mode", model: "model", permission: "ask" };
    const entries = [
      { kind: "text" as const, text: "original" },
      {
        kind: "tool" as const,
        toolCallId: "tool",
        title: "title",
        toolKind: "shell",
        status: "in_progress" as const,
        detail: "detail",
      },
    ];
    const cancelAction = {
      p: "prompt" as PromptToken,
      s: "segment" as SegmentToken,
      a: "action" as ActionToken,
    };
    const permissionData = {
      request: { title: "permission", options: [{ id: "allow", label: "Allow" }] },
    };
    const view = {
      kind: "active",
      header: "calling_tool",
      entries,
      profile,
      route,
      cancelAction,
      permissionData,
    } satisfies ConversationCardView & { permissionData: typeof permissionData };

    const snapshot = cloneCardView(view);
    entries[0]!.text = "mutated";
    entries[1]!.detail = "mutated";
    profile.model = "mutated";
    route.c = "mutated";
    cancelAction.p = "mutated" as PromptToken;
    permissionData.request.title = "mutated";
    permissionData.request.options[0]!.label = "Mutated";

    expect(snapshot).toMatchObject({
      entries: [{ text: "original" }, { detail: "detail" }],
      profile: { model: "model" },
      route: { c: "chat", th: "thread" },
      cancelAction: { p: "prompt", s: "segment", a: "action" },
      permissionData: {
        request: { title: "permission", options: [{ id: "allow", label: "Allow" }] },
      },
    });
  });

  it("recursively freezes cloned arrays and nested records outside production", () => {
    const snapshot = cloneCardView({
      kind: "active",
      header: "responding",
      entries: [{ kind: "text", text: "answer" }],
      profile: { agent: "agent", mode: "mode", model: "model", permission: "ask" },
      route: { c: "chat", th: "thread" },
      cancelAction: {
        p: "prompt" as PromptToken,
        s: "segment" as SegmentToken,
        a: "action" as ActionToken,
      },
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.profile)).toBe(true);
    expect(Object.isFrozen(snapshot.route)).toBe(true);
    expect(Object.isFrozen(snapshot.cancelAction)).toBe(true);
  });
});
