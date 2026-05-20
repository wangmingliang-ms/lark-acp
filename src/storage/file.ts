/**
 * FileStorageBackend — JSON file storage for session records.
 * Auto-migrates from legacy { userId: { sessionId, cwd, updatedAt } } format.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionRecord, StorageBackend } from "./types.js";

/** Legacy format: { [userId]: { sessionId, cwd, updatedAt } } */
interface LegacyRecord {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export class FileStorageBackend implements StorageBackend {
  private filePath: string;
  private data: Map<string, SessionRecord[]> = new Map();
  private pending = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "sessions.json");
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const record = parsed as Record<string, unknown>;
    const firstValue = Object.values(record)[0];

    // Detect legacy format: values are { sessionId, cwd, updatedAt }
    const isLegacy = firstValue && typeof firstValue === "object" &&
      "sessionId" in (firstValue as Record<string, unknown>) && !("chatId" in (firstValue as Record<string, unknown>));

    if (isLegacy) {
      this.migrateLegacy(record as Record<string, LegacyRecord>);
    } else {
      // New format: values are SessionRecord[]
      for (const [chatId, entries] of Object.entries(record)) {
        if (Array.isArray(entries)) {
          this.data.set(chatId, entries as SessionRecord[]);
        }
      }
    }
  }

  async close(): Promise<void> {
    // no-op
  }

  async listByChat(chatId: string): Promise<SessionRecord[]> {
    const records = this.data.get(chatId) ?? [];
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getLatest(chatId: string): Promise<SessionRecord | null> {
    const records = this.data.get(chatId);
    if (!records?.length) return null;
    return records.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  }

  async save(record: SessionRecord): Promise<void> {
    let records = this.data.get(record.chatId);
    if (!records) {
      records = [];
      this.data.set(record.chatId, records);
    }
    const idx = records.findIndex((r) => r.sessionId === record.sessionId);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    this.flush();
  }

  async delete(chatId: string, sessionId: string): Promise<void> {
    const records = this.data.get(chatId);
    if (!records) return;
    const idx = records.findIndex((r) => r.sessionId === sessionId);
    if (idx >= 0) {
      records.splice(idx, 1);
      if (!records.length) this.data.delete(chatId);
      this.flush();
    }
  }

  private flush(): void {
    if (this.pending) return;
    this.pending = true;
    // De-duplicate rapid writes
    setImmediate(() => {
      this.pending = false;
      const obj: Record<string, SessionRecord[]> = {};
      for (const [chatId, records] of this.data) {
        obj[chatId] = records;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    });
  }

  private migrateLegacy(legacy: Record<string, LegacyRecord>): void {
    for (const [oldKey, val] of Object.entries(legacy)) {
      // Use the old key as chatId — best approximation for migration
      const record: SessionRecord = {
        chatId: oldKey,
        sessionId: val.sessionId,
        agentCommand: "",
        agentArgs: [],
        cwd: val.cwd,
        createdAt: val.updatedAt,
        updatedAt: val.updatedAt,
      };
      this.data.set(oldKey, [record]);
    }
    this.flush();
  }
}
