import type { PromptCardController } from "../acp/prompt-card-controller.js";
import type { PromptCallbackRouter } from "../acp/prompt-callback-router.js";
import type { TerminalOutcome } from "../acp/prompt-card-lifecycle.js";
import type { PromptToken } from "../presenter/conversation-card-view.js";

export type PreEnqueueFailure = "hydrate_failed" | "bootstrap_failed" | "enqueue_failed";

/**
 * One-shot orchestration handle for a controller that already owns prompt
 * identity. Acknowledgement phase remains entirely inside the reducer.
 */
export class PreparedPrompt {
  readonly promptToken: PromptToken;
  private phase: "created" | "enqueued" | "failed" = "created";
  private acknowledgementAttached = false;

  constructor(
    readonly controller: PromptCardController,
    readonly messageId: string,
    readonly router?: PromptCallbackRouter,
  ) {
    this.promptToken = controller.identity;
  }

  attachAcknowledgement(reactionId: string | null): void {
    if (this.acknowledgementAttached || reactionId === null) return;
    this.acknowledgementAttached = true;
    this.controller.acknowledge({ messageId: this.messageId, reactionId });
  }

  markEnqueued(): void {
    if (this.phase !== "created") return;
    this.phase = "enqueued";
    this.controller.markQueued();
  }

  failBeforeEnqueue(_reason: PreEnqueueFailure): void {
    if (this.phase !== "created") return;
    this.phase = "failed";
    this.controller.finish("abandoned" satisfies TerminalOutcome);
  }
}
