import {
  activeConversationCardElementCount,
  splitUtf8AtPreferredBoundary,
  utf8PartsByteLength,
} from "../presenter/card-text-budget.js";
import type { SessionCardMeta } from "../presenter/presenter.js";
import type { TimelineEntry } from "./topic-conversation.js";

export type CardChrome = {
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

  /** Whether `entries` as a whole fit the byte and element budgets for a card. */
  fits(entries: readonly TimelineEntry[], chrome: CardChrome): boolean {
    return (
      contentBytes(entries) <= this.maxContentBytes &&
      activeConversationCardElementCount(entries, {
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

  /**
   * Fit `entries` within a card's element budget by folding overflow inline
   * images into a compact `[图片]` text marker (which costs no extra element:
   * it merges into the preceding text entry, or becomes a single standalone one
   * that itself must fit). Non-image entries are always kept. Returns the
   * possibly-shortened entries and the ids of images that were folded away, so
   * the caller can skip uploading them. Order is preserved.
   */
  foldImagesToFit(
    entries: readonly TimelineEntry[],
    chrome: CardChrome,
  ): { readonly entries: readonly TimelineEntry[]; readonly droppedImageIds: readonly string[] } {
    if (this.fits(entries, chrome)) return { entries, droppedImageIds: [] };

    const marker = "[图片]";
    const result: TimelineEntry[] = [];
    const droppedImageIds: string[] = [];
    let folding = false;
    for (const entry of entries) {
      if (entry.kind !== "image") {
        result.push(entry);
        continue;
      }
      // Keep the image only while the card still fits WITH ROOM for the eventual
      // fold marker (a single text element that must itself fit). Once folding
      // starts, every remaining image folds into that one marker (zero extra
      // elements).
      if (!folding && this.fits([...result, entry, { kind: "text", text: marker }], chrome)) {
        result.push(entry);
        continue;
      }
      folding = true;
      droppedImageIds.push(entry.imageId);
      const last = result.at(-1);
      if (last?.kind === "text") {
        result[result.length - 1] = { kind: "text", text: `${last.text}${marker}` };
      } else {
        result.push({ kind: "text", text: marker });
      }
    }
    return { entries: result, droppedImageIds };
  },
});
