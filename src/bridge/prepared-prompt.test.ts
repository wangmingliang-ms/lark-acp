import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type { PromptToken } from "../presenter/conversation-card-view.js";
import type { PromptCardController } from "../acp/prompt-card-controller.js";
import { PreparedPrompt } from "./prepared-prompt.js";

function controller(): PromptCardController {
  return {
    identity: "prompt-1" as PromptToken,
    acknowledge: vi.fn(),
    markQueued: vi.fn(),
    finish: vi.fn(),
  } as unknown as PromptCardController;
}

describe("PreparedPrompt", () => {
  it("allocates identity before acknowledgement and dispatches attachment once", () => {
    const owner = controller();
    const prepared = new PreparedPrompt(owner, "message-1");

    expect(prepared.promptToken).toBe("prompt-1");
    prepared.attachAcknowledgement("reaction-1");
    prepared.attachAcknowledgement("reaction-duplicate");

    expect(owner.acknowledge).toHaveBeenCalledExactlyOnceWith({
      messageId: "message-1",
      reactionId: "reaction-1",
    });
  });

  it("marks queued exactly once and cannot fail after enqueue", () => {
    const owner = controller();
    const prepared = new PreparedPrompt(owner, "message-1");

    prepared.markEnqueued();
    prepared.markEnqueued();
    prepared.failBeforeEnqueue("enqueue_failed");

    expect(owner.markQueued).toHaveBeenCalledOnce();
    expect(owner.finish).not.toHaveBeenCalled();
  });

  it.each(["hydrate_failed", "bootstrap_failed", "enqueue_failed"] as const)(
    "abandons a prompt that fails before enqueue: %s",
    (reason) => {
      const owner = controller();
      const prepared = new PreparedPrompt(owner, "message-1");

      prepared.failBeforeEnqueue(reason);
      prepared.failBeforeEnqueue(reason);

      expect(owner.finish).toHaveBeenCalledExactlyOnceWith("abandoned");
      expect(owner.markQueued).not.toHaveBeenCalled();
    },
  );

  it("keeps the prompt payload external to the one-shot orchestration handle", () => {
    const prompt: acp.ContentBlock[] = [{ type: "text", text: "hello" }];
    const prepared = new PreparedPrompt(controller(), "message-1");
    expect(prepared).not.toHaveProperty("prompt");
    expect(prompt).toHaveLength(1);
  });
});
