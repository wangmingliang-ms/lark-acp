import {
  activeConversationCardElementCount,
  splitUtf8AtPreferredBoundary,
  utf8PartsByteLength,
} from "../presenter/card-text-budget.js";
import type { SessionCardMeta } from "../presenter/presenter.js";
import type { TimelineEntry } from "./topic-conversation.js";

type CardChrome = {
  readonly showCancelButton: boolean;
  readonly profile: SessionCardMeta | null;
};

const PREFERRED_SPLIT_START_BYTES = 8_192;
const MAX_CONTENT_BYTES = 20_000;
const MAX_ELEMENTS = 40;

function entryBytes(entry: TimelineEntry): number {
  switch (entry.kind) {
    case "text":
    case "thought":
    case "notice":
      return utf8PartsByteLength([entry.text]);
    case "tool":
      return utf8PartsByteLength(["**tool**: ", entry.title]);
    case "image":
      // An uploaded image renders as a card `img` element and does not consume
      // the markdown byte budget; only its alt/fallback text costs bytes.
      return utf8PartsByteLength([entry.alt ?? entry.fallback ?? ""]);
  }
}

function contentBytes(entries: readonly TimelineEntry[]): number {
  return entries.reduce((total, entry) => total + entryBytes(entry), 0);
}

export const conversationCardBudget = Object.freeze({
  preferredSplitStartBytes: PREFERRED_SPLIT_START_BYTES,
  maxContentBytes: MAX_CONTENT_BYTES,
  maxElements: MAX_ELEMENTS,

  contentBytes,

  accepts(
    entries: readonly TimelineEntry[],
    nextEntry: TimelineEntry,
    chrome: CardChrome,
  ): boolean {
    const candidateEntries = [...entries, nextEntry];
    return (
      contentBytes(candidateEntries) <= this.maxContentBytes &&
      activeConversationCardElementCount(candidateEntries, {
        hasCancel: chrome.showCancelButton,
        hasProfile: chrome.profile !== null,
      }) <= this.maxElements
    );
  },

  splitText(text: string, occupiedBytes: number): readonly [prefix: string, remainder: string] {
    const availableBytes = this.maxContentBytes - occupiedBytes;
    if (availableBytes <= 0) return ["", text];
    return splitUtf8AtPreferredBoundary(
      text,
      availableBytes,
      Math.max(0, this.preferredSplitStartBytes - occupiedBytes),
    );
  },
});
