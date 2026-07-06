import fs from "node:fs";
import path from "node:path";
import type {
  SessionControlTarget,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "./session-store.js";

const SESSIONS_FILE_NAME = "sessions.json";

/** Pre-multi-session legacy on-disk shape. */
interface LegacyRecord {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

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

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file — treat as empty rather than crashing.
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const record = parsed as Record<string, unknown>;
    const firstValue = Object.values(record)[0];

    const isLegacy =
      firstValue !== undefined &&
      typeof firstValue === "object" &&
      firstValue !== null &&
      "sessionId" in (firstValue as Record<string, unknown>) &&
      !("chatId" in (firstValue as Record<string, unknown>));

    if (isLegacy) {
      this.migrateLegacy(record as Record<string, LegacyRecord>);
      return;
    }

    for (const [chatId, entries] of Object.entries(record)) {
      if (Array.isArray(entries)) {
        // Backfill `threadId: null` on records persisted before topic support
        // (they belong to the chat's "main" conversation). Newer records
        // already carry their own threadId, which we preserve.
        const normalized = (entries as SessionRecord[]).map((r) => ({
          ...r,
          threadId: r.threadId ?? null,
        }));
        this.data.set(chatId, normalized);
      }
    }
  }

  async close(): Promise<void> {
    // Flush any pending write synchronously so a deferred setImmediate can't
    // fire after the caller considers the store closed (and, in tests, after
    // the temp dir is gone) — same contract as FileBindingStore.close().
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
    controls: SessionControls,
  ): Promise<SessionRecord> {
    const record = await this.findControlTarget(target);
    const updated: SessionRecord = {
      ...record,
      controls: mergeControls(record.controls, controls),
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return updated;
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

  private migrateLegacy(legacy: Record<string, LegacyRecord>): void {
    for (const [oldKey, val] of Object.entries(legacy)) {
      this.data.set(oldKey, [
        {
          chatId: oldKey,
          threadId: null,
          sessionId: val.sessionId,
          agentCommand: "",
          agentArgs: [],
          cwd: val.cwd,
          createdAt: val.updatedAt,
          updatedAt: val.updatedAt,
        },
      ]);
    }
    this.scheduleFlush();
  }
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

function sameAgentInvocation(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.agentCommand === b.agentCommand &&
    JSON.stringify(a.agentArgs) === JSON.stringify(b.agentArgs) &&
    (a.agentLabel ?? "") === (b.agentLabel ?? "")
  );
}

function mergeControls(
  existing: SessionControls | undefined,
  patch: SessionControls,
): SessionControls {
  return {
    ...(existing ?? {}),
    ...patch,
    config: {
      ...(existing?.config ?? {}),
      ...(patch.config ?? {}),
    },
  };
}
