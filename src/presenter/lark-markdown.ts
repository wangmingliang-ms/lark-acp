/**
 * Convert agent-emitted markdown into Lark's `post` rich-text payload.
 *
 * Lark's `post` element zoo has several blind spots — most notably no
 * inline-code tag and uneven coverage of nested inline styles. The
 * `md` tag, however, accepts a markdown string and renders it natively
 * with full inline support (bold, italic, codespan, links, lists,
 * blockquotes, fenced code, ...).
 *
 * Strategy: walk the `marked` token tree to **rebuild a normalized
 * markdown string**, then hand the whole thing to a single `md` block.
 * This keeps us in control of edge cases (notably code fences without
 * a language, which Lark fails to render as code) without having to
 * regex over the raw source.
 *
 * Lark post payload shape per:
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message-content-description/create_json
 */

import { marked, type Token, type Tokens } from "marked";
import { splitUtf8 } from "./card-text-budget.js";

/** Soft cap on a single chunk's UTF-8 byte size. Lark's post body
 *  itself can be large; this keeps any single reply within IM limits and
 *  avoids one runaway code block blocking the whole reply. */
const MAX_MARKDOWN_CHUNK_BYTES = 4000;

/** Lark's `md` tag refuses to render fenced blocks that omit a language.
 *  Default to `plaintext` so a bare ``` fence still ends up as a code box. */
const DEFAULT_CODE_LANG = "plaintext";

interface PostElMd {
  tag: "md";
  text: string;
}

type PostParagraph = PostElMd[];

export interface PostPayload {
  title?: string;
  content: PostParagraph[];
}

/**
 * Parse `text` as markdown and return a Lark post payload containing a
 * single `md` block whose content is the normalized markdown string.
 */
export function markdownToPost(text: string): PostPayload {
  const tokens = marked.lexer(text);
  const md = renderBlocks(tokens).trim();
  return { content: [[{ tag: "md", text: md }]] };
}

/**
 * Split a markdown blob into chunks no larger than `limit` UTF-8 bytes,
 * preferring to break on paragraph boundaries (`\n\n`) and falling back
 * to single newlines. Code-fence boundaries are preferred when they sit
 * close to the limit so we don't split a fenced block in half.
 */
export function splitMarkdown(text: string, limit = MAX_MARKDOWN_CHUNK_BYTES): string[] {
  return splitUtf8(text, limit, ["\n```\n", "\n\n", "\n"]).map((chunk) =>
    chunk.replace(/^\n+/, ""),
  );
}

// ---- Block-level renderer ---------------------------------------------------

function renderBlocks(tokens: Token[]): string {
  const blocks: string[] = [];
  for (const t of tokens) {
    const rendered = renderBlock(t);
    if (rendered !== undefined) blocks.push(rendered);
  }
  return blocks.join("\n\n");
}

function renderBlock(token: Token): string | undefined {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      const hashes = "#".repeat(Math.max(1, Math.min(6, heading.depth)));
      return `${hashes} ${renderInlineTokens(heading.tokens ?? [])}`;
    }
    case "paragraph": {
      const para = token as Tokens.Paragraph;
      const inline = renderInlineTokens(para.tokens ?? []);
      return inline ? inline : undefined;
    }
    case "code": {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? "").trim() || DEFAULT_CODE_LANG;
      return `\`\`\`${lang}\n${code.text}\n\`\`\``;
    }
    case "hr":
      return "---";
    case "blockquote":
    case "list": {
      // Lark's md tag renders both natively. Keep marked's raw form;
      // strip trailing whitespace so consecutive blocks don't double-space.
      const raw = (token as { raw: string }).raw.replace(/\s+$/, "");
      return raw ? raw : undefined;
    }
    case "table": {
      // md tag does render markdown tables, but column alignment varies
      // wildly with cell width. A fixed-width code block is the most
      // reliable rendering across clients.
      if (isTable(token)) {
        return `\`\`\`${DEFAULT_CODE_LANG}\n${tableToText(token)}\n\`\`\``;
      }
      return undefined;
    }
    case "space":
      return undefined;
    case "html": {
      const html = (token as Tokens.HTML).text.trim();
      return html ? html : undefined;
    }
    default: {
      const raw = (token as { raw?: string }).raw?.trim();
      return raw ? raw : undefined;
    }
  }
}

function isTable(token: Token): token is Tokens.Table {
  return token.type === "table" && Array.isArray((token as Tokens.Table).header);
}

// ---- Inline renderer --------------------------------------------------------

function renderInlineTokens(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) out += renderInline(t);
  return out;
}

function renderInline(token: Token): string {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens?.length) return renderInlineTokens(text.tokens);
      return text.text ?? "";
    }
    case "strong":
      return `**${renderInlineTokens((token as Tokens.Strong).tokens ?? [])}**`;
    case "em":
      return `*${renderInlineTokens((token as Tokens.Em).tokens ?? [])}*`;
    case "del":
      return `~~${renderInlineTokens((token as Tokens.Del).tokens ?? [])}~~`;
    case "codespan":
      return `\`${(token as Tokens.Codespan).text}\``;
    case "link": {
      const link = token as Tokens.Link;
      const label = renderInlineTokens(link.tokens ?? []) || link.text || link.href;
      return `[${label}](${link.href})`;
    }
    case "image": {
      // Agents emit URL-based images; post can only render uploaded
      // image_keys. Render as a link so the user can still reach it.
      const img = token as Tokens.Image;
      const label = img.text || "图片";
      return `[图片 ${label}](${img.href})`;
    }
    case "br":
      return "\n";
    case "escape":
      // Re-add the backslash so the md tag's parser preserves the literal.
      return `\\${(token as Tokens.Escape).text}`;
    case "html":
      return (token as Tokens.HTML).text;
    default: {
      const raw = (token as { raw?: string }).raw;
      return raw ?? "";
    }
  }
}

// ---- Helpers ----------------------------------------------------------------

function tableToText(table: Tokens.Table): string {
  const rows = [table.header.map((c) => c.text), ...table.rows.map((r) => r.map((c) => c.text))];
  const colCount = table.header.length;
  const colWidths = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? "";
      const w = colWidths[i] ?? 0;
      if (cell.length > w) colWidths[i] = cell.length;
    }
  }
  const padCell = (cell: string | undefined, i: number): string =>
    (cell ?? "").padEnd(colWidths[i] ?? 0);

  const lines = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => padCell(row[i], i)).join(" | "),
  );
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  lines.splice(1, 0, separator);
  return lines.join("\n");
}
