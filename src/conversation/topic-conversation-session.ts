import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionMode } from "../acp/humming-client.js";
import type { LarkLogger } from "../logger/logger.js";
import type {
  CardRoute,
  PermissionToken as WirePermissionToken,
  PromptToken,
} from "../presenter/conversation-card-view.js";
import type { LarkPresenter, PermissionCardView, SessionCardMeta } from "../presenter/presenter.js";
import { conversationCardBudget } from "./conversation-card-budget.js";
import { ConversationCardReconciler } from "./conversation-card-reconciler.js";
import { TopicConversationStore } from "./topic-conversation-store.js";
import {
  TopicConversation,
  type ActionToken,
  type PermissionToken,
  type RequestId,
  type RequestMessage,
  type ResponseCardId,
  type ResponseId,
  type ResponseToken,
  type TerminalOutcome,
  type TimelineEntry,
  type TopicConversationSnapshot,
  type TurnId,
} from "./topic-conversation.js";

export interface TopicConversationTokenFactory {
  turn(): TurnId;
  request(): RequestId;
  response(): ResponseId;
  responseToken(): ResponseToken;
  card(): ResponseCardId;
  action(): ActionToken;
  permission(): PermissionToken;
  permissionRequest(): string;
}

export function randomConversationTokenFactory(): TopicConversationTokenFactory {
  return {
    turn: () => crypto.randomUUID() as TurnId,
    request: () => crypto.randomUUID() as RequestId,
    response: () => crypto.randomUUID() as ResponseId,
    responseToken: () => crypto.randomUUID() as ResponseToken,
    card: () => crypto.randomUUID() as ResponseCardId,
    action: () => crypto.randomUUID() as ActionToken,
    permission: () => crypto.randomUUID() as PermissionToken,
    permissionRequest: () => crypto.randomUUID(),
  };
}

export interface AcceptedConversationTurn {
  readonly turnId: TurnId;
  readonly requestId: RequestId;
  readonly responseId: ResponseId;
  readonly responseToken: ResponseToken;
  readonly initialCardId: ResponseCardId;
  readonly sourceMessageId: string;
}

interface MutablePermission {
  readonly responseId: ResponseId;
  readonly token: PermissionToken;
  readonly requestId: string;
  cardMessageId: string | null;
  settled: boolean;
  resolve(value: acp.RequestPermissionResponse): void;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface AcknowledgementPort {
  add(messageId: string): Promise<string | null>;
  remove(messageId: string, reactionId: string): Promise<boolean>;
}

export interface TopicConversationSessionOptions {
  readonly presenter: LarkPresenter;
  readonly logger: LarkLogger;
  readonly route: CardRoute;
  readonly tokens?: TopicConversationTokenFactory;
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
  readonly presentationEnabled?: boolean;
  readonly permissionTimeoutMs: number;
  readonly permissionMode?: () => PermissionMode;
  readonly acknowledgement?: AcknowledgementPort;
  onCancelResponse(responseId: ResponseId): Promise<void> | void;
  onPermissionDisplayFailure(responseId: ResponseId): Promise<void> | void;
}

const MAX_RETAINED_SETTLED_TERMINALS = 3;

/**
 * Application service around the Topic aggregate. It is the only layer allowed
 * to translate ACP callbacks and Feishu actions into domain commands.
 */
export class TopicConversationSession {
  private readonly aggregate = new TopicConversation();
  private readonly store = new TopicConversationStore(this.aggregate);
  private readonly reconciler: ConversationCardReconciler;
  private readonly tokens: TopicConversationTokenFactory;
  private readonly accepted = new Map<ResponseId, AcceptedConversationTurn>();
  private readonly acknowledgements = new Map<
    ResponseId,
    { readonly messageId: string; readonly reactionId: string }
  >();
  private readonly removingAcknowledgements = new Set<string>();
  private readonly acknowledgementRetryRequested = new Set<string>();
  private readonly settledTerminalResponses = new Set<ResponseId>();
  private currentPermission: MutablePermission | null = null;

  constructor(private readonly options: TopicConversationSessionOptions) {
    this.tokens = options.tokens ?? randomConversationTokenFactory();
    this.reconciler = new ConversationCardReconciler({
      store: this.store,
      presenter: options.presenter,
      logger: options.logger,
      route: options.route,
      showCancelButton: options.showCancelButton,
      enabled: options.presentationEnabled ?? true,
      onSettledImmutable: (responseId, cardId, kind) => {
        if (kind === "intermediate") {
          this.store.transactionIfChanged((aggregate) =>
            aggregate.evictSettledIntermediate(responseId, cardId),
          );
        } else {
          this.removeAcknowledgement(responseId);
          this.settledTerminalResponses.add(responseId);
          this.reclaimOldSettledTerminals();
        }
      },
    });
    let previous = this.store.snapshot;
    this.store.subscribe(({ snapshot }) => {
      this.removeAcknowledgementsForNewTerminals(previous, snapshot);
      previous = snapshot;
    });
  }

  get snapshot(): TopicConversationSnapshot {
    return this.store.snapshot;
  }

  async flushPresentation(): Promise<void> {
    await this.reconciler.flush();
  }

  get deliveryState() {
    return this.store.deliveryState;
  }

  accept(input: {
    sourceMessageId: string;
    content: unknown;
    profile: SessionCardMeta | null;
  }): AcceptedConversationTurn {
    const turn: AcceptedConversationTurn = {
      turnId: this.tokens.turn(),
      requestId: this.tokens.request(),
      responseId: this.tokens.response(),
      responseToken: this.tokens.responseToken(),
      initialCardId: this.tokens.card(),
      sourceMessageId: input.sourceMessageId,
    };
    this.accepted.set(turn.responseId, turn);
    this.reconciler.registerAnchor(turn.initialCardId, input.sourceMessageId);
    this.store.transaction((aggregate) =>
      aggregate.accept({
        turnId: turn.turnId,
        request: {
          id: turn.requestId,
          sourceMessageId: input.sourceMessageId,
          content: input.content,
        },
        responseId: turn.responseId,
        responseToken: turn.responseToken,
        initialCardId: turn.initialCardId,
        profile: input.profile,
      }),
    );
    this.expirePermissionIfDomainRevoked();
    return turn;
  }

  isResponseRunnable(responseId: ResponseId): boolean {
    return this.response(responseId).state.kind === "in_progress";
  }

  attachAcknowledgement(responseId: ResponseId, reactionId: string | null): void {
    if (reactionId === null) return;
    const turn = this.acceptedTurn(responseId);
    this.acknowledgements.set(responseId, { messageId: turn.sourceMessageId, reactionId });
    if (this.response(responseId).state.kind === "terminal") {
      this.removeAcknowledgement(responseId);
    }
  }

  async prepare(responseId: ResponseId, profile: SessionCardMeta | null): Promise<void> {
    this.store.transaction((aggregate) => {
      aggregate.setProfile(responseId, profile);
      aggregate.prepare(responseId);
    });
  }

  setProfile(responseId: ResponseId, profile: SessionCardMeta | null): void {
    this.store.transaction((aggregate) => aggregate.setProfile(responseId, profile));
  }

  async activate(responseId: ResponseId): Promise<ActionToken> {
    const token = this.tokens.action();
    this.store.transaction((aggregate) => {
      aggregate.activate(responseId, token);
      const pending = aggregate.snapshot().pendingBatch;
      if (pending?.state === "sealed" && pending.carrierResponseId !== responseId) {
        throw new Error("only the sealed batch carrier may activate");
      }
      if (pending?.state === "sealed" && pending.carrierResponseId === responseId) {
        aggregate.clearSealedBatch();
      }
    });
    return token;
  }

  async rotate(responseId: ResponseId, reason: "size" | "tool_boundary"): Promise<void> {
    void reason;
    this.rotateConversationCard(responseId);
  }

  private rotateConversationCard(responseId: ResponseId): void {
    const nextCardId = this.tokens.card();
    this.reconciler.registerAnchor(nextCardId, this.acceptedTurn(responseId).sourceMessageId);
    const token = this.options.showCancelButton ? this.tokens.action() : null;
    this.store.transaction((aggregate) =>
      aggregate.rotateTail(responseId, nextCardId, "content_rotation", token),
    );
  }

  async applyAgentUpdate(responseId: ResponseId, update: acp.SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type !== "text") return;
        this.appendTextChunks(responseId, "text", update.content.text, "responding");
        return;
      case "agent_thought_chunk":
        if (!this.options.showThoughts || update.content.type !== "text") return;
        this.appendTextChunks(responseId, "thought", update.content.text, "thinking");
        return;
      case "tool_call":
        if (!this.options.showTools) return;
        if (!this.hasTool(responseId, update.toolCallId)) {
          this.rotateBeforeElement(responseId, {
            kind: "tool",
            toolCallId: update.toolCallId,
            title: update.title,
            status:
              update.status === "completed" || update.status === "failed"
                ? update.status
                : "in_progress",
          });
        }
        this.store.transaction((aggregate) => {
          const status =
            update.status === "completed" || update.status === "failed"
              ? update.status
              : "in_progress";
          const updated = aggregate.updateTool(responseId, update.toolCallId, {
            title: update.title,
            status,
          });
          if (!updated) {
            aggregate.append(responseId, {
              kind: "tool",
              toolCallId: update.toolCallId,
              title: update.title,
              status,
            });
          }
          if (status === "completed" || status === "failed") {
            aggregate.finishToolActivity(responseId, update.toolCallId);
          } else {
            aggregate.startToolActivity(responseId, update.toolCallId, update.title ?? null);
          }
        });
        return;
      case "tool_call_update":
        if (!this.options.showTools) return;
        const status =
          update.status === "completed" || update.status === "failed"
            ? update.status
            : update.status === "pending" || update.status === "in_progress"
              ? "in_progress"
              : undefined;
        const updated = this.store.transaction((aggregate) => {
          const found = aggregate.updateTool(responseId, update.toolCallId, {
            ...(update.title === null || update.title === undefined ? {} : { title: update.title }),
            ...(status === undefined ? {} : { status }),
          });
          if (found) {
            if (status === "completed" || status === "failed") {
              aggregate.finishToolActivity(responseId, update.toolCallId);
            } else if (
              status === "in_progress" ||
              (update.title !== null && update.title !== undefined)
            ) {
              aggregate.updateToolActivity(
                responseId,
                update.toolCallId,
                update.title === null ? undefined : update.title,
              );
            }
          }
          return found;
        });
        if (!updated) {
          this.options.logger.debug(
            { responseId, toolCallId: update.toolCallId },
            "ignoring update for an unknown tool call",
          );
        }
        return;
      default:
        return;
    }
  }

  async requestPermission(
    responseId: ResponseId,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const auto = autoResolvePermission(params, this.options.permissionMode?.() ?? "alwaysAsk");
    if (auto !== null) return auto;
    if (this.currentPermission !== null && !this.currentPermission.settled) {
      this.expirePermission("新的权限请求已替代上一条权限请求");
    }
    const before = this.response(responseId);
    const oldTailId = before.cards.at(-1)?.id;
    if (oldTailId === undefined) throw new Error("Response has no tail Card");
    const permissionToken = this.tokens.permission();
    const requestId = this.tokens.permissionRequest();
    const continuationCardId = this.tokens.card();
    this.reconciler.registerAnchor(
      continuationCardId,
      this.acceptedTurn(responseId).sourceMessageId,
    );
    this.store.transaction((aggregate) =>
      aggregate.requestPermission({
        responseId,
        permissionToken,
        requestId,
        allowedOptionIds: new Set(params.options.map((option) => option.optionId)),
        continuationCardId,
        continuationActionToken: this.tokens.action(),
      }),
    );
    const permissionResponse = new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pending: MutablePermission = {
        responseId,
        token: permissionToken,
        requestId,
        cardMessageId: null,
        settled: false,
        resolve,
      };
      if (this.options.permissionTimeoutMs > 0) {
        pending.timeout = setTimeout(
          () => this.expirePermission("用户未在规定时间内响应，权限请求已失效"),
          this.options.permissionTimeoutMs,
        );
      }
      this.currentPermission = pending;
    });
    const permissionView: PermissionCardView = {
      route: this.options.route,
      promptToken: this.response(responseId).token as unknown as PromptToken,
      permissionToken: permissionToken as unknown as WirePermissionToken,
      requestId,
      title: params.toolCall.title ?? "Permission required",
      toolKind: params.toolCall.kind ?? "other",
      toolTitle: params.toolCall.title ?? "Tool",
      options: params.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
    };
    void this.observePermissionPresentation(responseId, permissionToken, requestId, permissionView);
    return permissionResponse;
  }

  cancelPendingPermissions(reason = "Response 已结束，权限请求已失效"): void {
    this.expirePermission(reason);
  }

  consumePermission(input: {
    responseToken: string;
    permissionToken: string;
    requestId: string;
    optionId: string;
  }): "accepted" | "stale" {
    const pending = this.currentPermission;
    if (
      pending === null ||
      pending.settled ||
      this.response(pending.responseId).token !== input.responseToken ||
      pending.token !== input.permissionToken ||
      pending.requestId !== input.requestId
    ) {
      return "stale";
    }
    const result = this.store.transaction((aggregate) =>
      aggregate.resolvePermission(pending.token, input.optionId),
    );
    if (result !== "accepted") return result;
    pending.settled = true;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.resolve({ outcome: { outcome: "selected", optionId: input.optionId } });
    this.currentPermission = null;
    this.reconciler.expirePermission(pending.requestId, "权限已处理");
    return "accepted";
  }

  consumeCancel(input: {
    responseToken: string;
    cardId: string;
    actionToken: string;
  }): "accepted" | "stale" {
    const response = this.snapshot.turns.find(
      (turn) => turn.response.token === input.responseToken,
    )?.response;
    if (response === undefined) return "stale";
    const result = this.store.transaction((aggregate) =>
      aggregate.consumeCardCancel({
        responseId: response.id,
        cardId: input.cardId as ResponseCardId,
        token: input.actionToken as ActionToken,
      }),
    );
    if (result === "accepted") {
      this.expirePermissionIfDomainRevoked();
      void this.options.onCancelResponse(response.id);
    }
    return result;
  }

  async failResponse(responseId: ResponseId, text: string): Promise<void> {
    const response = this.response(responseId);
    if (response.state.kind === "terminal") {
      if (response.state.outcome === "merged") {
        this.store.transaction((aggregate) => aggregate.dropMergedBatchMember(responseId));
      }
      return;
    }
    const owner = this.snapshot.executionOwnerResponseId;
    if (owner === responseId) {
      this.store.transaction((aggregate) => aggregate.append(responseId, { kind: "notice", text }));
      await this.finishOwner("failed");
      return;
    }
    this.store.transaction((aggregate) => aggregate.failWaiting(responseId, text));
  }

  async finishOwner(
    outcome: Exclude<TerminalOutcome, "merged">,
    commit?: (handoff: {
      readonly pendingBatch: readonly RequestMessage[];
      readonly carrierResponseId: ResponseId;
    }) => void,
  ): Promise<{
    readonly pendingBatch: readonly RequestMessage[] | null;
    readonly carrierResponseId: ResponseId | null;
  }> {
    const owner = this.snapshot.executionOwnerResponseId;
    if (owner === null) return { pendingBatch: null, carrierResponseId: null };
    const pending = this.snapshot.pendingBatch;
    if (pending?.state === "collecting") {
      const sealed = this.store.transaction((aggregate) => {
        const result = aggregate.sealOwnerForPendingBatch(outcome);
        aggregate.clearSealedBatch();
        return result;
      });
      commit?.({ pendingBatch: sealed.messages, carrierResponseId: sealed.carrierResponseId });
      this.expirePermission("Response 已结束，权限请求已失效");
      return { pendingBatch: sealed.messages, carrierResponseId: sealed.carrierResponseId };
    }
    this.store.transaction((aggregate) => aggregate.seal(owner, outcome));
    this.expirePermission("Response 已结束，权限请求已失效");
    return { pendingBatch: null, carrierResponseId: null };
  }

  clearSealedBatch(): void {
    this.store.transaction((aggregate) => aggregate.clearSealedBatch());
  }

  async interruptTopic(): Promise<void> {
    this.store.transaction((aggregate) => aggregate.interruptTopic());
    this.expirePermission("Session 已中断，权限请求已失效");
  }

  async beginTopicCancel(): Promise<ResponseId | null> {
    const owner = this.store.transaction((aggregate) => aggregate.beginTopicCancel());
    this.expirePermission("Topic 已取消，权限请求已失效");
    return owner;
  }

  async confirmTopicCancel(): Promise<void> {
    this.store.transaction((aggregate) => aggregate.confirmTopicCancel());
  }

  private async observePermissionPresentation(
    responseId: ResponseId,
    permissionToken: PermissionToken,
    requestId: string,
    permissionView: PermissionCardView,
  ): Promise<void> {
    const permissionCardId = await this.reconciler.presentPermission(
      requestId,
      this.acceptedTurn(responseId).sourceMessageId,
      permissionView,
    );
    const pending = this.currentPermission;
    const stillCurrent =
      pending !== null &&
      pending.token === permissionToken &&
      !pending.settled &&
      this.snapshot.permission?.token === permissionToken &&
      this.snapshot.permission.status === "current";
    if (permissionCardId === null) {
      if (!stillCurrent) return;
      this.store.transaction((aggregate) => aggregate.beginPermissionDisplayFailure(responseId));
      this.expirePermission("权限请求无法显示，本次执行失败", "display_failed");
      await this.options.onPermissionDisplayFailure(responseId);
      return;
    }
    if (stillCurrent && pending !== null) {
      pending.cardMessageId = permissionCardId;
      return;
    }
    this.reconciler.expirePermission(requestId, "权限请求已失效");
  }

  private reclaimOldSettledTerminals(): void {
    const ordered = this.snapshot.turns
      .map((turn) => turn.response.id)
      .filter((responseId) => this.settledTerminalResponses.has(responseId));
    const overflow = ordered.slice(0, -MAX_RETAINED_SETTLED_TERMINALS);
    for (const responseId of overflow) {
      const tailId = this.snapshot.turns
        .find((turn) => turn.response.id === responseId)
        ?.response.cards.at(-1)?.id;
      const evicted = this.store.transactionIfChanged((aggregate) =>
        aggregate.evictTerminalAfterDeliverySettled(responseId),
      );
      if (!evicted) continue;
      this.settledTerminalResponses.delete(responseId);
      if (tailId !== undefined) this.reconciler.forgetSettledArtifact(tailId);
      this.accepted.delete(responseId);
      this.acknowledgements.delete(responseId);
    }
  }

  private response(responseId: ResponseId) {
    const found = this.snapshot.turns.find((turn) => turn.response.id === responseId)?.response;
    if (found === undefined) throw new Error(`unknown response: ${responseId}`);
    return found;
  }

  private acceptedTurn(responseId: ResponseId): AcceptedConversationTurn {
    const turn = this.accepted.get(responseId);
    if (turn === undefined) throw new Error(`unknown accepted response: ${responseId}`);
    return turn;
  }

  private appendTextChunks(
    responseId: ResponseId,
    kind: "text" | "thought",
    text: string,
    activity: "responding" | "thinking",
  ): void {
    if (text.length === 0) return;
    const initialTail = this.response(responseId).cards.at(-1);
    const initialLast = initialTail?.entries.at(-1);
    let remaining = (initialLast?.kind === kind ? initialLast.text : "") + text;
    let replacing = initialLast?.kind === kind;

    while (remaining.length > 0) {
      if (!replacing) {
        this.rotateBeforeElement(responseId, { kind, text: "" });
      }
      const tail = this.response(responseId).cards.at(-1);
      if (tail === undefined) throw new Error("Response has no tail Card");
      const baseEntries = replacing ? tail.entries.slice(0, -1) : tail.entries;
      const [part, remainder] = conversationCardBudget.splitText(
        remaining,
        conversationCardBudget.contentBytes(baseEntries),
      );
      if (part.length === 0) {
        this.rotateConversationCard(responseId);
        replacing = false;
        continue;
      }
      this.store.transaction((aggregate) => {
        if (replacing) aggregate.replaceTailText(responseId, kind, part);
        else aggregate.append(responseId, { kind, text: part });
        aggregate.setActivity(responseId, { kind: activity });
      });
      remaining = remainder;
      if (remaining.length > 0) this.rotateConversationCard(responseId);
      replacing = false;
    }
  }

  private rotateBeforeElement(responseId: ResponseId, entry: TimelineEntry): void {
    const response = this.response(responseId);
    const tail = response.cards.at(-1);
    if (tail === undefined || tail.entries.length === 0) return;
    if (
      conversationCardBudget.accepts(tail.entries, entry, {
        showCancelButton: this.options.showCancelButton,
        profile: response.profile,
      })
    )
      return;
    this.rotateConversationCard(responseId);
  }

  private hasTool(responseId: ResponseId, toolCallId: string): boolean {
    const response = this.response(responseId);
    return (
      response.terminalToolCallIds.includes(toolCallId) ||
      response.cards.some((card) =>
        card.entries.some((entry) => entry.kind === "tool" && entry.toolCallId === toolCallId),
      )
    );
  }

  private removeAcknowledgement(responseId: ResponseId): void {
    const acknowledgement = this.acknowledgements.get(responseId);
    const port = this.options.acknowledgement;
    if (acknowledgement === undefined || port === undefined) return;
    const identity = `${acknowledgement.messageId}\u0000${acknowledgement.reactionId}`;
    if (this.removingAcknowledgements.has(identity)) {
      this.acknowledgementRetryRequested.add(identity);
      return;
    }
    this.removingAcknowledgements.add(identity);
    void port
      .remove(acknowledgement.messageId, acknowledgement.reactionId)
      .then((removed) => {
        if (!removed) return;
        this.acknowledgements.delete(responseId);
      })
      .catch((error) =>
        this.options.logger.debug({ error, responseId }, "acknowledgement removal failed"),
      )
      .finally(() => {
        this.removingAcknowledgements.delete(identity);
        if (this.acknowledgementRetryRequested.delete(identity)) {
          this.removeAcknowledgement(responseId);
        }
      });
  }

  private removeAcknowledgementsForNewTerminals(
    previous: TopicConversationSnapshot,
    current: TopicConversationSnapshot,
  ): void {
    const previousStates = new Map(
      previous.turns.map((turn) => [turn.response.id, turn.response.state] as const),
    );
    for (const turn of current.turns) {
      if (turn.response.state.kind !== "terminal") continue;
      if (previousStates.get(turn.response.id)?.kind === "terminal") continue;
      this.removeAcknowledgement(turn.response.id);
    }
  }

  private expirePermissionIfDomainRevoked(): void {
    const pending = this.currentPermission;
    if (pending === null || pending.settled) return;
    if (this.snapshot.permission?.status !== "current") {
      this.expirePermission("新消息已到达，原权限请求已失效");
    }
  }

  private expirePermission(
    reason: string,
    domainStatus: "expired" | "display_failed" = "expired",
  ): void {
    const pending = this.currentPermission;
    if (pending === null || pending.settled) return;
    if (domainStatus === "expired") {
      this.store.transaction((aggregate) => aggregate.expirePermission(pending.token));
    }
    pending.settled = true;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.resolve({ outcome: { outcome: "cancelled" } });
    this.currentPermission = null;
    this.reconciler.expirePermission(pending.requestId, reason);
  }
}

function autoResolvePermission(
  params: acp.RequestPermissionRequest,
  mode: PermissionMode,
): acp.RequestPermissionResponse | null {
  const effective = isHummingPermission(params) ? "alwaysAllow" : mode;
  if (effective === "alwaysAsk") return null;
  const prefix = effective === "alwaysAllow" ? "allow_" : "reject_";
  const option = params.options.find((candidate) => candidate.kind.startsWith(prefix));
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: option.optionId } };
}

function isHummingPermission(params: acp.RequestPermissionRequest): boolean {
  const raw = params.toolCall?.rawInput;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const direct = ["command", "cmd", "commandLine", "shellCommand", "script"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string");
  const args = [record["args"], record["argv"]].find(
    (value): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string"),
  );
  const first = (direct ?? args?.[0] ?? "").trim().split(/\s+/)[0] ?? "";
  const binary = first.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return binary === "humming" || binary === "humming.cmd" || binary === "humming.ps1";
}
