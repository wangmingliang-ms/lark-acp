import type { LarkLogger } from "../logger/logger.js";
import type { ConversationCardView } from "../presenter/conversation-card-view.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { conversationDeliveryActions } from "./conversation-delivery-slice.js";
import { ConversationCardViewMapper } from "./conversation-card-view-mapper.js";
import {
  ResponseCardProjector,
  type ResponseCardId,
  type ResponseId,
  type TopicConversationSnapshot,
} from "./topic-conversation.js";
import type {
  TopicConversationStateChange,
  TopicConversationStore,
} from "./topic-conversation-store.js";

const PATCH_FAILURE_WARNING =
  "上一张 Card 更新失败；旧 Card 可能仍显示“处理中”或旧按钮，但这些状态已经失效。";

export interface ConversationCardDeliveryRecordSnapshot {
  readonly cardId: ResponseCardId;
  readonly responseId: ResponseId;
  readonly externalMessageId: string | null;
  readonly desiredRevision: number;
  readonly deliveredRevision: number | null;
  readonly status: "dirty" | "rendering" | "retrying" | "settled" | "failed";
  readonly attempts: number;
}

interface DeliveryRecord {
  readonly cardId: ResponseCardId;
  responseId: ResponseId;
  externalMessageId: string | null;
  desiredRevision: number;
  deliveredRevision: number | null;
  status: "dirty" | "rendering" | "retrying" | "settled" | "failed";
  attempts: number;
  worker: Promise<void> | null;
}

interface DeliveryDiagnostic {
  readonly id: number;
  readonly responseId: ResponseId;
  readonly failedCardId: ResponseCardId;
  status: "pending" | "displayed";
  displayedOnCardId: ResponseCardId | null;
}

interface PermissionDeliveryRecord {
  readonly id: string;
  readonly anchorMessageId: string;
  readonly view: import("../presenter/presenter.js").PermissionCardView;
  externalMessageId: string | null;
  desired: "current" | "expired";
  reason: string;
  status: "sending" | "visible" | "expiring" | "settled" | "failed";
  worker: Promise<void> | null;
  visibleSettled: boolean;
  resolveVisible(value: string | null): void;
}

export interface ConversationCardReconcilerOptions {
  readonly store: TopicConversationStore;
  readonly presenter: Pick<
    LarkPresenter,
    | "sendConversationCard"
    | "updateConversationCard"
    | "sendPermissionRequestCard"
    | "expirePermissionCard"
  >;
  readonly logger: LarkLogger;
  readonly route: { readonly c: string; readonly th?: string };
  readonly showCancelButton: boolean;
  readonly enabled?: boolean;
  readonly maxPatchAttempts?: number;
  readonly retryDelayMs?: number;
  readonly onCardVisible?: (responseId: ResponseId, cardId: ResponseCardId) => void;
  readonly onSettledImmutable?: (
    responseId: ResponseId,
    cardId: ResponseCardId,
    kind: "intermediate" | "terminal",
  ) => void;
}

/**
 * The sole effect writer for semantic Response Cards.
 *
 * Commands publish domain snapshots. This reconciler observes those snapshots,
 * projects the latest desired view when a worker actually runs, and keeps
 * writing until each retained Card's delivered revision catches up.
 */
export class ConversationCardReconciler {
  private readonly projector = new ResponseCardProjector();
  private readonly mapper = new ConversationCardViewMapper();
  private readonly records = new Map<ResponseCardId, DeliveryRecord>();
  private readonly anchors = new Map<ResponseCardId, string>();
  private readonly diagnostics = new Map<number, DeliveryDiagnostic>();
  private readonly settledArtifacts = new Set<ResponseCardId>();
  private readonly permissions = new Map<string, PermissionDeliveryRecord>();
  private readonly unsubscribe: () => void;
  private desiredClock = 0;
  private diagnosticClock = 0;
  private snapshotValue: TopicConversationSnapshot;
  private revisionValue: number;
  private disposed = false;

  constructor(private readonly options: ConversationCardReconcilerOptions) {
    this.snapshotValue = options.store.snapshot;
    this.revisionValue = options.store.revision;
    this.unsubscribe =
      options.enabled === false
        ? () => undefined
        : options.store.subscribe((change) => this.observe(change));
  }

  registerAnchor(cardId: ResponseCardId, sourceMessageId: string): void {
    this.anchors.set(cardId, sourceMessageId);
  }

  forgetSettledArtifact(cardId: ResponseCardId): void {
    this.settledArtifacts.delete(cardId);
    this.forgetRecord(cardId);
  }

  presentPermission(
    id: string,
    anchorMessageId: string,
    view: import("../presenter/presenter.js").PermissionCardView,
  ): Promise<string | null> {
    const existing = this.permissions.get(id);
    if (existing !== undefined) {
      return new Promise((resolve) => {
        if (existing.visibleSettled) resolve(existing.externalMessageId);
        else {
          const previous = existing.resolveVisible;
          existing.resolveVisible = (value) => {
            previous(value);
            resolve(value);
          };
        }
      });
    }
    let resolveVisible!: (value: string | null) => void;
    const visible = new Promise<string | null>((resolve) => {
      resolveVisible = resolve;
    });
    const record: PermissionDeliveryRecord = {
      id,
      anchorMessageId,
      view,
      externalMessageId: null,
      desired: "current",
      reason: "权限请求已失效",
      status: "sending",
      worker: null,
      visibleSettled: false,
      resolveVisible,
    };
    this.permissions.set(id, record);
    this.publishPermission(record);
    this.schedulePermission(record);
    return visible;
  }

  expirePermission(id: string, reason: string): void {
    const record = this.permissions.get(id);
    if (record === undefined) return;
    record.desired = "expired";
    record.reason = reason;
    record.status = record.externalMessageId === null ? "sending" : "expiring";
    this.publishPermission(record);
    if (record.externalMessageId === null && record.worker !== null) {
      if (!record.visibleSettled) {
        record.visibleSettled = true;
        record.resolveVisible(null);
      }
      this.forgetPermission(record.id);
      return;
    }
    this.schedulePermission(record);
  }

  get pendingPermissionCount(): number {
    return this.permissions.size;
  }

  get deliveryRecords(): readonly ConversationCardDeliveryRecordSnapshot[] {
    return Object.values(this.options.store.deliveryState.cards);
  }

  hasVisibleCard(responseId: ResponseId): boolean {
    return [...this.records.values()].some(
      (record) => record.responseId === responseId && record.externalMessageId !== null,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  async flush(): Promise<void> {
    for (;;) {
      const cardWorkers = [...this.records.values()]
        .map((record) => record.worker)
        .filter((worker): worker is Promise<void> => worker !== null);
      const permissionWorkers = [...this.permissions.values()]
        .map((record) => record.worker)
        .filter((worker): worker is Promise<void> => worker !== null);
      const workers = [...cardWorkers, ...permissionWorkers];
      if (workers.length === 0) return;
      await Promise.all(workers);
    }
  }

  private schedulePermission(record: PermissionDeliveryRecord): void {
    if (record.worker !== null) return;
    record.worker = this.runPermission(record)
      .catch((error) => {
        this.options.logger.warn(
          { error, permissionId: record.id },
          "permission reconciliation failed",
        );
        if (this.permissions.get(record.id) !== record) return;
        if (!record.visibleSettled) {
          record.visibleSettled = true;
          record.resolveVisible(null);
        }
        record.status = "failed";
        this.publishPermission(record);
        this.forgetPermission(record.id);
      })
      .finally(() => {
        record.worker = null;
        if (
          this.permissions.get(record.id) === record &&
          record.desired === "expired" &&
          record.externalMessageId !== null
        ) {
          this.schedulePermission(record);
        }
      });
  }

  private async runPermission(record: PermissionDeliveryRecord): Promise<void> {
    if (record.externalMessageId === null) {
      const send = this.options.presenter.sendPermissionRequestCard;
      if (typeof send !== "function") {
        if (!record.visibleSettled) {
          record.visibleSettled = true;
          record.resolveVisible(null);
        }
        record.status = "failed";
        this.publishPermission(record);
        this.forgetPermission(record.id);
        return;
      }
      const externalId = await send.call(
        this.options.presenter,
        record.anchorMessageId,
        record.view,
      );
      if (externalId === null) {
        if (!record.visibleSettled) {
          record.visibleSettled = true;
          record.resolveVisible(null);
        }
        record.status = "failed";
        this.publishPermission(record);
        this.forgetPermission(record.id);
        return;
      }
      record.externalMessageId = externalId;
      const stillManaged = this.permissions.get(record.id) === record;
      if (!stillManaged) {
        if (record.desired === "expired") {
          const expire = this.options.presenter.expirePermissionCard;
          if (typeof expire === "function") {
            await expire.call(this.options.presenter, externalId, record.reason);
          }
        }
        return;
      }
      record.status = record.desired === "expired" ? "expiring" : "visible";
      this.publishPermission(record);
      if (!record.visibleSettled) {
        record.visibleSettled = true;
        record.resolveVisible(externalId);
      }
    }
    if (record.desired !== "expired" || record.externalMessageId === null) return;
    const expire = this.options.presenter.expirePermissionCard;
    if (typeof expire === "function") {
      await expire.call(this.options.presenter, record.externalMessageId, record.reason);
    }
    record.status = "settled";
    this.publishPermission(record);
    this.forgetPermission(record.id);
  }

  private publishPermission(record: PermissionDeliveryRecord): void {
    this.options.store.dispatch(
      conversationDeliveryActions.permissionRecorded({
        id: record.id,
        externalMessageId: record.externalMessageId,
        desired: record.desired,
        status: record.status,
      }),
    );
  }

  private forgetPermission(id: string): void {
    this.permissions.delete(id);
    this.options.store.dispatch(conversationDeliveryActions.permissionForgotten(id));
  }

  private publishRecord(record: DeliveryRecord): void {
    this.options.store.dispatch(
      conversationDeliveryActions.cardRecorded({
        cardId: record.cardId,
        responseId: record.responseId,
        externalMessageId: record.externalMessageId,
        desiredRevision: record.desiredRevision,
        deliveredRevision: record.deliveredRevision,
        status: record.status,
        attempts: record.attempts,
      }),
    );
  }

  private forgetRecord(cardId: ResponseCardId): void {
    this.records.delete(cardId);
    this.anchors.delete(cardId);
    this.options.store.dispatch(conversationDeliveryActions.cardForgotten(cardId));
  }

  private publishDiagnostic(diagnostic: DeliveryDiagnostic): void {
    this.options.store.dispatch(conversationDeliveryActions.diagnosticRecorded({ ...diagnostic }));
  }

  private forgetDiagnostic(id: number): void {
    this.diagnostics.delete(id);
    this.options.store.dispatch(conversationDeliveryActions.diagnosticForgotten(id));
  }

  private observe(change: TopicConversationStateChange): void {
    if (this.disposed) return;
    this.snapshotValue = change.snapshot;
    this.revisionValue = change.revision;
    const desiredRevision = this.nextDesiredRevision();
    for (const turn of change.snapshot.turns) {
      for (const card of turn.response.cards) {
        if (this.settledArtifacts.has(card.id)) continue;
        const record = this.records.get(card.id) ?? {
          cardId: card.id,
          responseId: turn.response.id,
          externalMessageId: null,
          desiredRevision,
          deliveredRevision: null,
          status: "dirty" as const,
          attempts: 0,
          worker: null,
        };
        record.responseId = turn.response.id;
        record.desiredRevision = desiredRevision;
        if (record.status !== "rendering") record.status = "dirty";
        this.records.set(card.id, record);
        this.publishRecord(record);
        this.schedule(record);
      }
    }
  }

  private nextDesiredRevision(): number {
    this.desiredClock = Math.max(this.desiredClock + 1, this.revisionValue);
    return this.desiredClock;
  }

  private schedule(record: DeliveryRecord): void {
    if (this.disposed || record.worker !== null) return;
    record.worker = this.run(record)
      .catch((error) => {
        record.status = "failed";
        this.publishRecord(record);
        this.options.logger.warn(
          { error, responseId: record.responseId, cardId: record.cardId },
          "conversation Card reconciler worker failed",
        );
      })
      .finally(() => {
        record.worker = null;
        if (!this.disposed && record.deliveredRevision !== record.desiredRevision) {
          if (record.status === "dirty") this.schedule(record);
        }
      });
  }

  private async run(record: DeliveryRecord): Promise<void> {
    while (!this.disposed && record.deliveredRevision !== record.desiredRevision) {
      const attemptedRevision = record.desiredRevision;
      const desired = this.projectLatest(record);
      if (desired === null) return;
      record.status = "rendering";
      this.publishRecord(record);
      const outcome = await this.write(record, desired.view).catch((error) => {
        this.options.logger.warn(
          { error, responseId: record.responseId, cardId: record.cardId },
          "conversation Card transport rejected",
        );
        return false;
      });
      if (outcome) {
        record.attempts = 0;
        record.deliveredRevision = attemptedRevision;
        record.status = record.deliveredRevision === record.desiredRevision ? "settled" : "dirty";
        this.publishRecord(record);
        this.markDiagnosticsDisplayed(record.cardId, desired.diagnosticIds);
        this.options.onCardVisible?.(record.responseId, record.cardId);
        if (record.status === "settled") this.maybeEvict(record, desired.kind);
        continue;
      }

      record.attempts += 1;
      this.recordPatchFailure(record, desired.kind);
      const maxAttempts = this.options.maxPatchAttempts ?? 2;
      if (record.attempts >= maxAttempts) {
        record.status = "failed";
        this.publishRecord(record);
        if (this.maybeFinalizeFailedTerminal(record)) return;
        this.maybeEvictFailedRetiring(record, desired.kind);
        return;
      }
      record.status = "retrying";
      this.publishRecord(record);
      await delay(this.options.retryDelayMs ?? 100);
      record.status = "dirty";
      this.publishRecord(record);
    }
  }

  private projectLatest(record: DeliveryRecord): {
    readonly view: ConversationCardView;
    readonly kind: "intermediate" | "tail";
    readonly diagnosticIds: readonly number[];
  } | null {
    const response = this.snapshotValue.turns.find(
      (turn) => turn.response.id === record.responseId,
    )?.response;
    const card = response?.cards.find((candidate) => candidate.id === record.cardId);
    if (response === undefined || card === undefined) {
      this.forgetRecord(record.cardId);
      return null;
    }
    const projection = this.projector.project(this.snapshotValue, record.responseId, record.cardId);
    let view = this.mapper.toView(this.snapshotValue, projection, this.options.route);
    if (!this.options.showCancelButton && view.kind === "active") {
      const { cancelAction: _cancelAction, ...withoutCancel } = view;
      view = withoutCancel;
    }
    const applicable =
      view.kind === "starting"
        ? []
        : [...this.diagnostics.values()].filter(
            (diagnostic) =>
              diagnostic.responseId === record.responseId &&
              ((diagnostic.status === "pending" && projection.kind === "tail") ||
                (diagnostic.status === "displayed" &&
                  diagnostic.displayedOnCardId === record.cardId)),
          );
    const diagnosticIds = applicable.map((diagnostic) => diagnostic.id);
    if (diagnosticIds.length > 0) view = appendWarning(view);
    return { view, kind: projection.kind, diagnosticIds };
  }

  private async write(record: DeliveryRecord, view: ConversationCardView): Promise<boolean> {
    if (record.externalMessageId === null) {
      const send = this.options.presenter.sendConversationCard;
      if (typeof send !== "function") return false;
      const anchor = this.anchors.get(record.cardId);
      if (anchor === undefined) {
        this.options.logger.warn(
          { responseId: record.responseId, cardId: record.cardId },
          "conversation Card has no delivery anchor",
        );
        return false;
      }
      const externalId = await send.call(this.options.presenter, anchor, view);
      if (externalId === null) return false;
      record.externalMessageId = externalId;
      this.publishRecord(record);
      return true;
    }
    const update = this.options.presenter.updateConversationCard;
    if (typeof update !== "function") return false;
    return update.call(this.options.presenter, record.externalMessageId, view);
  }

  private recordPatchFailure(record: DeliveryRecord, kind: "intermediate" | "tail"): void {
    this.options.logger.warn(
      { responseId: record.responseId, cardId: record.cardId },
      "conversation Card reconciliation failed",
    );
    if (kind !== "intermediate") return;
    const existing = [...this.diagnostics.values()].some(
      (diagnostic) =>
        diagnostic.responseId === record.responseId && diagnostic.failedCardId === record.cardId,
    );
    if (existing) return;
    const diagnostic: DeliveryDiagnostic = {
      id: ++this.diagnosticClock,
      responseId: record.responseId,
      failedCardId: record.cardId,
      status: "pending",
      displayedOnCardId: null,
    };
    this.diagnostics.set(diagnostic.id, diagnostic);
    this.publishDiagnostic(diagnostic);
    this.markCurrentTailDirty(record.responseId);
  }

  private markCurrentTailDirty(responseId: ResponseId): void {
    const response = this.snapshotValue.turns.find(
      (turn) => turn.response.id === responseId,
    )?.response;
    const tail = response?.cards.at(-1);
    if (tail === undefined) return;
    const record = this.records.get(tail.id);
    if (record === undefined) return;
    record.desiredRevision = this.nextDesiredRevision();
    if (record.status !== "rendering") record.status = "dirty";
    this.publishRecord(record);
    this.schedule(record);
  }

  private markDiagnosticsDisplayed(cardId: ResponseCardId, ids: readonly number[]): void {
    const currentTailByResponse = new Map(
      this.snapshotValue.turns.map((turn) => [turn.response.id, turn.response.cards.at(-1)?.id]),
    );
    for (const id of ids) {
      const diagnostic = this.diagnostics.get(id);
      if (diagnostic === undefined || diagnostic.status !== "pending") continue;
      if (currentTailByResponse.get(diagnostic.responseId) !== cardId) {
        this.markCurrentTailDirty(diagnostic.responseId);
        continue;
      }
      diagnostic.status = "displayed";
      diagnostic.displayedOnCardId = cardId;
      this.publishDiagnostic(diagnostic);
      this.maybeEvictFailedCard(diagnostic.failedCardId);
    }
  }

  private maybeEvict(record: DeliveryRecord, kind: "intermediate" | "tail"): void {
    const response = this.snapshotValue.turns.find(
      (turn) => turn.response.id === record.responseId,
    )?.response;
    if (response === undefined) return;
    if (kind === "intermediate") {
      const diagnosticStillAttached = [...this.diagnostics.values()].some(
        (diagnostic) => diagnostic.displayedOnCardId === record.cardId,
      );
      if (diagnosticStillAttached) {
        for (const [id, diagnostic] of this.diagnostics) {
          if (diagnostic.displayedOnCardId === record.cardId) this.forgetDiagnostic(id);
        }
      }
      this.forgetRecord(record.cardId);
      this.options.onSettledImmutable?.(record.responseId, record.cardId, "intermediate");
      this.finalizeCurrentTerminalIfReady(record.responseId);
      return;
    }
    if (response.state.kind === "terminal") {
      const hasOtherDeliveryWork = [...this.records.values()].some(
        (candidate) =>
          candidate.responseId === record.responseId && candidate.cardId !== record.cardId,
      );
      const hasPendingDiagnostic = [...this.diagnostics.values()].some(
        (diagnostic) =>
          diagnostic.responseId === record.responseId && diagnostic.status === "pending",
      );
      if (hasOtherDeliveryWork || hasPendingDiagnostic) return;
      this.forgetRecord(record.cardId);
      this.settledArtifacts.add(record.cardId);
      for (const [id, diagnostic] of this.diagnostics) {
        if (
          diagnostic.responseId === record.responseId &&
          diagnostic.status === "displayed" &&
          diagnostic.displayedOnCardId === record.cardId
        ) {
          this.forgetDiagnostic(id);
        }
      }
      this.options.onSettledImmutable?.(record.responseId, record.cardId, "terminal");
    }
  }

  private finalizeCurrentTerminalIfReady(responseId: ResponseId): void {
    const response = this.snapshotValue.turns.find(
      (turn) => turn.response.id === responseId,
    )?.response;
    const tail = response?.cards.at(-1);
    if (response?.state.kind !== "terminal" || tail === undefined) return;
    const terminal = this.records.get(tail.id);
    if (terminal?.status === "settled") this.maybeEvict(terminal, "tail");
    else if (terminal?.status === "failed") this.maybeFinalizeFailedTerminal(terminal);
  }

  private maybeFinalizeFailedTerminal(record: DeliveryRecord): boolean {
    const response = this.snapshotValue.turns.find(
      (turn) => turn.response.id === record.responseId,
    )?.response;
    const tail = response?.cards.at(-1);
    if (
      response?.state.kind !== "terminal" ||
      tail?.id !== record.cardId ||
      record.status !== "failed"
    ) {
      return false;
    }
    const hasOtherDeliveryWork = [...this.records.values()].some(
      (candidate) =>
        candidate.responseId === record.responseId && candidate.cardId !== record.cardId,
    );
    const hasPendingDiagnostic = [...this.diagnostics.values()].some(
      (diagnostic) =>
        diagnostic.responseId === record.responseId && diagnostic.status === "pending",
    );
    if (hasOtherDeliveryWork || hasPendingDiagnostic) return false;
    this.forgetRecord(record.cardId);
    this.settledArtifacts.add(record.cardId);
    this.options.onSettledImmutable?.(record.responseId, record.cardId, "terminal");
    return true;
  }

  private maybeEvictFailedRetiring(record: DeliveryRecord, kind: "intermediate" | "tail"): void {
    if (kind !== "intermediate") return;
    this.maybeEvictFailedCard(record.cardId);
  }

  private maybeEvictFailedCard(cardId: ResponseCardId): void {
    const record = this.records.get(cardId);
    if (record?.status !== "failed") return;
    const pending = [...this.diagnostics.values()].some(
      (diagnostic) => diagnostic.failedCardId === cardId && diagnostic.status === "pending",
    );
    if (pending) return;
    this.forgetRecord(record.cardId);
    this.options.onSettledImmutable?.(record.responseId, record.cardId, "intermediate");
    this.finalizeCurrentTerminalIfReady(record.responseId);
  }
}

function appendWarning(view: ConversationCardView): ConversationCardView {
  const warning = { kind: "text" as const, text: PATCH_FAILURE_WARNING };
  switch (view.kind) {
    case "queued":
    case "interrupting":
    case "active":
    case "orphaned":
      return { ...view, entries: [...view.entries, warning] };
    case "archived":
      return { ...view, entries: [...view.entries, warning] };
    case "terminal":
      return { ...view, entries: [...view.entries, warning] };
    case "starting":
      return view;
  }
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
