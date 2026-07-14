import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  SessionControlPatch,
  SessionControlTarget,
  PendingSessionConfiguration,
  SessionRecord,
  SessionStore,
} from "./session-store.js";
import { mergeSessionControls } from "./session-controls.js";
import { sessionsFileSchema } from "./session-record-schema.js";

const SESSIONS_FILE_NAME = "sessions.json";

/**
 * JSON-file backed {@link SessionStore}. Writes are coalesced via
 * `setImmediate` so a burst of `save()` calls produces one fsync.
 */
export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly data = new Map<string, SessionRecord[]>();
  private flushScheduled = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, SESSIONS_FILE_NAME);
  }

  /**
   * @throws {SessionStoreFormatError} when the file parses as JSON but its
   *         shape does not match the current `Record<chatId, SessionRecord[]>`
   *         format (e.g. a pre-multi-session single-record-per-chat shape, or
   *         an entry missing an explicit `threadId`). A file that fails to
   *         parse as JSON at all is treated as empty rather than thrown —
   *         the same tolerance applied to a transient half-written file
   *         elsewhere (e.g. `SettingsBindingStore`).
   */
  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable file — treat as empty rather than crashing (e.g. a
      // concurrent writer caught mid-write).
      return;
    }

    const result = sessionsFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new SessionStoreFormatError(describeSessionsFileError(this.filePath, result.error));
    }
    for (const [chatId, records] of Object.entries(result.data)) {
      this.data.set(chatId, [...records]);
    }
  }

  async close(): Promise<void> {
    // Flush any pending write synchronously so a deferred setImmediate can't
    // fire after the caller considers the store closed (and, in tests, after
    // the temp dir is gone).
    if (this.flushScheduled) this.flushNow();
  }

  async listByChat(chatId: string): Promise<readonly SessionRecord[]> {
    const records = this.data.get(chatId);
    if (!records) return [];
    return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listByThread(chatId: string, threadId: string | null): Promise<readonly SessionRecord[]> {
    const records = this.data.get(chatId);
    if (!records) return [];
    return records.filter((r) => r.threadId === threadId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getLatest(chatId: string, threadId: string | null): Promise<SessionRecord | null> {
    const records = this.data.get(chatId);
    if (!records?.length) return null;
    let latest: SessionRecord | null = null;
    for (const r of records) {
      if (r.threadId !== threadId) continue;
      if (!latest || r.updatedAt > latest.updatedAt) latest = r;
    }
    return latest;
  }

  async save(record: SessionRecord): Promise<void> {
    let records = this.data.get(record.chatId);
    if (!records) {
      records = [];
      this.data.set(record.chatId, records);
    }
    if (!record.profileOnly) {
      records = records.filter((r) => !(r.threadId === record.threadId && r.profileOnly));
      this.data.set(record.chatId, records);
    }
    const idx = records.findIndex((r) => r.sessionId === record.sessionId);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    this.scheduleFlush();
  }

  async bindThreadSession(record: SessionRecord): Promise<SessionRecord> {
    let records = this.data.get(record.chatId);
    if (!records) {
      records = [];
      this.data.set(record.chatId, records);
    }
    const conflict = this.findSessionBindingConflict(record);
    if (conflict) throw new SessionAlreadyBoundError(conflict.chatId, conflict.threadId);

    const replacement = { ...record };
    const withoutThreadOrSession = records.filter(
      (r) => r.threadId !== record.threadId && r.sessionId !== record.sessionId,
    );
    withoutThreadOrSession.push(replacement);
    this.data.set(record.chatId, withoutThreadOrSession);
    this.scheduleFlush();
    return replacement;
  }

  private findSessionBindingConflict(record: SessionRecord): SessionRecord | null {
    for (const records of this.data.values()) {
      const conflict = records.find(
        (r) =>
          r.sessionId === record.sessionId &&
          r.cwd === record.cwd &&
          sameAgentInvocation(r, record) &&
          (r.chatId !== record.chatId || r.threadId !== record.threadId),
      );
      if (conflict) return conflict;
    }
    return null;
  }

  async setControls(
    target: SessionControlTarget,
    controls: SessionControlPatch,
  ): Promise<SessionRecord> {
    const record = await this.findControlTarget(target);
    const updated: SessionRecord = {
      ...record,
      controls: mergeSessionControls(record.controls, controls),
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  async setPendingConfiguration(
    target: SessionControlTarget,
    configuration: PendingSessionConfiguration,
  ): Promise<SessionRecord> {
    const record = await this.findControlTarget(target);
    const updated: SessionRecord = {
      ...record,
      pendingConfiguration: configuration,
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  async clearPendingConfigurationIfMatches(
    target: SessionControlTarget,
    expected: PendingSessionConfiguration,
  ): Promise<{ readonly record: SessionRecord; readonly cleared: boolean }> {
    const record = await this.findControlTarget(target);
    if (!isDeepStrictEqual(record.pendingConfiguration, expected)) {
      return { record, cleared: false };
    }
    const updated: SessionRecord = {
      ...record,
      pendingConfiguration: undefined,
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return { record: updated, cleared: true };
  }

  async clearThread(chatId: string, threadId: string | null): Promise<void> {
    const records = this.data.get(chatId);
    if (!records) return;
    const kept = records.filter((r) => r.threadId !== threadId);
    if (kept.length === records.length) return;
    if (kept.length > 0) this.data.set(chatId, kept);
    else this.data.delete(chatId);
    this.scheduleFlush();
  }

  async delete(chatId: string, sessionId: string): Promise<void> {
    const records = this.data.get(chatId);
    if (!records) return;
    const idx = records.findIndex((r) => r.sessionId === sessionId);
    if (idx < 0) return;
    records.splice(idx, 1);
    if (!records.length) this.data.delete(chatId);
    this.scheduleFlush();
  }

  private async findControlTarget(target: SessionControlTarget): Promise<SessionRecord> {
    const records = this.data.get(target.chatId) ?? [];
    let record: SessionRecord | undefined;
    if (target.sessionId !== undefined) {
      record = records.find((r) => r.sessionId === target.sessionId);
    } else {
      record = records
        .filter((r) => r.threadId === target.threadId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
    if (record === undefined) {
      throw new SessionStoreControlError(
        `no session found for chat=${target.chatId}, thread=${target.threadId ?? "<main>"}`,
      );
    }
    return record;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      if (!this.flushScheduled) return;
      try {
        this.flushNow();
      } catch (err) {
        // Best-effort background durability. A transient FS error here must
        // not crash the bridge process — surface it and keep running; the
        // next save()/delete() reschedules a flush. Not silent (§12).
        process.stderr.write(`[humming] session store flush failed: ${String(err)}\n`);
      }
    });
  }

  /**
   * Write the in-memory map to disk synchronously.
   *
   * @throws when the write fails (missing dir, permissions, disk full).
   */
  private flushNow(): void {
    this.flushScheduled = false;
    const obj: Record<string, SessionRecord[]> = {};
    for (const [chatId, records] of this.data) {
      obj[chatId] = records;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }
}

/** Raised when a persisted `sessions.json` entry does not match the current {@link SessionRecord} shape. */
export class SessionStoreFormatError extends Error {
  override readonly name = "SessionStoreFormatError";
}

export class SessionStoreControlError extends Error {
  override readonly name = "SessionStoreControlError";
}

export class SessionAlreadyBoundError extends Error {
  override readonly name = "SessionAlreadyBoundError";

  constructor(
    readonly existingChatId: string,
    readonly existingThreadId: string | null,
  ) {
    super("该 session 已经绑定到另一个 thread，请先重置原 thread 后再重新绑定。");
  }
}

/**
 * Translate a {@link sessionsFileSchema} validation failure into a
 * path-based message for {@link SessionStoreFormatError}. The first issue's
 * path pinpoints the container level (whole file / chat entry) or the exact
 * record field that is malformed. A malformed session record fails the whole
 * `init()` rather than being dropped or backfilled — there is no compatibility
 * adapter for older shapes.
 */
function describeSessionsFileError(filePath: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return `${filePath} is not a valid sessions.json file`;
  const segments = issue.path;
  if (segments.length === 0) {
    return `${filePath} must contain a JSON object mapping chatId to an array of session records`;
  }
  const chatId = String(segments[0]);
  if (segments.length === 1) {
    return (
      `${filePath}: entry for chat "${chatId}" must be an array of session records ` +
      `(pre-multi-session single-record-per-chat storage is no longer supported)`
    );
  }
  const where = `${filePath}: chat "${chatId}" record[${String(segments[1])}]`;
  if (segments.length === 2) return `${where} must be an object`;
  const field = segments
    .slice(2)
    .map((segment) => String(segment))
    .join(".");
  return `${where}: "${field}" is invalid (${issue.message})`;
}

function sameAgentInvocation(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.agentCommand === b.agentCommand &&
    JSON.stringify(a.agentArgs) === JSON.stringify(b.agentArgs) &&
    (a.agentLabel ?? "") === (b.agentLabel ?? "")
  );
}
