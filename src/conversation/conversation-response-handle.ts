import type * as acp from "@agentclientprotocol/sdk";
import type { SessionCardMeta } from "../presenter/presenter.js";
import type { ResponseId } from "./topic-conversation.js";
import type { TopicConversationSession } from "./topic-conversation-session.js";

/** Prompt-scoped facade over the one TopicConversationSession aggregate. */
export class ConversationResponseHandle {
  constructor(
    readonly responseId: ResponseId,
    readonly responseToken: string,
    readonly messageId: string,
    readonly acceptedAt: number,
    readonly turnSequence: number,
    private readonly session: TopicConversationSession,
  ) {}

  attachAcknowledgement(reactionId: string | null): void {
    this.session.attachAcknowledgement(this.responseId, reactionId);
  }

  prepare(profile: SessionCardMeta | null): Promise<void> {
    return this.session.prepare(this.responseId, profile);
  }

  setProfile(profile: SessionCardMeta | null): void {
    this.session.setProfile(this.responseId, profile);
  }

  activate(): Promise<unknown> {
    return this.session.activate(this.responseId);
  }

  applyAgentUpdate(update: acp.SessionUpdate): Promise<void> {
    return this.session.applyAgentUpdate(this.responseId, update);
  }

  isRunnable(): boolean {
    return this.session.isResponseRunnable(this.responseId);
  }

  fail(text: string): Promise<void> {
    return this.session.failResponse(this.responseId, text);
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.session.requestPermission(this.responseId, params);
  }

  cancelPendingPermissions(): void {
    this.session.cancelPendingPermissions();
  }

  rotate(reason: "size" | "tool_boundary"): Promise<void> {
    return this.session.rotate(this.responseId, reason);
  }
}
