/**
 * ACP Client implementation for Feishu.
 *
 * Implements acp.Client: accumulates text chunks, sends interactive cards
 * for permission requests, provides filesystem read/write access for the agent.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
}

export interface FeishuAcpClientOpts {
  onTyping: () => Promise<void>;
  onThought: (text: string) => Promise<void>;
  showThoughts: boolean;
  sendInterruptCard: (messageId: string, params: acp.RequestPermissionRequest, requestId: string, chatId: string) => Promise<void>;
  sendThinkingCard: (replyToMessageId: string) => Promise<string | null>;
  updateThinkingCard: (cardMessageId: string, thoughtText: string, isDone: boolean) => Promise<void>;
  sendToolCard: (replyToMessageId: string, title: string, kind: string) => Promise<string | null>;
  updateToolCard: (cardMessageId: string, title: string, kind: string, diffText?: string, isFailed?: boolean) => Promise<void>;
  log: (msg: string) => void;
}

export class FeishuAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: FeishuAcpClientOpts;
  private lastTypingAt = 0;
  private currentMessageId = "";
  private currentChatId = "";
  private static readonly TYPING_INTERVAL_MS = 5_000;

  /** Tracks all in-flight permission requests (supports concurrent requests). */
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  /** Tracks the thinking card message ID for incremental updates. */
  private thinkingCardId: string | null = null;

  /** Prevents concurrent thinking card creation (race condition guard). */
  private thinkingCardCreating: Promise<string | null> | null = null;

  /** Maps toolCallId → card info for tool card updates (caches title/kind from initial call). */
  private toolCards: Map<string, { cardId: string; title: string; kind: string }> = new Map();

  constructor(opts: FeishuAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(cbs: { onTyping: () => Promise<void>; onThought: (text: string) => Promise<void> }): void {
    this.opts = { ...this.opts, ...cbs };
  }

  /** Store the current message context so requestPermission knows where to send the card. */
  setContext(messageId: string, chatId: string): void {
    this.currentMessageId = messageId;
    this.currentChatId = chatId;
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const prvAllow = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
    const defaultOptionId = prvAllow?.optionId ?? params.options[0]?.optionId ?? "allow";

    if (!this.currentMessageId) {
      this.opts.log(`[permission] no message context, auto-allow: ${params.toolCall?.title ?? "unknown"}`);
      return { outcome: { outcome: "selected", optionId: defaultOptionId } };
    }

    const requestId = crypto.randomUUID();

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pp: PendingPermission = { requestId, resolve };
      this.pendingPermissions.set(requestId, pp);

      this.opts.sendInterruptCard(this.currentMessageId, params, requestId, this.currentChatId).catch((err) => {
        this.opts.log(`[permission] failed to send card: ${String(err)}`);
        if (this.pendingPermissions.get(requestId)?.requestId === requestId) {
          this.pendingPermissions.delete(requestId);
        }
        resolve({ outcome: { outcome: "selected", optionId: defaultOptionId } });
      });
    });
  }

  /** Resolve a pending permission request from a card action event. */
  handleCardAction(requestId: string, optionId: string): boolean {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return false;

    this.pendingPermissions.delete(requestId);
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  /** Cancel all pending permission requests (e.g. on /cancel). Resolves with cancelled outcome. */
  cancelPendingPermission(): void {
    for (const [requestId, pp] of this.pendingPermissions) {
      pp.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          const snippet = u.content.text.substring(0, 60).replace(/\n/g, "\\n");
          this.opts.log(`[event] message_chunk len=${u.content.text.length} "${snippet}..."`);
          this.chunks.push(u.content.text);
        }
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (u.content.type === "text") {
          this.opts.log(`[event] thought_chunk len=${u.content.text.length}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(u.content.text);
            this.createThinkingCardIfNeeded().catch((err) => {
              this.opts.log(`[think-card] create failed: ${String(err)}`);
            });
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call": {
        const title = u.title ?? "unknown";
        const kind = u.kind ?? "tool";
        const toolCallId = (u as Record<string, unknown>).toolCallId as string | undefined;
        this.opts.log(`[event] tool_call id=${toolCallId ?? "?"} title="${title}" kind=${kind} status=${u.status}`);
        this.sendToolCardIfNeeded(title, kind, toolCallId).catch((err) => {
          this.opts.log(`[tool-card] create failed: ${String(err)}`);
        });
        await this.maybeSendTyping();
        break;
      }

      case "tool_call_update": {
        const toolCallId = (u as Record<string, unknown>).toolCallId as string;
        this.opts.log(`[event] tool_call_update id=${toolCallId} status=${u.status}`);
        if (u.status === "completed" || u.status === "failed") {
          const title = u.title ?? "unknown";
          const kind = u.kind ?? "tool";
          let diffText: string | undefined;
          if (u.content) {
            for (const c of u.content) {
              if (c.type === "diff") {
                const diff = c as acp.Diff;
                const lines: string[] = [`--- ${diff.path}`];
                diff.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
                diff.newText?.split("\n").forEach((l) => lines.push(`+ ${l}`));
                diffText = lines.join("\n");
                this.chunks.push("\n```diff\n" + diffText + "\n```\n");
              }
            }
          }
          this.updateToolCardIfExists(toolCallId, title, kind, diffText, u.status === "failed").catch((err) => {
            this.opts.log(`[tool-card] update failed: ${String(err)}`);
          });
        }
        break;
      }
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.promises.readFile(params.path, "utf-8");
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.promises.writeFile(params.path, params.content, "utf-8");
    return {};
  }

  /** Flush accumulated text (and thoughts) — resets internal buffers. */
  async flush(): Promise<string> {
    await this.finalizeThinkingCard();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async createThinkingCardIfNeeded(): Promise<void> {
    if (this.thinkingCardId) return;
    if (this.thinkingCardCreating) {
      // Another call is already creating the card; wait for its result
      this.opts.log(`[think-card] waiting for in-flight creation`);
      const id = await this.thinkingCardCreating;
      if (id) this.thinkingCardId = id;
      return;
    }
    if (!this.currentMessageId) return;

    this.opts.log(`[think-card] creating...`);
    const promise = this.opts.sendThinkingCard(this.currentMessageId);
    this.thinkingCardCreating = promise;
    try {
      const id = await promise;
      if (id) {
        this.thinkingCardId = id;
        this.opts.log(`[think-card] created id=${id}`);
      } else {
        this.opts.log(`[think-card] create returned null`);
      }
    } finally {
      this.thinkingCardCreating = null;
    }
  }

  /** Update the thinking card with final content and mark it done. Called only at end of prompt. */
  private async finalizeThinkingCard(): Promise<void> {
    const id = this.thinkingCardId;
    if (!id) return;
    this.thinkingCardId = null;
    const text = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    this.opts.log(`[think-card] finalize id=${id} text_len=${text.length} chunks=${this.thoughtChunks.length}`);
    await this.opts.updateThinkingCard(id, text || "（空）", true).catch((err) => {
      this.opts.log(`[think-card] finalize update failed: ${String(err)}`);
    });
  }

  private async sendToolCardIfNeeded(title: string, kind: string, toolCallId?: string): Promise<void> {
    if (!this.currentMessageId) {
      this.opts.log(`[tool-card] skip: no currentMessageId`);
      return;
    }
    this.opts.log(`[tool-card] creating for id=${toolCallId ?? "?"} title="${title}"`);
    const id = await this.opts.sendToolCard(this.currentMessageId, title, kind);
    if (id && toolCallId) {
      this.toolCards.set(toolCallId, { cardId: id, title, kind });
      this.opts.log(`[tool-card] created id=${id} toolCallId=${toolCallId}`);
    } else {
      this.opts.log(`[tool-card] create returned null or no toolCallId (id=${id})`);
    }
  }

  private async updateToolCardIfExists(
    toolCallId: string,
    title: string,
    kind: string,
    diffText?: string,
    isFailed?: boolean,
  ): Promise<void> {
    const entry = this.toolCards.get(toolCallId);
    if (!entry) {
      this.opts.log(`[tool-card] update skipped: no cached entry for toolCallId=${toolCallId}`);
      return;
    }
    this.toolCards.delete(toolCallId);
    const finalTitle = title !== "unknown" ? title : entry.title;
    const finalKind = kind !== "tool" ? kind : entry.kind;
    this.opts.log(`[tool-card] updating id=${entry.cardId} toolCallId=${toolCallId} title="${finalTitle}" failed=${isFailed ?? false} diff=${diffText ? "yes" : "no"}`);
    await this.opts.updateToolCard(entry.cardId, finalTitle, finalKind, diffText, isFailed).catch((err) => {
      this.opts.log(`[tool-card] update API failed: ${String(err)}`);
    });
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < FeishuAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    await this.opts.onTyping().catch(() => {});
  }
}
