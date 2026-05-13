/**
 * Feishu HTTP client — thin wrapper around @larksuite/node-sdk Client.
 * Handles sending messages and reactions.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

/** Wrap text in a Feishu interactive card with a markdown element. */
function buildMarkdownCard(text: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: text },
    ],
  };
}

export interface FeishuClientOpts {
  appId: string;
  appSecret: string;
}

export class FeishuClient {
  private client: Lark.Client;

  constructor(opts: FeishuClientOpts) {
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: Lark.AppType.SelfBuild,
      // Suppress internal SDK logs
      loggerLevel: Lark.LoggerLevel.error,
    });
  }

  /** Reply to a specific message using a markdown card (renders bold, code, etc). */
  async replyText(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(buildMarkdownCard(text)),
        msg_type: "interactive",
        reply_in_thread: false,
      },
    });
  }

  /** Send a markdown card message to a chat (DM or group). */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify(buildMarkdownCard(text)),
        msg_type: "interactive",
      },
    });
  }

  /** Add an emoji reaction. Returns the reaction ID needed to remove it later. */
  async addReaction(messageId: string, emoji = "THINKING"): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (res as any)?.reaction_id ?? null;
    } catch {
      return null;
    }
  }

  /** Fetch bot info and return a direct chat deep-link the user can click. */
  async getBotChatLink(): Promise<string | null> {
    try {
      // GET /open-apis/bot/v3/info
      const res = await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      const openId: string | undefined = res?.bot?.open_id;
      if (openId) {
        return `https://applink.feishu.cn/client/chat/open?botId=${openId}`;
      }
    } catch {
      // non-fatal
    }
    return null;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // best-effort
    }
  }
}
