import type { SessionCardMeta } from "../presenter/presenter.js";
import { utf8PartsByteLength } from "../presenter/card-text-budget.js";
import type {
  ActionToken,
  ArchivedTimelineEntry,
  CardRoute,
  ConversationCardView,
  ConversationTimelineEntry,
  OwnershipToken,
  PermissionToken,
  PromptToken,
  SegmentToken,
  TerminalTimelineEntry,
  ToolStatus,
} from "../presenter/conversation-card-view.js";
import type { DiagnosticCorrelation, SemanticPhase } from "./lifecycle-diagnostics.js";

export type TerminalOutcome = "complete" | "cancelled" | "failed" | "superseded" | "abandoned";
export type ArchiveReason = "rotation" | "permission_boundary" | "idle_rotation";
export type StaleEventReason =
  | "stale_prompt"
  | "stale_segment"
  | "stale_timer"
  | "terminal_absorbed"
  | "conflicting_terminal"
  | "tool_regression";

export type PermissionViewData = {
  readonly requestId: string;
  readonly title: string;
  readonly toolKind: string;
  readonly toolTitle: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind?: string;
  }[];
};

export type ToolEvent = {
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: string;
  readonly status: ToolStatus;
  readonly detail?: string;
};

export type ToolLedgerEntry = ToolEvent & { readonly displaySegmentToken: SegmentToken | null };
export type ToolLedger = Readonly<Record<string, ToolLedgerEntry>>;

export type AcknowledgementState =
  | { readonly phase: "none" }
  | { readonly phase: "attached"; readonly messageId: string; readonly reactionId: string }
  | { readonly phase: "removal_pending"; readonly messageId: string; readonly reactionId: string }
  | { readonly phase: "removal_attempted"; readonly outcome: "removed" | "failed" };

type ArchivedSegment = {
  readonly reason: ArchiveReason;
  readonly segmentToken: SegmentToken;
  readonly entries: readonly ArchivedTimelineEntry[];
};

type RenderState = {
  readonly desiredGeneration: number;
  readonly submittedGeneration: number;
  readonly flushScheduled: boolean;
  readonly timerGeneration: number;
};

type PromptLifecycleBase = {
  readonly promptToken: PromptToken;
  readonly ownershipToken: OwnershipToken;
  readonly profile: SessionCardMeta | null;
  readonly route: CardRoute;
  readonly correlation: Omit<DiagnosticCorrelation, "ownerSequence">;
  readonly acknowledgement: AcknowledgementState;
  readonly archived: readonly ArchivedSegment[];
  readonly toolLedger: ToolLedger;
  readonly render: RenderState;
};

type PreActiveState = PromptLifecycleBase & {
  readonly phase: "queued" | "interrupting" | "starting";
  readonly segmentToken: SegmentToken;
};

type ActiveState = PromptLifecycleBase & {
  readonly phase: "active";
  readonly activity: "thinking" | "waiting" | "calling_tool" | "responding";
  readonly display: "content" | "idle_slot";
  readonly segmentToken: SegmentToken;
  readonly actionToken: ActionToken;
  readonly entries: readonly ConversationTimelineEntry[];
};

type AwaitingPermissionState = PromptLifecycleBase & {
  readonly phase: "awaiting_permission";
  readonly segmentToken: null;
  readonly permissionToken: PermissionToken;
  readonly permission: PermissionViewData;
};

type TerminalState = PromptLifecycleBase & {
  readonly phase: "terminal";
  readonly outcome: TerminalOutcome;
  readonly segmentToken: SegmentToken | null;
  readonly entries: readonly TerminalTimelineEntry[];
  readonly presentation: "conversation_card" | "permission_card_only";
};

export type PromptLifecycleState =
  PreActiveState | ActiveState | AwaitingPermissionState | TerminalState;

export type CreatePromptLifecycleInput = {
  readonly promptToken: PromptToken;
  readonly initialSegmentToken: SegmentToken;
  readonly ownershipToken: OwnershipToken;
  readonly initialPhase: "queued" | "interrupting" | "starting";
  readonly profile: SessionCardMeta | null;
  readonly route: CardRoute;
  readonly correlation: Omit<DiagnosticCorrelation, "ownerSequence">;
  readonly acknowledgement?: { readonly messageId: string; readonly reactionId: string };
};

export type ConversationCardEvent =
  | {
      readonly type: "prompt_acknowledged";
      readonly promptToken: PromptToken;
      readonly messageId: string;
      readonly reactionId?: string;
    }
  | {
      readonly type: "preparing";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly profile: SessionCardMeta | null;
    }
  | { readonly type: "queued" | "interrupting"; readonly promptToken: PromptToken }
  | {
      readonly type: "forwarded";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly actionToken: ActionToken;
    }
  | {
      readonly type: "agent_text" | "agent_thought";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly text: string;
    }
  | {
      readonly type: "tool_started";
      readonly promptToken: PromptToken;
      readonly displaySegmentToken: SegmentToken;
      readonly tool: ToolEvent;
    }
  | {
      readonly type: "tool_updated";
      readonly promptToken: PromptToken;
      readonly displaySegmentToken: SegmentToken | null;
      readonly tool: ToolEvent;
    }
  | {
      readonly type: "archive_segment";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly reason: ArchiveReason;
      readonly nextSegmentToken: SegmentToken;
      readonly nextActionToken: ActionToken;
      readonly nextOwnershipToken: OwnershipToken;
      readonly nextProfile: SessionCardMeta | null;
    }
  | {
      readonly type: "open_idle_slot";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly timerGeneration: number;
      readonly nextSegmentToken: SegmentToken;
      readonly nextActionToken: ActionToken;
      readonly nextOwnershipToken: OwnershipToken;
      readonly nextProfile: SessionCardMeta | null;
    }
  | {
      readonly type: "permission_requested";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly permissionToken: PermissionToken;
      readonly permission: PermissionViewData;
    }
  | {
      readonly type: "permission_resolved";
      readonly promptToken: PromptToken;
      readonly permissionToken: PermissionToken;
      readonly nextSegmentToken: SegmentToken;
      readonly nextActionToken: ActionToken;
      readonly nextOwnershipToken: OwnershipToken;
      readonly nextProfile: SessionCardMeta | null;
    }
  | {
      readonly type: "flush_due";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
    }
  | {
      readonly type: "acknowledgement_visible";
      readonly promptToken: PromptToken;
      readonly cardId: string;
    }
  | {
      readonly type: "acknowledgement_removed" | "acknowledgement_remove_failed";
      readonly promptToken: PromptToken;
    }
  | {
      readonly type: "finish";
      readonly promptToken: PromptToken;
      readonly outcome: TerminalOutcome;
    };

export type CardEffect =
  | {
      readonly type: "render";
      readonly view: ConversationCardView;
      readonly ownershipToken: OwnershipToken;
      readonly generation?: number;
    }
  | {
      readonly type: "close";
      readonly view: Extract<ConversationCardView, { kind: "archived" | "terminal" }>;
      readonly ownershipToken: OwnershipToken;
    }
  | { readonly type: "revoke_action"; readonly actionToken: ActionToken }
  | {
      readonly type: "schedule_flush";
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
    }
  | {
      readonly type: "begin_permission_handoff";
      readonly ownershipToken: OwnershipToken;
      readonly promptToken: PromptToken;
      readonly segmentToken: SegmentToken;
      readonly permissionToken: PermissionToken;
      readonly permission: PermissionViewData;
    }
  | {
      readonly type: "remove_acknowledgement";
      readonly promptToken: PromptToken;
      readonly messageId: string;
      readonly reactionId: string;
    }
  | {
      readonly type: "expire_permission";
      readonly promptToken: PromptToken;
      readonly permissionToken: PermissionToken;
      readonly reason: TerminalOutcome;
    }
  | {
      readonly type: "reconcile_permission_artifact";
      readonly cardId: string;
      readonly promptToken: PromptToken;
      readonly permissionToken: PermissionToken;
      readonly reason: string;
    };

export type TransitionDiagnostic = {
  readonly correlation: Omit<DiagnosticCorrelation, "ownerSequence">;
  readonly from: SemanticPhase;
  readonly to: SemanticPhase;
  readonly event: ConversationCardEvent["type"];
  readonly entryCount: number;
  readonly utf8Bytes: number;
  readonly actionRevoked: boolean;
  readonly staleReason?: StaleEventReason;
};

export type TransitionResult = {
  readonly next: PromptLifecycleState;
  readonly effects: readonly CardEffect[];
  readonly diagnostic: TransitionDiagnostic;
};

const EMPTY_RENDER: RenderState = {
  desiredGeneration: 0,
  submittedGeneration: 0,
  flushScheduled: false,
  timerGeneration: 0,
};

export function createPromptLifecycle(input: CreatePromptLifecycleInput): PromptLifecycleState {
  return {
    phase: input.initialPhase,
    promptToken: input.promptToken,
    segmentToken: input.initialSegmentToken,
    ownershipToken: input.ownershipToken,
    profile: input.profile,
    route: input.route,
    correlation: input.correlation,
    acknowledgement:
      input.acknowledgement === undefined
        ? { phase: "none" }
        : { phase: "attached", ...input.acknowledgement },
    archived: [],
    toolLedger: {},
    render: EMPTY_RENDER,
  };
}

function terminalToolStatus(status: ToolStatus, outcome: TerminalOutcome): ToolStatus {
  if (status !== "pending" && status !== "in_progress") return status;
  if (outcome === "failed" || (outcome === "abandoned" && status === "in_progress"))
    return "failed";
  return "interrupted";
}

function terminalEntries(
  entries: readonly ConversationTimelineEntry[],
  outcome: TerminalOutcome,
): readonly TerminalTimelineEntry[] {
  return entries.map((entry) =>
    entry.kind !== "tool"
      ? entry
      : ({ ...entry, status: terminalToolStatus(entry.status, outcome) } as TerminalTimelineEntry),
  );
}

function terminalLedger(ledger: ToolLedger, outcome: TerminalOutcome): ToolLedger {
  return Object.fromEntries(
    Object.entries(ledger).map(([id, entry]) => [
      id,
      { ...entry, status: terminalToolStatus(entry.status, outcome) },
    ]),
  );
}

function summary(entries: readonly ConversationTimelineEntry[]): string {
  const visible = entries.find((entry) => entry.kind === "text" || entry.kind === "thought");
  if (visible?.kind === "text" || visible?.kind === "thought") return visible.text;
  const tool = entries.find((entry) => entry.kind === "tool");
  return tool?.kind === "tool" ? tool.title : "";
}

export function viewForPromptState(state: PromptLifecycleState): ConversationCardView | null {
  switch (state.phase) {
    case "queued":
      return {
        kind: "queued",
        header: "queued",
        entries: [],
        profile: state.profile,
        route: state.route,
      };
    case "interrupting":
      return {
        kind: "interrupting",
        header: "interrupting",
        entries: [],
        profile: state.profile,
        route: state.route,
      };
    case "starting":
      return {
        kind: "starting",
        header: "preparing",
        entries: [],
        profile: state.profile,
        route: state.route,
      };
    case "active":
      return {
        kind: "active",
        header: state.activity,
        entries: state.entries,
        profile: state.profile,
        cancelAction: { p: state.promptToken, s: state.segmentToken, a: state.actionToken },
        route: state.route,
      };
    case "awaiting_permission":
      return null;
    case "terminal":
      return state.presentation === "permission_card_only"
        ? null
        : {
            kind: "terminal",
            header: state.outcome,
            entries: state.entries,
            profile: state.profile,
            body:
              state.entries.length === 0 && state.outcome === "complete"
                ? "empty_complete"
                : "content",
            route: state.route,
          };
  }
}

function archivedView(state: ActiveState): Extract<ConversationCardView, { kind: "archived" }> {
  const entries = terminalEntries(state.entries, "cancelled") as readonly ArchivedTimelineEntry[];
  if (entries.length === 0) throw new Error("cannot archive an empty segment");
  return {
    kind: "archived",
    entries: entries as [ArchivedTimelineEntry, ...ArchivedTimelineEntry[]],
    summary: summary(entries),
    route: state.route,
  };
}

function phase(state: PromptLifecycleState): SemanticPhase {
  return state.phase;
}
function entryList(state: PromptLifecycleState): readonly ConversationTimelineEntry[] {
  return state.phase === "active" || state.phase === "terminal" ? state.entries : [];
}

function makeDiagnostic(
  state: PromptLifecycleState,
  next: PromptLifecycleState,
  event: ConversationCardEvent,
  staleReason?: StaleEventReason,
  actionRevoked = false,
): TransitionDiagnostic {
  const entries = entryList(next);
  const parts = entries.flatMap((entry) =>
    entry.kind === "tool" ? [entry.title, entry.toolKind, entry.detail ?? ""] : [entry.text],
  );
  return {
    correlation: next.correlation,
    from: phase(state),
    to: phase(next),
    event: event.type,
    entryCount: entries.length,
    utf8Bytes: utf8PartsByteLength(parts),
    actionRevoked,
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

function result(
  state: PromptLifecycleState,
  next: PromptLifecycleState,
  event: ConversationCardEvent,
  effects: readonly CardEffect[] = [],
  staleReason?: StaleEventReason,
  actionRevoked = false,
): TransitionResult {
  return {
    next,
    effects,
    diagnostic: makeDiagnostic(state, next, event, staleReason, actionRevoked),
  };
}

function renderImmediately(state: PromptLifecycleState): CardEffect[] {
  const view = viewForPromptState(state);
  return view === null ? [] : [{ type: "render", view, ownershipToken: state.ownershipToken }];
}

function scheduleRender(state: ActiveState): { next: ActiveState; effects: CardEffect[] } {
  const render = {
    ...state.render,
    desiredGeneration: state.render.desiredGeneration + 1,
    flushScheduled: true,
    timerGeneration: state.render.timerGeneration + 1,
  };
  return {
    next: { ...state, render },
    effects: state.render.flushScheduled
      ? []
      : [
          {
            type: "schedule_flush",
            promptToken: state.promptToken,
            segmentToken: state.segmentToken,
          },
        ],
  };
}

function appendText(state: ActiveState, kind: "text" | "thought", text: string): ActiveState {
  const last = state.entries.at(-1);
  const entries: readonly ConversationTimelineEntry[] =
    last?.kind === kind
      ? [...state.entries.slice(0, -1), { kind, text: `${last.text}${text}` }]
      : [...state.entries, { kind, text }];
  const hasRunningTool = entries.some(
    (entry) => entry.kind === "tool" && RUNNING.has(entry.status),
  );
  return {
    ...state,
    activity: hasRunningTool ? "calling_tool" : kind === "text" ? "responding" : state.activity,
    display: "content",
    entries,
  };
}

const RUNNING = new Set<ToolStatus>(["pending", "in_progress"]);
const TERMINAL = new Set<ToolStatus>(["completed", "failed", "interrupted"]);

function applyTool(
  state: PromptLifecycleState,
  event: Extract<ConversationCardEvent, { type: "tool_started" | "tool_updated" }>,
): { next: PromptLifecycleState; staleReason?: StaleEventReason; changed: boolean } {
  const current = state.toolLedger[event.tool.toolCallId];
  let accepted = event.tool;
  let staleReason: StaleEventReason | undefined;
  if (current !== undefined) {
    if (TERMINAL.has(current.status)) {
      if (RUNNING.has(event.tool.status)) {
        return { next: state, staleReason: "tool_regression", changed: false };
      }
      if (current.status !== event.tool.status) {
        return { next: state, staleReason: "conflicting_terminal", changed: false };
      }
      accepted = { ...current, ...event.tool };
    } else if (current.status === "in_progress" && event.tool.status === "pending") {
      return { next: state, staleReason: "tool_regression", changed: false };
    }
  }
  const marker: ToolLedgerEntry = { ...accepted, displaySegmentToken: event.displaySegmentToken };
  let next: PromptLifecycleState = {
    ...state,
    toolLedger: { ...state.toolLedger, [accepted.toolCallId]: marker },
  };
  if (next.phase === "active" && event.displaySegmentToken === next.segmentToken) {
    const index = next.entries.findIndex(
      (entry) => entry.kind === "tool" && entry.toolCallId === accepted.toolCallId,
    );
    const toolEntry: ConversationTimelineEntry = {
      kind: "tool",
      toolCallId: accepted.toolCallId,
      title: accepted.title,
      toolKind: accepted.toolKind,
      status: accepted.status,
      ...(accepted.detail === undefined ? {} : { detail: accepted.detail }),
    };
    const entries =
      index < 0
        ? [...next.entries, toolEntry]
        : next.entries.map((entry, position) => (position === index ? toolEntry : entry));
    const hasRunningTool = entries.some(
      (entry) => entry.kind === "tool" && RUNNING.has(entry.status),
    );
    next = {
      ...next,
      entries,
      activity: hasRunningTool
        ? "calling_tool"
        : next.entries.some((entry) => entry.kind === "text")
          ? "responding"
          : "thinking",
      display: "content",
      render: { ...next.render, timerGeneration: next.render.timerGeneration + 1 },
    };
  }
  return { next, staleReason, changed: true };
}

function removeAck(state: PromptLifecycleState): {
  acknowledgement: AcknowledgementState;
  effects: CardEffect[];
} {
  if (state.acknowledgement.phase !== "attached")
    return { acknowledgement: state.acknowledgement, effects: [] };
  const { messageId, reactionId } = state.acknowledgement;
  return {
    acknowledgement: { phase: "removal_pending", messageId, reactionId },
    effects: [
      { type: "remove_acknowledgement", promptToken: state.promptToken, messageId, reactionId },
    ],
  };
}

export function reducePromptLifecycle(
  state: PromptLifecycleState,
  event: ConversationCardEvent,
): TransitionResult {
  if (event.promptToken !== state.promptToken)
    return result(state, state, event, [], "stale_prompt");
  if (state.phase === "terminal") {
    if (
      event.type === "acknowledgement_removed" ||
      event.type === "acknowledgement_remove_failed"
    ) {
      if (state.acknowledgement.phase !== "removal_pending") return result(state, state, event);
      const next: TerminalState = {
        ...state,
        acknowledgement: {
          phase: "removal_attempted",
          outcome: event.type === "acknowledgement_removed" ? "removed" : "failed",
        },
      };
      return result(state, next, event);
    }
    return result(state, state, event, [], "terminal_absorbed");
  }

  if (event.type === "prompt_acknowledged") {
    if (state.acknowledgement.phase !== "none" || event.reactionId === undefined)
      return result(state, state, event);
    return result(
      state,
      {
        ...state,
        acknowledgement: {
          phase: "attached",
          messageId: event.messageId,
          reactionId: event.reactionId,
        },
      },
      event,
    );
  }
  if (event.type === "acknowledgement_visible") {
    const ack = removeAck(state);
    return result(state, { ...state, acknowledgement: ack.acknowledgement }, event, ack.effects);
  }
  if (event.type === "acknowledgement_removed" || event.type === "acknowledgement_remove_failed") {
    if (state.acknowledgement.phase !== "removal_pending") return result(state, state, event);
    return result(
      state,
      {
        ...state,
        acknowledgement: {
          phase: "removal_attempted",
          outcome: event.type === "acknowledgement_removed" ? "removed" : "failed",
        },
      },
      event,
    );
  }
  if (event.type === "queued" && state.phase === "interrupting") {
    const next: PreActiveState = { ...state, phase: "queued" };
    return result(state, next, event, renderImmediately(next));
  }
  if (event.type === "interrupting" && state.phase === "queued") {
    const next: PreActiveState = { ...state, phase: "interrupting" };
    return result(state, next, event, renderImmediately(next));
  }
  if (event.type === "preparing") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "queued" && state.phase !== "interrupting")
      return result(state, state, event);
    const next: PreActiveState = { ...state, phase: "starting", profile: event.profile };
    return result(state, next, event, renderImmediately(next));
  }
  if (event.type === "forwarded") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "starting") return result(state, state, event);
    const next: ActiveState = {
      ...state,
      phase: "active",
      activity: "thinking",
      display: "content",
      actionToken: event.actionToken,
      entries: [],
    };
    return result(state, next, event, renderImmediately(next));
  }
  if (event.type === "agent_text" || event.type === "agent_thought") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "active") return result(state, state, event);
    const scheduled = scheduleRender(
      appendText(state, event.type === "agent_text" ? "text" : "thought", event.text),
    );
    return result(state, scheduled.next, event, scheduled.effects);
  }
  if (event.type === "tool_started" || event.type === "tool_updated") {
    const applied = applyTool(state, event);
    if (!applied.changed || applied.next.phase !== "active")
      return result(state, applied.next, event, [], applied.staleReason);
    const scheduled = scheduleRender(applied.next);
    return result(state, scheduled.next, event, scheduled.effects, applied.staleReason);
  }
  if (event.type === "flush_due") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "active" || !state.render.flushScheduled)
      return result(state, state, event, [], "stale_timer");
    const generation = state.render.desiredGeneration;
    const next: ActiveState = {
      ...state,
      render: { ...state.render, flushScheduled: false, submittedGeneration: generation },
    };
    const view = viewForPromptState(next);
    return result(
      state,
      next,
      event,
      view === null
        ? []
        : [{ type: "render", view, ownershipToken: next.ownershipToken, generation }],
    );
  }
  if (event.type === "archive_segment") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "active" || state.entries.length === 0) return result(state, state, event);
    const view = archivedView(state);
    const next: ActiveState = {
      ...state,
      phase: "active",
      activity: "thinking",
      display: "content",
      segmentToken: event.nextSegmentToken,
      actionToken: event.nextActionToken,
      ownershipToken: event.nextOwnershipToken,
      profile: event.nextProfile,
      entries: [],
      archived: [
        ...state.archived,
        { reason: event.reason, segmentToken: state.segmentToken, entries: view.entries },
      ],
      render: {
        ...state.render,
        flushScheduled: false,
        timerGeneration: state.render.timerGeneration + 1,
      },
    };
    return result(
      state,
      next,
      event,
      [
        { type: "revoke_action", actionToken: state.actionToken },
        { type: "close", view, ownershipToken: state.ownershipToken },
      ],
      undefined,
      true,
    );
  }
  if (event.type === "open_idle_slot") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "active" || event.timerGeneration !== state.render.timerGeneration)
      return result(state, state, event, [], "stale_timer");
    const effects: CardEffect[] = [{ type: "revoke_action", actionToken: state.actionToken }];
    const archived = [...state.archived];
    if (state.entries.length > 0) {
      const view = archivedView(state);
      archived.push({
        reason: "idle_rotation",
        segmentToken: state.segmentToken,
        entries: view.entries,
      });
      effects.push({ type: "close", view, ownershipToken: state.ownershipToken });
    }
    const next: ActiveState = {
      ...state,
      activity: "waiting",
      display: "idle_slot",
      segmentToken: event.nextSegmentToken,
      actionToken: event.nextActionToken,
      ownershipToken: event.nextOwnershipToken,
      profile: event.nextProfile,
      entries: [],
      archived,
      render: {
        ...state.render,
        flushScheduled: false,
        timerGeneration: state.render.timerGeneration + 1,
      },
    };
    effects.push(...renderImmediately(next));
    return result(state, next, event, effects, undefined, true);
  }
  if (event.type === "permission_requested") {
    if (event.segmentToken !== state.segmentToken)
      return result(state, state, event, [], "stale_segment");
    if (state.phase !== "active") return result(state, state, event);
    const effects: CardEffect[] = [{ type: "revoke_action", actionToken: state.actionToken }];
    const archived = [...state.archived];
    if (state.entries.length > 0) {
      const view = archivedView(state);
      archived.push({
        reason: "permission_boundary",
        segmentToken: state.segmentToken,
        entries: view.entries,
      });
      effects.push({ type: "close", view, ownershipToken: state.ownershipToken });
    }
    effects.push({
      type: "begin_permission_handoff",
      ownershipToken: state.ownershipToken,
      promptToken: state.promptToken,
      segmentToken: state.segmentToken,
      permissionToken: event.permissionToken,
      permission: event.permission,
    });
    const next: AwaitingPermissionState = {
      ...state,
      phase: "awaiting_permission",
      segmentToken: null,
      permissionToken: event.permissionToken,
      permission: event.permission,
      archived,
      render: {
        ...state.render,
        flushScheduled: false,
        timerGeneration: state.render.timerGeneration + 1,
      },
    };
    return result(state, next, event, effects, undefined, true);
  }
  if (event.type === "permission_resolved") {
    if (state.phase !== "awaiting_permission" || event.permissionToken !== state.permissionToken)
      return result(state, state, event, [], "stale_segment");
    const resumedEntries: ConversationTimelineEntry[] = Object.values(state.toolLedger)
      .filter((entry) => entry.displaySegmentToken === null && TERMINAL.has(entry.status))
      .map((entry) => ({
        kind: "tool" as const,
        toolCallId: entry.toolCallId,
        title: entry.title,
        toolKind: entry.toolKind,
        status: entry.status,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      }));
    const resumedLedger: ToolLedger = Object.fromEntries(
      Object.entries(state.toolLedger).map(([id, entry]) => [
        id,
        entry.displaySegmentToken === null && TERMINAL.has(entry.status)
          ? { ...entry, displaySegmentToken: event.nextSegmentToken }
          : entry,
      ]),
    );
    const next: ActiveState = {
      ...state,
      phase: "active",
      segmentToken: event.nextSegmentToken,
      actionToken: event.nextActionToken,
      ownershipToken: event.nextOwnershipToken,
      profile: event.nextProfile,
      activity: "thinking",
      display: "content",
      entries: resumedEntries,
      toolLedger: resumedLedger,
    };
    return result(state, next, event, renderImmediately(next));
  }
  if (event.type === "finish") {
    const ack = removeAck(state);
    const actionEffects: CardEffect[] =
      state.phase === "active" ? [{ type: "revoke_action", actionToken: state.actionToken }] : [];
    if (state.phase === "awaiting_permission") {
      const next: TerminalState = {
        ...state,
        phase: "terminal",
        outcome: event.outcome,
        entries: [],
        toolLedger: terminalLedger(state.toolLedger, event.outcome),
        presentation: "permission_card_only",
        acknowledgement: ack.acknowledgement,
        render: {
          ...state.render,
          flushScheduled: false,
          timerGeneration: state.render.timerGeneration + 1,
        },
      };
      return result(state, next, event, [
        ...actionEffects,
        {
          type: "expire_permission",
          promptToken: state.promptToken,
          permissionToken: state.permissionToken,
          reason: event.outcome,
        },
        ...ack.effects,
      ]);
    }
    const entries = state.phase === "active" ? terminalEntries(state.entries, event.outcome) : [];
    const next: TerminalState = {
      ...state,
      phase: "terminal",
      outcome: event.outcome,
      entries,
      toolLedger: terminalLedger(state.toolLedger, event.outcome),
      presentation: "conversation_card",
      acknowledgement: ack.acknowledgement,
      render: {
        ...state.render,
        flushScheduled: false,
        timerGeneration: state.render.timerGeneration + 1,
      },
    };
    const view = viewForPromptState(next);
    const closeEffects: CardEffect[] =
      view?.kind === "terminal"
        ? [{ type: "close", view, ownershipToken: state.ownershipToken }]
        : [];
    return result(
      state,
      next,
      event,
      [...actionEffects, ...closeEffects, ...ack.effects],
      undefined,
      state.phase === "active",
    );
  }
  return result(state, state, event);
}
