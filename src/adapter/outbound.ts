/**
 * Outbound adapter — format ACP reply text for Feishu.
 * Replies are sent as interactive cards with a markdown element,
 * so code blocks, bold, lists etc. render natively.
 */

const MAX_MESSAGE_LENGTH = 4000; // Feishu text message limit

export function formatForFeishu(text: string): string {
  return text.trim();
}

/** Split long responses into chunks that fit within Feishu's limit. */
export function splitText(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
