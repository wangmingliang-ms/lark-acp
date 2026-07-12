import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LarkPresenter, UnifiedCardState } from "./presenter.js";
import {
  LegacyConversationCardAdapter,
  createSemanticConversationCardTransport,
} from "./legacy-conversation-card-adapter.js";

const state: UnifiedCardState = {
  status: "thinking",
  entries: [],
  cancellable: true,
  chatId: "chat",
  threadId: null,
};

describe("LegacyConversationCardAdapter", () => {
  it("is the single gate-off wrapper around legacy conversation-card writes", async () => {
    const sendUnifiedCard = vi.fn(async () => "card-1");
    const updateUnifiedCard = vi.fn(async () => true);
    const presenter = { sendUnifiedCard, updateUnifiedCard } as unknown as LarkPresenter;
    const adapter = new LegacyConversationCardAdapter(presenter);

    await expect(adapter.send("message-1", state)).resolves.toBe("card-1");
    await expect(adapter.update("card-1", state)).resolves.toBe(true);
    expect(sendUnifiedCard).toHaveBeenCalledExactlyOnceWith("message-1", state);
    expect(updateUnifiedCard).toHaveBeenCalledExactlyOnceWith("card-1", state);
  });

  it("adapts semantic presenter methods without exposing writer names to business logic", async () => {
    const sendConversationCard = vi.fn(async () => "semantic-1");
    const updateConversationCard = vi.fn(async () => true);
    const presenter = { sendConversationCard, updateConversationCard } as unknown as LarkPresenter;
    const transport = createSemanticConversationCardTransport(presenter, "message-1");
    const view = {
      kind: "queued",
      header: "queued",
      entries: [],
      route: { c: "chat" },
    } as const;

    await expect(transport.sendView(view)).resolves.toBe("semantic-1");
    await expect(transport.patchView("semantic-1", view)).resolves.toBe(true);
  });
});

describe("conversation-card writer inventory", () => {
  it("allows production writer calls only in the presenter and delivery boundaries", () => {
    const src = path.resolve(import.meta.dirname, "..");
    const allowed = new Set([
      "presenter/lark-presenter.ts",
      "presenter/legacy-conversation-card-adapter.ts",
      "acp/conversation-card-delivery.ts",
      "conversation/conversation-card-reconciler.ts",
    ]);
    const writerCall =
      /\.(?:sendUnifiedCard|updateUnifiedCard|sendConversationCard|updateConversationCard|sendPermissionRequestCard|updatePermissionRequestCard)\s*\(/;
    const violations: string[] = [];

    for (const file of walk(src)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const relative = path.relative(src, file).replaceAll(path.sep, "/");
      if (writerCall.test(fs.readFileSync(file, "utf8")) && !allowed.has(relative)) {
        violations.push(relative);
      }
    }

    expect(violations).toEqual([]);
  });
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(resolved) : [resolved];
  });
}
