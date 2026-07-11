import { Buffer } from "node:buffer";

/** Feishu's documented ceiling for one card markdown element. */
export const CARD_MARKDOWN_ELEMENT_BYTE_LIMIT = 30_000;
/** Fixed product safety budget for rotating conversation cards before the hard ceiling. */
export const CARD_MARKDOWN_ROTATION_BYTE_LIMIT = 8_192;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function utf8PartsByteLength(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + utf8ByteLength(part), 0);
}

/** Largest UTF-16 index whose prefix fits the UTF-8 byte budget. */
export function utf8PrefixEnd(text: string, maxBytes: number): number {
  if (maxBytes <= 0 || text.length === 0) return 0;
  let usedBytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maxBytes) break;
    usedBytes += characterBytes;
    end += character.length;
  }
  return end;
}

export function truncateUtf8(text: string, maxBytes: number, suffix = ""): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const suffixBytes = utf8ByteLength(suffix);
  if (suffixBytes >= maxBytes) return text.slice(0, utf8PrefixEnd(text, maxBytes));
  const end = utf8PrefixEnd(text, maxBytes - suffixBytes);
  return `${text.slice(0, end).trimEnd()}${suffix}`;
}

export function splitUtf8(
  text: string,
  maxBytes: number,
  preferredBreaks: readonly string[] = ["\n\n", "\n"],
): string[] {
  if (maxBytes <= 0) throw new Error("maxBytes must be positive");
  if (utf8ByteLength(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (utf8ByteLength(remaining) > maxBytes) {
    const hardEnd = utf8PrefixEnd(remaining, maxBytes);
    let splitAt = 0;
    for (const boundary of preferredBreaks) {
      const candidate = remaining.lastIndexOf(boundary, hardEnd);
      if (candidate > 0) {
        splitAt = candidate + boundary.length;
        break;
      }
    }
    if (splitAt <= 0) splitAt = hardEnd;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
