# Inbound attachment support via ACP ResourceLink

**Date:** 2026-07-07
**Status:** Proposed — pending user spec review
**Builds on:** `2026-07-06-inbound-image-support-design.md` (inbound image support, shipped in commits `8be08cd`, `54896f1`)

## 1. Problem

Humming now forwards inbound **images** to the agent as ACP `image` blocks, but
every **other** attachment type (file, audio/voice, video) is still degraded to
a descriptive text placeholder such as `[文件: report.pdf (file_key=...)]`. The
agent sees the filename but cannot open the bytes.

We want the agent to actually reach the content of non-image attachments —
without bloating every prompt with megabytes of base64.

## 2. Approach: ResourceLink to a local temp file

ACP's `ContentBlock` union includes a `resource_link` variant:

```ts
// @agentclientprotocol/sdk — types.gen.d.ts:1961
type ResourceLink = {
  name: string;
  uri: string;
  mimeType?: string | null;
  size?: number | null;
  description?: string | null;
  title?: string | null;
  annotations?: Annotations | null;
  _meta?: { [k: string]: unknown } | null;
};
```

A `ResourceLink` is a **pointer, not bytes**: it carries a `uri` the agent is
expected to dereference itself. Two facts make the local-temp-file approach the
right fit:

- **Lark URIs are not directly fetchable by the agent.** Downloading a message
  resource requires a tenant access token via `im.messageResource.get`; the
  agent has no Lark credentials. So we cannot hand the agent a Lark URL.
- **Humming runs the agent locally** (stdio ACP subprocess with a `cwd`). A
  `file://` URI pointing at a downloaded temp file is directly openable by
  coding agents (Claude Code, Codex, …) via their normal file-read tools.

So Humming downloads the Lark resource to a local temp file and hands the agent
a `file://` `ResourceLink`. This is **lazy**: the bytes hit disk once, and the
agent reads them only if/when it needs them — no base64 in the prompt.

### 2.1 Why not inline (EmbeddedResource / audio block)?

`EmbeddedResource` (base64 `blob`) and the native `audio` block would inline the
bytes into the prompt, same downside images have (the 10 MiB cap exists for
exactly this reason). Files and videos are routinely larger than images, and
coding agents cannot use audio/video perceptually anyway. A link keeps prompts
small and defers the cost. Images keep their existing inline treatment because
vision models genuinely "see" them and they are size-bounded.

## 3. Scope

| Lark `message_type`            | Today                    | After this feature                     |
| ------------------------------ | ------------------------ | -------------------------------------- |
| `image`, post-embedded `img`   | inline `image` block     | **unchanged**                          |
| `file`                         | text placeholder         | **`resource_link` → local temp file**  |
| `audio` (voice)                | text placeholder         | **`resource_link` → local temp file**  |
| `media` (video)                | text placeholder         | **`resource_link` → local temp file**  |
| `sticker`                      | text placeholder         | **stays text placeholder**             |
| `share_chat` / `share_user`    | text placeholder         | **stays text placeholder**             |
| `location` / `merge_forward`   | text placeholder         | **stays text placeholder**             |

### 3.1 Non-goals

- **Stickers are excluded.** Lark's `im.messageResource.get` docs state
  "暂不支持表情包资源下载" (sticker resources cannot be downloaded), so `sticker`
  stays a text placeholder.
- **share_chat / share_user / location / merge_forward** have no downloadable
  binary resource; they stay text placeholders.
- **No inline audio/video perception.** Audio is linked, not transcribed or
  inlined. Revisit later if an agent gains audio perception.
- **No ACP capability gating.** Consistent with the image feature (Strategy C):
  always emit the `resource_link`; there is no per-agent probe. If an agent
  ignores `resource_link` blocks, the `name`/`description` still convey context.
- **No outbound attachments.** This is inbound (user → agent) only.

## 4. Architecture

Extends the existing **pure interpreter / effectful hydrator** split introduced
by the image feature. No new architectural seam.

### 4.1 Interpreter (pure) — new `PromptSegment` variant

`src/interpreter/lark-interpreter.ts` gains a third `PromptSegment` variant:

```ts
export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image-ref"; readonly messageId: string; readonly imageKey: string }
  | {
      readonly kind: "resource-ref";
      readonly messageId: string;
      readonly fileKey: string;
      /** Filename for the temp file + `ResourceLink.name`. Synthesized when the
       *  event carries no name (e.g. voice messages). */
      readonly name: string;
      /** Human description → `ResourceLink.description` and the download-failure
       *  fallback text. Carries duration/label the event provides. */
      readonly label: string;
    };
```

`parseFile`, `parseAudio`, `parseMedia` change from emitting a `text` segment to
emitting a `resource-ref` segment:

- **file**: `name = file_name ?? synthesized`, `label = "文件: <name>"`.
- **audio**: no filename in the event → `name = "voice-<shortKey>.opus"`
  (Lark voice messages are Opus), `label = "语音 (<duration>)"`.
- **media**: `name = file_name ?? "video-<shortKey>.mp4"`,
  `label = "视频: <name> (<duration>)"`.

When `file_key` is missing, fall back to the existing text placeholder (no
`resource-ref` without a key to download). `parseSticker`, `parseShareChat`,
`parseShareUser`, `parseLocation`, and `merge_forward` are unchanged.

The interpreter stays **pure** — it never downloads. `normalizeSegments` passes
`resource-ref` through untouched (like `image-ref`), preserving order.

### 4.2 Hydrator (effect) — new `resource-ref` branch

`src/bridge/prompt-hydrator.ts` gains a branch that turns a `resource-ref` into
a `resource_link` block:

1. Compute the destination path via `inboundResourcePath(inboundDir, messageId, name)`
   (§4.4): `<inboundDir>/<messageId>/<sanitized-name>`.
2. `await deps.resourceDownloader.downloadMessageResourceToFile(messageId, fileKey, destPath)`
   → `{ mimeType, size }`. The downloader streams to disk (no buffering).
3. Emit:
   ```ts
   {
     type: "resource_link",
     uri: pathToFileURL(destPath).href,   // node:url — correct file:// encoding
     name,
     description: label,
     ...(mimeType ? { mimeType } : {}),
     ...(size ? { size } : {}),
   }
   ```
4. On **any** failure (download error, mkdir error) → log `warn` and fall back to
   a text placeholder `resourcePlaceholder(segment)` = `[<label> — 附件下载失败 (file_key=<fileKey>)]`.
   Never throws — one bad attachment never breaks the message.

Ordering and concurrency are unchanged: `hydratePrompt` keeps mapping segments
through `Promise.all`, so text/image/resource order is preserved.

New deps on `HydrateDeps`:

```ts
export interface ResourceDownloader {
  /**
   * Download a non-image message resource (file/audio/video) straight to
   * `destPath`, creating parent dirs. Returns best-effort `mimeType` and the
   * byte `size` written.
   * @throws when the SDK call rejects or the stream/disk write fails.
   */
  downloadMessageResourceToFile(
    messageId: string,
    fileKey: string,
    destPath: string,
  ): Promise<{ mimeType: string | null; size: number }>;
}

export interface HydrateDeps {
  readonly downloader: ImageDownloader;
  readonly resourceDownloader: ResourceDownloader;
  readonly logger: LarkLogger;
  readonly maxInlineImageBytes?: number;
  /** Injectable for tests; defaults to `~/.humming/inbound`. */
  readonly inboundDir?: string;
}
```

`LarkHttpClient` implements both `ImageDownloader` and `ResourceDownloader`, so
`bridge.ts` passes `this.http` for both.

### 4.3 Lark HTTP — `downloadMessageResourceToFile`

`src/lark/lark-http.ts` gains:

```ts
async downloadMessageResourceToFile(
  messageId: string,
  fileKey: string,
  destPath: string,
): Promise<{ mimeType: string | null; size: number }> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const res = await this.client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "file" },   // "file" covers file/audio/media per Lark docs
  });
  await pipeline(res.getReadableStream(), createWriteStream(destPath));
  const { size } = await fs.stat(destPath);
  const mimeType = parseContentType(res.headers);   // reuse header-parsing helper
  return { mimeType, size };
}
```

Uses `node:stream/promises` `pipeline`, `node:fs` (`createWriteStream`,
`promises.mkdir`, `promises.stat`). The `type: "file"` param is correct for
file, audio, and video (only images use `type: "image"`). Lark caps resources at
100 MB; we do not add a smaller cap since bytes never enter the prompt.

The `content-type` header parsing (`split(";")[0].trim()`) is factored into a
small shared helper reused by `downloadMessageImage`.

### 4.4 Temp-file lifecycle — `src/bridge/inbound-store.ts`

A new small module `src/bridge/inbound-store.ts` owns every pure decision about
where inbound resources live and when they expire, so the hydrator and bridge
depend on named helpers rather than ad-hoc path math:

- `DEFAULT_INBOUND_DIR` — `path.join(os.homedir(), ".humming", "inbound")`.
- `inboundResourcePath(inboundDir, messageId, name)` — builds
  `<inboundDir>/<messageId>/<safeAttachmentName(name, messageId)>` (pure).
- `safeAttachmentName(rawName, fallbackKey)` — see §4.5.
- `isExpired(mtimeMs, nowMs, maxAgeMs)` — pure age predicate.
- `sweepInboundDir(inboundDir, deps)` — effect that deletes expired entries.

**Location:** `~/.humming/inbound/<messageId>/<sanitized-name>` — alongside the
other `~/.humming/` state, namespaced by `messageId` so concurrent messages and
identical filenames never collide, and cleanup is per-message granular.

**Cleanup:** best-effort **age-based sweep** on bridge startup — delete
`~/.humming/inbound/*` entries whose mtime is older than 24 h. This is simple,
bounded, and safe: a coding agent may open a linked file many turns after the
message arrives, and 24 h comfortably outlives a live session, while preventing
unbounded disk growth. `sweepInboundDir` takes an injected clock + fs surface so
it is unit-testable, and is wired into bridge startup as a fire-and-forget effect
that logs but never blocks or throws.

### 4.5 Filename sanitization

`safeAttachmentName(rawName, fallbackKey)` (in `inbound-store.ts`, pure):

- Strips path separators (`/`, `\`) and control chars; collapses to a safe base
  name via `node:path` `basename`.
- Rejects empty / `.` / `..` → synthesizes `attachment-<shortKey>`.
- Caps length to a sane maximum (e.g. 128 chars, preserving extension).

Unit-tested in isolation (no disk).

## 5. Data flow (end to end)

```
Lark file/audio/media event
  → interpretLarkMessage (pure)         → PromptSegment { kind:"resource-ref", ... }
  → bridge.enqueueWithContext
  → hydratePrompt (effect)
      → resourceDownloader.downloadMessageResourceToFile → ~/.humming/inbound/<mid>/<name>
      → { type:"resource_link", uri:"file://…", name, description, mimeType?, size? }
  → prompt: acp.ContentBlock[]          → agent
```

Failure at the download step degrades that one segment to a text placeholder;
all other segments (text, images, other resources) are unaffected.

## 6. Testing strategy

**Interpreter (`lark-interpreter.test.ts`)** — pure, no I/O:

- `file` message → single `resource-ref` with `name` = file_name, `label`
  starting `文件:`.
- `audio` message → `resource-ref` with synthesized `.opus` name and `语音`
  label including duration.
- `media` message → `resource-ref` with video name and `视频` label.
- `file` with missing `file_key` → text placeholder (no `resource-ref`).
- `sticker` still → text placeholder.

**Hydrator (`prompt-hydrator.test.ts`)** — fake `ResourceDownloader` writing into
a per-test temp dir (`os.tmpdir()`), spy logger:

- `resource-ref` → `resource_link` block with a `file://` uri under `inboundDir`,
  correct `name`/`description`, and `mimeType`/`size` when the fake supplies them.
- download throws → text placeholder + `warn`; no throw.
- mixed `[text, image-ref, resource-ref]` → output order preserved.

**Pure helpers** — `safeAttachmentName` and the age-sweep predicate unit-tested
directly.

**Regression** — full `tsc --noEmit` + `vitest run` + `prettier --check` green,
then `npm run build` and a manual E2E (send a file/voice/video in a bound chat,
confirm the agent receives a `resource_link` and can open the temp file). Bridge
restart is a manual step (the agent cannot restart the bridge it runs inside).

## 7. Risks & mitigations

| Risk                                             | Mitigation                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Agent doesn't understand `resource_link`         | `name`/`description` still convey context; no worse than today's text.     |
| Agent lacks local file-read tooling              | Degrades to "a link it can't open" — still names the file; acceptable.     |
| Disk growth from downloaded temp files           | 24 h startup sweep bounds it; namespaced by `messageId`.                    |
| Large (up to 100 MB) download blocks the turn    | Streamed to disk (not buffered); acceptable, matches Lark's own limit.     |
| Filename injection / path traversal              | `safeAttachmentName` strips separators and `..`; writes only under inboundDir. |
| `content-type` header absent                     | `mimeType` is optional on `ResourceLink`; omit it when unknown.            |

## 8. Files touched

- `src/interpreter/lark-interpreter.ts` — new `resource-ref` variant; `parseFile`
  / `parseAudio` / `parseMedia` emit it; name/label helpers.
- `src/interpreter/index.ts` — no change (re-exports `PromptSegment` already).
- `src/interpreter/lark-interpreter.test.ts` — updated file/audio/media cases.
- `src/bridge/prompt-hydrator.ts` — `ResourceDownloader`, `inboundDir`,
  `resource-ref` branch, `resourcePlaceholder`.
- `src/bridge/prompt-hydrator.test.ts` — resource-ref tests.
- `src/lark/lark-http.ts` — `downloadMessageResourceToFile`, shared content-type
  helper.
- `src/bridge/bridge.ts` — pass `resourceDownloader: this.http` into
  `hydratePrompt`; call `sweepInboundDir` at startup (fire-and-forget).
- (new) `src/bridge/inbound-store.ts` — `DEFAULT_INBOUND_DIR`,
  `inboundResourcePath`, `safeAttachmentName`, `isExpired`, `sweepInboundDir`.
- (new) `src/bridge/inbound-store.test.ts` — sanitizer, path builder, and sweep
  predicate tests.
