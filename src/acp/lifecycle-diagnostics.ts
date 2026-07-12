export interface DiagnosticCorrelation {
  readonly runtimeSequence: number;
  readonly promptSequence: number;
  readonly segmentSequence: number | null;
  readonly ownerSequence: number | null;
}

export type SemanticPhase =
  | "idle"
  | "queued"
  | "interrupting"
  | "starting"
  | "active"
  | "awaiting_permission"
  | "archived"
  | "terminal";

export type LifecycleTransitionName =
  | "prompt_acknowledged"
  | "preparing"
  | "forwarded"
  | "agent_text"
  | "agent_thought"
  | "tool_started"
  | "tool_updated"
  | "archive_segment"
  | "open_idle_slot"
  | "permission_requested"
  | "permission_resolved"
  | "queued"
  | "interrupting"
  | "flush_due"
  | "acknowledgement_visible"
  | "acknowledgement_removed"
  | "acknowledgement_remove_failed"
  | "finish";

export interface TransitionLifecycleDiagnostic {
  readonly category: "transition";
  readonly correlation: DiagnosticCorrelation;
  readonly from: SemanticPhase;
  readonly to: SemanticPhase;
  readonly event: LifecycleTransitionName;
  readonly entryCount: number;
  readonly utf8Bytes: number;
  readonly actionRevoked: boolean;
  readonly staleReason?: "stale_prompt" | "stale_segment" | "stale_timer" | "terminal_absorbed";
}

export interface DeliveryLifecycleDiagnostic {
  readonly category: "delivery";
  readonly correlation: DiagnosticCorrelation;
  readonly operation:
    "adopt" | "send" | "patch" | "close" | "permission_reuse" | "permission_send" | "reconcile";
  readonly outcome: "pending" | "visible" | "rejected" | "failed" | "superseded" | "reused";
}

export interface RouterLifecycleDiagnostic {
  readonly category: "router";
  readonly correlation: DiagnosticCorrelation;
  readonly operation:
    "bootstrap_update" | "session_update" | "permission_request" | "route_activate" | "route_close";
  readonly outcome: "accepted" | "rejected" | "cancelled" | "quarantined";
}

export interface AcknowledgementLifecycleDiagnostic {
  readonly category: "acknowledgement";
  readonly correlation: DiagnosticCorrelation;
  readonly operation: "add" | "remove";
  readonly outcome: "pending" | "attached" | "removed" | "failed" | "skipped";
}

export type LifecycleDiagnosticEvent =
  | TransitionLifecycleDiagnostic
  | DeliveryLifecycleDiagnostic
  | RouterLifecycleDiagnostic
  | AcknowledgementLifecycleDiagnostic;

export type LifecycleDiagnosticLoggerProjection = LifecycleDiagnosticEvent;

export interface LifecycleDiagnosticSink {
  record(event: LifecycleDiagnosticEvent): void;
}

function projectCorrelation(correlation: DiagnosticCorrelation): DiagnosticCorrelation {
  return {
    runtimeSequence: correlation.runtimeSequence,
    promptSequence: correlation.promptSequence,
    segmentSequence: correlation.segmentSequence,
    ownerSequence: correlation.ownerSequence,
  };
}

export function projectLifecycleDiagnostic(
  event: LifecycleDiagnosticEvent,
): LifecycleDiagnosticLoggerProjection {
  const correlation = projectCorrelation(event.correlation);
  switch (event.category) {
    case "transition":
      return {
        category: event.category,
        correlation,
        from: event.from,
        to: event.to,
        event: event.event,
        entryCount: event.entryCount,
        utf8Bytes: event.utf8Bytes,
        actionRevoked: event.actionRevoked,
        ...(event.staleReason === undefined ? {} : { staleReason: event.staleReason }),
      };
    case "delivery":
    case "router":
    case "acknowledgement":
      return {
        category: event.category,
        correlation,
        operation: event.operation,
        outcome: event.outcome,
      } as LifecycleDiagnosticLoggerProjection;
  }
}

export class RingBufferLifecycleDiagnosticSink implements LifecycleDiagnosticSink {
  private readonly events: LifecycleDiagnosticEvent[] = [];

  constructor(private readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("diagnostic capacity must be a positive safe integer");
    }
  }

  record(event: LifecycleDiagnosticEvent): void {
    this.events.push(projectLifecycleDiagnostic(event));
    if (this.events.length > this.capacity) this.events.shift();
  }

  snapshot(): readonly LifecycleDiagnosticEvent[] {
    return this.events.map(projectLifecycleDiagnostic);
  }
}
