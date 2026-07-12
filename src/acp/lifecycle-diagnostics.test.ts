import { describe, expect, it } from "vitest";
import {
  RingBufferLifecycleDiagnosticSink,
  projectLifecycleDiagnostic,
  type DiagnosticCorrelation,
  type LifecycleDiagnosticEvent,
} from "./lifecycle-diagnostics.js";

const correlation: DiagnosticCorrelation = {
  runtimeSequence: 1,
  promptSequence: 2,
  segmentSequence: 3,
  ownerSequence: 4,
};

function transition(promptSequence: number): LifecycleDiagnosticEvent {
  return {
    category: "transition",
    correlation: { ...correlation, promptSequence },
    from: "active",
    to: "terminal",
    event: "finish",
    entryCount: 1,
    utf8Bytes: 6,
    actionRevoked: true,
  };
}

describe("RingBufferLifecycleDiagnosticSink", () => {
  it("returns recorded events in insertion order", () => {
    const sink = new RingBufferLifecycleDiagnosticSink();

    sink.record(transition(1));
    sink.record(transition(2));

    expect(sink.snapshot().map((event) => event.correlation.promptSequence)).toEqual([1, 2]);
  });

  it("evicts oldest events and keeps the newest 256 by default", () => {
    const sink = new RingBufferLifecycleDiagnosticSink();

    for (let promptSequence = 1; promptSequence <= 300; promptSequence += 1) {
      sink.record(transition(promptSequence));
    }

    const sequences = sink.snapshot().map((event) => event.correlation.promptSequence);
    expect(sequences).toHaveLength(256);
    expect(sequences[0]).toBe(45);
    expect(sequences.at(-1)).toBe(300);
  });

  it("serializes only bounded allowlisted fields for every stable category", () => {
    const tainted = {
      token: "action-token-secret",
      content: "private card content",
      chatId: "chat-id-secret",
      threadId: "thread-id-secret",
      messageId: "message-id-secret",
      cardId: "card-id-secret",
      path: "/home/person/private/repo",
      secret: "credential-secret",
    };
    const events: LifecycleDiagnosticEvent[] = [
      { ...transition(7), ...tainted },
      {
        category: "delivery",
        correlation,
        operation: "patch",
        outcome: "visible",
        ...tainted,
      },
      {
        category: "router",
        correlation,
        operation: "session_update",
        outcome: "accepted",
        ...tainted,
      },
      {
        category: "acknowledgement",
        correlation,
        operation: "remove",
        outcome: "failed",
        ...tainted,
      },
    ];

    const serialized = JSON.stringify(events.map(projectLifecycleDiagnostic));
    expect(serialized).toBe(
      '[{"category":"transition","correlation":{"runtimeSequence":1,"promptSequence":7,"segmentSequence":3,"ownerSequence":4},"from":"active","to":"terminal","event":"finish","entryCount":1,"utf8Bytes":6,"actionRevoked":true},{"category":"delivery","correlation":{"runtimeSequence":1,"promptSequence":2,"segmentSequence":3,"ownerSequence":4},"operation":"patch","outcome":"visible"},{"category":"router","correlation":{"runtimeSequence":1,"promptSequence":2,"segmentSequence":3,"ownerSequence":4},"operation":"session_update","outcome":"accepted"},{"category":"acknowledgement","correlation":{"runtimeSequence":1,"promptSequence":2,"segmentSequence":3,"ownerSequence":4},"operation":"remove","outcome":"failed"}]',
    );
    for (const sensitiveValue of Object.values(tainted)) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });
});
