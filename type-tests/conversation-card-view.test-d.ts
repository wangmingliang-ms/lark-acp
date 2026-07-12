import type {
  ActionToken,
  CancelAction,
  CardRoute,
  ConversationCardView,
  PromptToken,
  SegmentToken,
} from "../src/presenter/conversation-card-view.js";

const route: CardRoute = { c: "chat", th: "thread" };
const cancelAction: CancelAction = {
  p: "prompt" as PromptToken,
  s: "segment" as SegmentToken,
  a: "action" as ActionToken,
};

const archived: ConversationCardView = {
  kind: "archived",
  entries: [{ kind: "text", text: "done" }],
  summary: "done",
  route,
  // @ts-expect-error archived cards cannot be actionable
  cancelAction,
};

const terminal: ConversationCardView = {
  kind: "terminal",
  header: "complete",
  entries: [{ kind: "text", text: "done" }],
  profile: null,
  body: "content",
  route,
  // @ts-expect-error terminal cards cannot be actionable
  cancelAction,
};

// @ts-expect-error archived tools must be normalized to a terminal status
const archivedWithRunningTool: ConversationCardView = {
  kind: "archived",
  entries: [
    {
      kind: "tool",
      toolCallId: "tool",
      title: "running",
      toolKind: "shell",
      status: "in_progress",
    },
  ],
  summary: "done",
  route,
};

// @ts-expect-error terminal tools must be normalized to a terminal status
const terminalWithPendingTool: ConversationCardView = {
  kind: "terminal",
  header: "complete",
  entries: [
    {
      kind: "tool",
      toolCallId: "tool",
      title: "pending",
      toolKind: "shell",
      status: "pending",
    },
  ],
  profile: null,
  body: "content",
  route,
};

void archived;
void terminal;
void archivedWithRunningTool;
void terminalWithPendingTool;
