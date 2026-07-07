# 入站图片支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Lark 发送的图片（独立图片消息 + post 富文本内嵌图）以 ACP `image` content block 真正送达支持多模态的 Agent，下载失败/超限时自动退回文本占位。

**Architecture:** 纯解释器 / effect 分层。`interpretLarkMessage`（纯·同步）产出新的中间类型 `PromptSegment[]`（text 段 + image-ref 标记，保留顺序）；新增 bridge 层的 `hydratePrompt`（effect）真正下载图片并产出 `acp.ContentBlock[]`，成功→image block，失败/超限→文本占位（决策集中一处，未来易加能力门控）。采用策略 C：不做 ACP 能力检测，一律尝试传图 + 兜底。

**Tech Stack:** TypeScript 5.9 (strict, NodeNext ESM), vitest 3, `@agentclientprotocol/sdk` v0.16.1 (`ContentBlock` / `ImageContent`), `@larksuiteoapi/node-sdk`（已有 `LarkHttpClient.downloadMessageImage`）。提交前门槛：`tsc --noEmit` + `prettier --check`（本仓库未安装 eslint）。

---

## 源码事实（已核对，供实现参考）

- `src/interpreter/lark-interpreter.ts`
  - `InterpretedMessage` 的 prompt 变体当前是 `{ readonly kind: "prompt"; readonly blocks: acp.ContentBlock[] }`（约 164 行）。
  - text 分支：`return { kind: "prompt", blocks: [{ type: "text", text }] };`
  - 非 text：`return blocksToPrompt(parseNonTextMessage(message));`
  - `parseNonTextMessage(message): acp.ContentBlock[]` 是 switch 派发器（post/image/file/audio/media/sticker/share_chat/share_user/location/merge_forward/default）。
  - `blocksToPrompt(blocks): InterpretedMessage`：`blocks.length ? { kind: "prompt", blocks } : { kind: "empty" }`。
  - `parsePost` 内嵌 img：`if (el.tag === "img") { lineParts.push(imagePlaceholder(messageId, el.image_key)); continue; }`（在 `lineParts`/`lineBuffer` 逐行拼接 markdown 的循环里）。
  - `parseImage`：`const key = payload?.image_key; if (!key) return [{ type: "text", text: "[图片消息缺少 image_key]" }]; return [{ type: "text", text: imagePlaceholder(messageId, key) }];`
  - `imagePlaceholder(messageId, imageKey)` → `` `[图片 (message_id=${messageId}, image_key=${imageKey})]` ``。
  - 其余 `parseFile/parseAudio/parseMedia/parseSticker/parseShareChat/parseShareUser/parseLocation` 均返回 `acp.ContentBlock[]`（单个 text block）。
- `src/interpreter/index.ts`：只 re-export `interpretLarkMessage` 和类型 `InterpretOptions / InterpretedMessage / LarkCommand`。
- `src/bridge/bridge.ts`
  - `import type * as acp from "@agentclientprotocol/sdk";`（约 30 行）——**grep 确认：全文件 `acp.` 仅出现在 `enqueueWithContext` 的签名 `prompt: acp.ContentBlock[]`（约 897 行）**，翻转签名后该 import 变为未使用，必须删除。
  - `routeMessage` 的 `case "prompt"`：`await this.enqueueWithContext(event, chatId, threadId, userId, messageId, interpreted.blocks);`
  - `enqueueWithContext(..., prompt: acp.ContentBlock[])`：内部先 `const [userName, chatName] = await Promise.all([this.http.getUserName(userId), isGroup ? this.http.getChatName(chatId) : Promise.resolve("")]);`，再 `prompt.push({ type: "text", text: context });` 和 `prompt.push({ type: "text", text: renderInlineControlHint(chatId, threadId) });`，最后 `const pending: PendingMessage = { prompt, messageId, chatId }; await runtime.enqueue(pending);`。
  - `this.http` 是 `LarkHttpClient`（有 `downloadMessageImage`），`this.logger` 是 `LarkLogger`。
- `src/lark/lark-http.ts`：`async downloadMessageImage(messageId, imageKey): Promise<{ bytes: Buffer; mimeType: string }>`（含 magic-byte MIME 嗅探）——复用，不改。
- `src/bridge/chat-runtime.ts`：`PendingMessage = { prompt: acp.ContentBlock[]; messageId; chatId }`——**不变**（hydrator 产出的就是 `acp.ContentBlock[]`）。
- `src/logger/logger.ts`：`LarkLogger` 有 `warn(msg: string): void; warn(obj: object, msg?: string): void;`（debug/info/error 同形）+ `child(...)`。测试用假 logger 见现有 `src/lark/lifecycle-notifier.test.ts` 的 `silentLogger` 写法。
- `node_modules/@agentclientprotocol/sdk`：`ContentBlock` union 含 `(ImageContent & { type: "image" })`；`ImageContent = { data: string; mimeType: string; uri?: string | null; annotations?; _meta? }`。
- 提交门槛：`package.json` 无 eslint（devDeps 仅 `@types/node`/prettier/typescript/vitest）；tsconfig `strict: true` 但未开 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`。

## File Structure

- **Create** `src/bridge/prompt-hydrator.ts` — effect 层：`PromptSegment[] → acp.ContentBlock[]`，图片下载 + 兜底 + 并发保序。唯一 image-vs-占位 决策点。
- **Create** `src/bridge/prompt-hydrator.test.ts` — 注入假 downloader/logger 的单测。
- **Modify** `src/interpreter/lark-interpreter.ts` — 新增 `PromptSegment`；prompt 变体 `blocks` → `segments`；所有 `parseX` + `parseNonTextMessage` 返回 `PromptSegment[]`；`blocksToPrompt` → `segmentsToPrompt`；新增 `normalizeSegments`；`parseImage`/`parsePost` 产出 `image-ref`；移除 `imagePlaceholder`。
- **Modify** `src/interpreter/index.ts` — 追加 `export type { PromptSegment }`。
- **Modify** `src/interpreter/lark-interpreter.test.ts` — 新增 image/post 段测试；通用 `messageEvent` 构造器。
- **Modify** `src/bridge/bridge.ts` — `routeMessage` 传 `interpreted.segments`；`enqueueWithContext` 签名 `segments: PromptSegment[]` 并调用 `hydratePrompt`；删除未使用的 `acp` import，新增 hydrator/PromptSegment import。

## 排序约束（关键）

把 `InterpretedMessage.prompt` 从 `blocks` 翻成 `segments` 会在编译期打断 `bridge.ts`，所以**解释器类型翻转 + bridge 接线必须在同一次原子提交里落地**，才能保持 `tsc --noEmit` 绿。而 hydrator 只依赖**新增的** `PromptSegment` 类型（additive，不动老类型），可以先独立建好并通过全部测试——这就是 Task 1 与 Task 2 的切分理由。

---

## Task 1: Hydrator + PromptSegment 类型（additive，全绿）

**Files:**
- Modify: `src/interpreter/lark-interpreter.ts`（仅**追加** `PromptSegment` 导出类型，不动任何现有逻辑）
- Modify: `src/interpreter/index.ts`（追加 `export type { PromptSegment }`）
- Create: `src/bridge/prompt-hydrator.ts`
- Test: `src/bridge/prompt-hydrator.test.ts`

- [ ] **Step 1.1: 追加 `PromptSegment` 类型到解释器（不动现有代码）**

在 `src/interpreter/lark-interpreter.ts` 的 `// ---- Public API ----` 区、`export type LarkCommand` 之前，插入：

```ts
/**
 * Interpreter → hydrator 的中间产物。纯解释器只识别结构、产出这些段，
 * **不下载字节**（下载是 bridge 层的 effect）。`image-ref` 只携带下载所
 * 需的最小信息（messageId + imageKey）。
 */
export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image-ref"; readonly messageId: string; readonly imageKey: string };
```

- [ ] **Step 1.2: 从 index 导出 `PromptSegment`**

`src/interpreter/index.ts` 改为：

```ts
export { interpretLarkMessage } from "./lark-interpreter.js";
export type {
  InterpretOptions,
  InterpretedMessage,
  LarkCommand,
  PromptSegment,
} from "./lark-interpreter.js";
```

- [ ] **Step 1.3: 运行一次确认 additive 改动不破坏编译/测试**

Run: `npx tsc --noEmit && npx vitest run src/interpreter`
Expected: PASS（类型新增、导出新增，现有测试不受影响）

- [ ] **Step 1.4: 写失败测试 `prompt-hydrator.test.ts`**

Create `src/bridge/prompt-hydrator.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import {
  hydratePrompt,
  imagePlaceholder,
  MAX_INLINE_IMAGE_BYTES,
  type ImageDownloader,
  type HydrateDeps,
} from "./prompt-hydrator.js";
import type { PromptSegment } from "../interpreter/lark-interpreter.js";
import type { LarkLogger } from "../logger/logger.js";

const silentLogger: LarkLogger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  child(): LarkLogger {
    return silentLogger;
  },
};

/** A logger whose `warn` is a spy; everything else is inert. */
function spyLogger(): { logger: LarkLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: LarkLogger = {
    debug(): void {},
    info(): void {},
    warn,
    error(): void {},
    child(): LarkLogger {
      return logger;
    },
  };
  return { logger, warn };
}

/** Downloader returning a fixed 1x1 PNG-ish buffer. */
function fakeDownloader(bytes: Buffer, mimeType = "image/png"): ImageDownloader {
  return {
    downloadMessageImage: vi.fn(async () => ({ bytes, mimeType })),
  };
}

function deps(over: Partial<HydrateDeps> & { downloader: ImageDownloader }): HydrateDeps {
  return { logger: silentLogger, ...over };
}

describe("hydratePrompt", () => {
  it("passes a text segment through as a text block", async () => {
    const segments: PromptSegment[] = [{ kind: "text", text: "hello" }];
    const blocks = await hydratePrompt(segments, deps({ downloader: fakeDownloader(Buffer.from("x")) }));
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("downloads an image-ref into an image block (base64 data + mimeType)", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_1", imageKey: "img_k" }];
    const downloader = fakeDownloader(bytes, "image/png");
    const blocks = await hydratePrompt(segments, deps({ downloader }));
    expect(blocks).toEqual([{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
    expect(downloader.downloadMessageImage).toHaveBeenCalledWith("om_1", "img_k");
  });

  it("falls back to text placeholder and warns when download throws", async () => {
    const { logger, warn } = spyLogger();
    const downloader: ImageDownloader = {
      downloadMessageImage: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_2", imageKey: "k2" }];
    const blocks = await hydratePrompt(segments, deps({ downloader, logger }));
    expect(blocks).toEqual([{ type: "text", text: imagePlaceholder("om_2", "k2") }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to text placeholder and warns when the image is oversize", async () => {
    const { logger, warn } = spyLogger();
    const bytes = Buffer.alloc(11);
    const segments: PromptSegment[] = [{ kind: "image-ref", messageId: "om_3", imageKey: "k3" }];
    const blocks = await hydratePrompt(
      segments,
      deps({ downloader: fakeDownloader(bytes), logger, maxInlineImageBytes: 10 }),
    );
    expect(blocks).toEqual([{ type: "text", text: imagePlaceholder("om_3", "k3") }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps output order across mixed text + multiple concurrent images", async () => {
    const a = Buffer.from([1]);
    const c = Buffer.from([3]);
    const downloader: ImageDownloader = {
      downloadMessageImage: vi.fn(async (_messageId: string, imageKey: string) => {
        // out-of-order completion: 'a' resolves after 'c'
        if (imageKey === "a") {
          await new Promise((r) => setTimeout(r, 10));
          return { bytes: a, mimeType: "image/png" };
        }
        return { bytes: c, mimeType: "image/jpeg" };
      }),
    };
    const segments: PromptSegment[] = [
      { kind: "image-ref", messageId: "m", imageKey: "a" },
      { kind: "text", text: "middle" },
      { kind: "image-ref", messageId: "m", imageKey: "c" },
    ];
    const blocks = await hydratePrompt(segments, deps({ downloader }));
    expect(blocks).toEqual([
      { type: "image", data: a.toString("base64"), mimeType: "image/png" },
      { type: "text", text: "middle" },
      { type: "image", data: c.toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("MAX_INLINE_IMAGE_BYTES is 10 MiB", () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
```

- [ ] **Step 1.5: 运行确认测试失败（模块不存在）**

Run: `npx vitest run src/bridge/prompt-hydrator.test.ts`
Expected: FAIL — `Cannot find module './prompt-hydrator.js'`。

- [ ] **Step 1.6: 实现 `src/bridge/prompt-hydrator.ts`**

```ts
/**
 * Prompt hydrator — the effectful bridge-layer counterpart of the pure
 * interpreter. Turns interpreter {@link PromptSegment}s into ACP
 * {@link acp.ContentBlock}s, downloading referenced images along the way.
 *
 * This is the single decision point for "inline image vs. text placeholder":
 * a successful, in-budget download becomes an ACP `image` block; any failure
 * or oversize falls back to the same text placeholder the interpreter used
 * before this feature, so one bad image never breaks a whole message. To add
 * ACP capability gating later, gate here — nothing else needs to change.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { PromptSegment } from "../interpreter/lark-interpreter.js";
import type { LarkLogger } from "../logger/logger.js";

/** Max inline image size; larger images fall back to a text placeholder to
 *  avoid blowing the stdio pipe / being rejected by the model. 10 MiB. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Narrow capability the hydrator needs; {@link LarkHttpClient} satisfies it. */
export interface ImageDownloader {
  downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface HydrateDeps {
  readonly downloader: ImageDownloader;
  readonly logger: LarkLogger;
  /** Injectable for tests; defaults to {@link MAX_INLINE_IMAGE_BYTES}. */
  readonly maxInlineImageBytes?: number;
}

/**
 * Text fallback for an image that couldn't be inlined. Byte-for-byte identical
 * to the interpreter's pre-feature placeholder, guaranteeing zero regression.
 */
export function imagePlaceholder(messageId: string, imageKey: string): string {
  return `[图片 (message_id=${messageId}, image_key=${imageKey})]`;
}

/**
 * Hydrate interpreter segments into ACP content blocks. `text` segments pass
 * through unchanged; `image-ref` segments are downloaded concurrently and
 * become `image` blocks (or a text placeholder on failure/oversize). Output
 * order strictly matches input order. Never throws — a single image failure is
 * logged and downgraded to a placeholder.
 */
export async function hydratePrompt(
  segments: readonly PromptSegment[],
  deps: HydrateDeps,
): Promise<acp.ContentBlock[]> {
  const maxBytes = deps.maxInlineImageBytes ?? MAX_INLINE_IMAGE_BYTES;
  return Promise.all(segments.map((segment) => hydrateSegment(segment, deps, maxBytes)));
}

async function hydrateSegment(
  segment: PromptSegment,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  if (segment.kind === "text") return { type: "text", text: segment.text };
  return downloadImageBlock(segment.messageId, segment.imageKey, deps, maxBytes);
}

async function downloadImageBlock(
  messageId: string,
  imageKey: string,
  deps: HydrateDeps,
  maxBytes: number,
): Promise<acp.ContentBlock> {
  try {
    const { bytes, mimeType } = await deps.downloader.downloadMessageImage(messageId, imageKey);
    if (bytes.length > maxBytes) {
      deps.logger.warn(
        { messageId, imageKey, bytes: bytes.length, maxBytes },
        "inbound image too large — falling back to text placeholder",
      );
      return { type: "text", text: imagePlaceholder(messageId, imageKey) };
    }
    return { type: "image", data: bytes.toString("base64"), mimeType };
  } catch (err) {
    deps.logger.warn(
      { err, messageId, imageKey },
      "inbound image download failed — falling back to text placeholder",
    );
    return { type: "text", text: imagePlaceholder(messageId, imageKey) };
  }
}
```

- [ ] **Step 1.7: 运行确认全部通过**

Run: `npx vitest run src/bridge/prompt-hydrator.test.ts && npx tsc --noEmit`
Expected: PASS（6 个测试全绿；类型检查通过）。

- [ ] **Step 1.8: 提交**

```bash
git add src/bridge/prompt-hydrator.ts src/bridge/prompt-hydrator.test.ts src/interpreter/lark-interpreter.ts src/interpreter/index.ts
git commit -m "feat(bridge): add prompt hydrator + PromptSegment type for inbound images"
```

---

## Task 2（原子）: 翻转解释器为 segments + bridge 接线

> 本任务的所有源码改动必须**在同一次提交里**完成，否则 `tsc --noEmit` 会因 `bridge.ts` 引用不存在的 `interpreted.segments` 而失败。测试先行，但提交是一整块。

**Files:**
- Modify: `src/interpreter/lark-interpreter.ts`（prompt 变体、所有 parser 返回类型、`parseImage`/`parsePost`、`normalizeSegments`、`segmentsToPrompt`、移除 `imagePlaceholder`、更新顶部注释与 import）
- Modify: `src/interpreter/lark-interpreter.test.ts`（新增 image/post 测试 + 通用事件构造器）
- Modify: `src/bridge/bridge.ts`（`routeMessage`、`enqueueWithContext`、import 调整）

- [ ] **Step 2.1: 写解释器 image/post 失败测试**

在 `src/interpreter/lark-interpreter.test.ts` 顶部、`textEvent` 之后，新增通用事件构造器：

```ts
/**
 * Build a non-text message event. Mirrors {@link textEvent} but lets the
 * caller pick `message_type` and the raw `content` JSON string.
 */
function messageEvent(
  messageType: string,
  content: string,
  messageId = "om_test",
): Lark.RawMessageEvent {
  const message = {
    message_id: messageId,
    chat_id: "oc_test",
    chat_type: "p2p",
    message_type: messageType,
    content,
  };
  return { message } as unknown as Lark.RawMessageEvent;
}
```

在文件末尾追加：

```ts
import type { PromptSegment } from "./lark-interpreter.js";

function expectSegments(event: Lark.RawMessageEvent): PromptSegment[] {
  const result = interpretLarkMessage(event);
  if (result.kind !== "prompt") {
    throw new Error(`expected prompt, got kind="${result.kind}"`);
  }
  return result.segments;
}

describe("interpretLarkMessage — image messages", () => {
  it("emits a single image-ref segment carrying messageId + imageKey", () => {
    const event = messageEvent("image", JSON.stringify({ image_key: "img_abc" }), "om_img");
    expect(expectSegments(event)).toEqual([
      { kind: "image-ref", messageId: "om_img", imageKey: "img_abc" },
    ]);
  });

  it("emits a text segment when image_key is missing", () => {
    const event = messageEvent("image", JSON.stringify({}), "om_img2");
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "[图片消息缺少 image_key]" }]);
  });
});

describe("interpretLarkMessage — post rich text", () => {
  it("preserves text/image order and merges adjacent text", () => {
    const content = JSON.stringify({
      content: [
        [
          { tag: "text", text: "before " },
          { tag: "img", image_key: "img_1" },
          { tag: "text", text: "after" },
        ],
      ],
    });
    const event = messageEvent("post", content, "om_post");
    expect(expectSegments(event)).toEqual([
      { kind: "text", text: "before " },
      { kind: "image-ref", messageId: "om_post", imageKey: "img_1" },
      { kind: "text", text: "after" },
    ]);
  });

  it("returns a single text segment for a post with no images", () => {
    const content = JSON.stringify({
      title: "Hi",
      content: [[{ tag: "text", text: "plain line" }]],
    });
    const event = messageEvent("post", content, "om_post2");
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "**Hi**\n\nplain line" }]);
  });
});

describe("interpretLarkMessage — other attachments stay text", () => {
  it("renders a file message as a text segment (regression)", () => {
    const content = JSON.stringify({ file_name: "a.pdf", file_key: "fk" });
    const event = messageEvent("file", content);
    expect(expectSegments(event)).toEqual([{ kind: "text", text: "[文件: a.pdf (file_key=fk)]" }]);
  });
});
```

- [ ] **Step 2.2: 运行确认测试失败（类型/属性不存在）**

Run: `npx vitest run src/interpreter/lark-interpreter.test.ts`
Expected: FAIL — `result.segments` 不存在 / image 消息仍产出 text 占位，断言不匹配。

- [ ] **Step 2.3: 翻转解释器 prompt 变体 → `segments`**

在 `src/interpreter/lark-interpreter.ts`，把：

```ts
  | { readonly kind: "prompt"; readonly blocks: acp.ContentBlock[] };
```

改为：

```ts
  | { readonly kind: "prompt"; readonly segments: PromptSegment[] };
```

- [ ] **Step 2.4: 翻转 text 分支 + 派发返回值**

`interpretLarkMessage` 里 text 分支：

```ts
    return { kind: "prompt", segments: [{ kind: "text", text }] };
```

非 text 收尾：

```ts
  return segmentsToPrompt(normalizeSegments(parseNonTextMessage(message)));
```

- [ ] **Step 2.5: 派发器与所有 parser 返回类型 `PromptSegment[]`**

把 `parseNonTextMessage` 及其分支、`merge_forward`/`default` 内联返回全部改为 `PromptSegment[]`（text 占位统一写成 `{ kind: "text", text: "..." }`）：

```ts
function parseNonTextMessage(message: Lark.RawMessageEvent["message"]): PromptSegment[] {
  switch (message.message_type) {
    case "post":
      return parsePost(message.content, message.message_id);
    case "image":
      return parseImage(message.content, message.message_id);
    case "file":
      return parseFile(message.content);
    case "audio":
      return parseAudio(message.content);
    case "media":
      return parseMedia(message.content);
    case "sticker":
      return parseSticker(message.content);
    case "share_chat":
      return parseShareChat(message.content);
    case "share_user":
      return parseShareUser(message.content);
    case "location":
      return parseLocation(message.content);
    case "merge_forward":
      return [{ kind: "text", text: "[合并转发消息 — 请通过工具调用获取子消息]" }];
    default:
      return [{ kind: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
  }
}
```

- [ ] **Step 2.6: `blocksToPrompt` → `segmentsToPrompt` + 新增 `normalizeSegments`**

替换 `blocksToPrompt`：

```ts
function segmentsToPrompt(segments: PromptSegment[]): InterpretedMessage {
  return segments.length ? { kind: "prompt", segments } : { kind: "empty" };
}

/**
 * Regularise an interleaved segment list: merge adjacent text segments into
 * one and drop empty-text segments. Image-ref segments are passed through
 * untouched, so text/image ordering is preserved.
 */
function normalizeSegments(segments: PromptSegment[]): PromptSegment[] {
  const out: PromptSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "image-ref") {
      out.push(segment);
      continue;
    }
    if (segment.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + segment.text };
      continue;
    }
    out.push(segment);
  }
  return out;
}
```

- [ ] **Step 2.7: `parseImage` 产出 `image-ref`**

```ts
function parseImage(raw: string, messageId: string): PromptSegment[] {
  const payload = safeParse<ImagePayload>(raw);
  const key = payload?.image_key;
  if (!key) return [{ kind: "text", text: "[图片消息缺少 image_key]" }];
  return [{ kind: "image-ref", messageId, imageKey: key }];
}
```

- [ ] **Step 2.8: `parsePost` 产出交错段（保留图文顺序）**

把 `parsePost` 改为产出 `PromptSegment[]`：文本行照旧拼进 `lineBuffer`，遇到 `img` 时先把已累积文本 flush 成一个 text 段，再push一个 `image-ref` 段。用一个内部 `flushText` 收敛重复逻辑。完整替换：

```ts
function parsePost(raw: string, messageId: string): PromptSegment[] {
  const payload = safeParse<PostPayload>(raw);
  if (!payload) return [{ kind: "text", text: "[富文本消息解析失败]" }];

  const segments: PromptSegment[] = [];
  const lineBuffer: string[] = [];
  const flushText = (): void => {
    const text = lineBuffer.join("\n").trim();
    if (text) segments.push({ kind: "text", text });
    lineBuffer.length = 0;
  };

  if (payload.title) {
    lineBuffer.push(`**${payload.title}**`, "");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) {
    flushText();
    return segments;
  }

  for (const para of paragraphs) {
    if (!para.length) {
      lineBuffer.push("");
      continue;
    }

    const first = para[0];
    if (first?.tag === "code_block") {
      const lang = first.language ?? "";
      lineBuffer.push(`\`\`\`${lang}\n${first.text}\n\`\`\``);
      continue;
    }
    if (first?.tag === "hr") {
      lineBuffer.push("---");
      continue;
    }

    const lineParts: string[] = [];
    for (const el of para) {
      if (el.tag === "img") {
        if (lineParts.length) {
          lineBuffer.push(lineParts.join(""));
          lineParts.length = 0;
        }
        flushText();
        segments.push({ kind: "image-ref", messageId, imageKey: el.image_key });
        continue;
      }
      const rendered = elementToText(el);
      if (rendered) lineParts.push(rendered);
    }
    if (lineParts.length) lineBuffer.push(lineParts.join(""));
  }

  flushText();
  return segments;
}
```

> 注意：`normalizeSegments` 会再合并相邻 text 段并丢空 text，所以 `parsePost` 自身不必追求最简；两者叠加得到规整结果。

- [ ] **Step 2.9: 其余 parser 机械改为 `PromptSegment[]`**

把 `parseFile`/`parseAudio`/`parseMedia`/`parseSticker`/`parseShareChat`/`parseShareUser`/`parseLocation` 的返回类型从 `acp.ContentBlock[]` 改为 `PromptSegment[]`，并把返回的 `{ type: "text", text: ... }` 改为 `{ kind: "text", text: ... }`。示例（其余同构）：

```ts
function parseFile(raw: string): PromptSegment[] {
  const p = safeParse<FilePayload>(raw);
  const name = p?.file_name ?? "未命名";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[文件: ${name} (file_key=${key})]` }];
}

function parseAudio(raw: string): PromptSegment[] {
  const p = safeParse<AudioPayload>(raw);
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[音频: ${dur} (file_key=${key})]` }];
}

function parseMedia(raw: string): PromptSegment[] {
  const p = safeParse<MediaPayload>(raw);
  const name = p?.file_name ?? "未命名";
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[视频: ${name} ${dur} (file_key=${key})]` }];
}

function parseSticker(raw: string): PromptSegment[] {
  const p = safeParse<StickerPayload>(raw);
  const key = p?.file_key ?? "unknown";
  return [{ kind: "text", text: `[表情包 (file_key=${key})]` }];
}

function parseShareChat(raw: string): PromptSegment[] {
  const p = safeParse<ShareChatPayload>(raw);
  const id = p?.chat_id ?? "unknown";
  return [{ kind: "text", text: `[群名片: chat_id=${id}]` }];
}

function parseShareUser(raw: string): PromptSegment[] {
  const p = safeParse<ShareUserPayload>(raw);
  const id = p?.user_id ?? "unknown";
  return [{ kind: "text", text: `[个人名片: user_id=${id}]` }];
}

function parseLocation(raw: string): PromptSegment[] {
  const p = safeParse<LocationPayload>(raw);
  const name = p?.name ?? "未命名地点";
  const lat = p?.latitude ?? "?";
  const lon = p?.longitude ?? "?";
  return [{ kind: "text", text: `[位置: ${name} (${lat}, ${lon})]` }];
}
```

- [ ] **Step 2.10: 移除 `imagePlaceholder` 并清理 import / 顶部注释**

1. 删除解释器里的 `imagePlaceholder` 函数（占位串已迁到 hydrator）。
2. 删除顶部 `import type * as acp from "@agentclientprotocol/sdk";`（解释器不再引用 ACP 类型；`elementToText` 等都不涉及 acp）。
3. 顶部文件注释从「translate ... into the ACP `ContentBlock[]` shape」「No binary attachments are downloaded ...」更新为：产出 `PromptSegment[]`——图片产出 `image-ref` 段交由 bridge hydrate，其余附件仍为文本占位。

> `acp` 是否还有其它引用？删除前 grep 确认：`grep -n "acp\." src/interpreter/lark-interpreter.ts`。当前仅类型注解在用，翻转后应为空。

- [ ] **Step 2.11: bridge `routeMessage` 传 `segments`**

`src/bridge/bridge.ts` 的 `case "prompt"`：

```ts
      case "prompt":
        await this.enqueueWithContext(
          event,
          chatId,
          threadId,
          userId,
          messageId,
          interpreted.segments,
        );
        return;
```

- [ ] **Step 2.12: bridge import 调整（删 acp、加 hydrator + PromptSegment）**

1. 删除 `import type * as acp from "@agentclientprotocol/sdk";`（约 30 行；翻转后 `acp.` 无引用）。
2. 把解释器 import 补上 `PromptSegment`：

```ts
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
  type PromptSegment,
} from "../interpreter/lark-interpreter.js";
```

3. 新增 hydrator import（放在 `ChatRuntime` import 附近）：

```ts
import { hydratePrompt } from "./prompt-hydrator.js";
```

- [ ] **Step 2.13: bridge `enqueueWithContext` 签名 + 调用 hydrator**

签名 `prompt: acp.ContentBlock[]` → `segments: PromptSegment[]`。在原 `Promise.all([getUserName, getChatName])` 处，把 hydrate 一并并发（互不依赖），随后按原顺序 push metadata：

```ts
  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    threadId: string | null,
    userId: string,
    messageId: string,
    segments: PromptSegment[],
  ): Promise<void> {
```

把原来的：

```ts
    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const [userName, chatName] = await Promise.all([
      this.http.getUserName(userId),
      isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
    ]);
```

改为（hydrate 与名字查询并发）：

```ts
    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const [prompt, userName, chatName] = await Promise.all([
      hydratePrompt(segments, { downloader: this.http, logger: this.logger }),
      this.http.getUserName(userId),
      isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
    ]);
```

下方 `prompt.push({ type: "text", text: context });` / `prompt.push({ type: "text", text: renderInlineControlHint(chatId, threadId) });` / `const pending: PendingMessage = { prompt, messageId, chatId };` **保持不变**（`prompt` 现在来自 hydrator，仍是 `acp.ContentBlock[]`）。

- [ ] **Step 2.14: 运行解释器测试确认通过**

Run: `npx vitest run src/interpreter`
Expected: PASS（新的 image/post/file 段测试 + 原有 command 测试全绿）。

- [ ] **Step 2.15: 全量类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS（bridge 引用 `interpreted.segments` / `hydratePrompt` 均已就位；无未使用 `acp` import）。

- [ ] **Step 2.16: 格式化检查**

Run: `npx prettier --check "src/**/*.ts"`
Expected: 全部 `matched`；若有 warning，`npx prettier --write` 后重跑。

- [ ] **Step 2.17: 提交（原子）**

```bash
git add src/interpreter/lark-interpreter.ts src/interpreter/lark-interpreter.test.ts src/bridge/bridge.ts
git commit -m "feat(interpreter,bridge): forward inbound images as ACP image blocks"
```

---

## Task 3: 端到端手动验证（可选但推荐）

**Files:** 无（运行时验证）

- [ ] **Step 3.1: 构建 + 重启 bridge**

Run: `npm run build && humming restart --agent claude`
Expected: `humming logs -f` 里出现 `WebSocket connected`。

- [ ] **Step 3.2: 发独立图片**

在已绑定 repo 的 Lark chat 发一张普通图片给支持多模态的 Agent（claude），确认 Agent 能描述图片内容（而非收到 `[图片 (message_id=...)]`）。

- [ ] **Step 3.3: 发图文混排 post**

发一条「文字 + 图片 + 文字」的富文本，确认 Agent 同时看到文字与图片，顺序正确。

- [ ] **Step 3.4: 兜底验证**

（可选）临时把 `MAX_INLINE_IMAGE_BYTES` 调成很小值重启，发图确认退回文本占位且 `bridge.log` 有 warn；验证后改回 `10 * 1024 * 1024`。

---

## Self-Review

**1. Spec coverage**（对照 `docs/superpowers/specs/2026-07-06-inbound-image-support-design.md`）：
- §4.1 `PromptSegment` → Task 1 Step 1.1 ✅
- §4.2 prompt 变体 `blocks` → `segments` → Task 2 Step 2.3 ✅
- §5.1 `parseImage` image-ref / 缺 key 文本 → Step 2.7；`parsePost` 交错保序 + 相邻 text 合并 → Step 2.8 + `normalizeSegments` Step 2.6；其余 parser 机械改 → Step 2.9；移除 `imagePlaceholder` → Step 2.10；`blocksToPrompt`→`segmentsToPrompt` → Step 2.6；`normalizeSegments` → Step 2.6；顶部注释/acp import → Step 2.10 ✅
- §5.2 hydrator（`MAX_INLINE_IMAGE_BYTES` / `ImageDownloader` / `HydrateDeps` / `hydratePrompt` / `imagePlaceholder` / 并发保序 / 不吞错）→ Task 1 Steps 1.4–1.6 ✅
- §5.3 bridge（routeMessage、enqueueWithContext 签名、hydrate 与 getUserName 并发、`this.http` 满足 `ImageDownloader`、metadata 顺序不变）→ Steps 2.11–2.13 ✅
- §6 常量/边界（10 MiB、仅 image、mimeType 直采）→ hydrator 实现 + 测试 Step 1.4/1.6 ✅
- §7 留后门（决策集中在 hydrator）→ hydrator 单一决策点，注释已说明 ✅
- §8 测试计划（解释器单测、hydrator 单测、CI 三件套→本仓库为 tsc+prettier+vitest）→ Steps 2.1/1.4/2.15/2.16 ✅
- §9 用户语义（失败/超限退占位、其它附件不变）→ Step 2.9 回归测试 + hydrator 兜底测试 ✅

**2. Placeholder scan:** 无 TBD/TODO；每个改码步骤都给出完整代码；占位串两处（interpreter 缺 key 文本、hydrator fallback）均写明确切字符串。✅

**3. Type consistency:** `PromptSegment`（`kind: "text" | "image-ref"`）在 Task 1 定义，Task 2 的 parser/测试/bridge 一致使用；`hydratePrompt(segments, deps)` 签名在 hydrator、测试、bridge 三处一致；`segmentsToPrompt`/`normalizeSegments` 命名前后一致；hydrator 产出 `acp.ContentBlock[]`，`PendingMessage.prompt` 类型不变，闭合。✅

## 执行者备注

- 本仓库**未安装 eslint**，提交门槛实为 `tsc --noEmit` + `prettier --check` + `vitest run`（CLAUDE.md 提到的三件套里 eslint 在本仓库缺席，按实际可用命令跑）。
- tsconfig 未开 `noUncheckedIndexedAccess`，故 `out[out.length - 1]`、`para[0]` 等索引访问返回非 `undefined` 收窄类型；`normalizeSegments` 里 `const last = out[out.length - 1]; if (last && last.kind === "text")` 的 `last &&` 是防空数组，保留。
