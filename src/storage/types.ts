/**
 * Storage backend interface — polyfill for local file, PostgreSQL, etc.
 */

export interface SessionRecord {
  chatId: string;
  sessionId: string;
  label?: string;
  agentCommand: string;
  agentArgs: string[];
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface StorageBackend {
  init(): Promise<void>;
  close(): Promise<void>;

  /** List all sessions for a chat, ordered by updatedAt descending. */
  listByChat(chatId: string): Promise<SessionRecord[]>;

  /** Get the most recently updated session for a chat. */
  getLatest(chatId: string): Promise<SessionRecord | null>;

  /** Upsert a session record (keyed by chatId + sessionId). */
  save(record: SessionRecord): Promise<void>;

  /** Delete a specific session. */
  delete(chatId: string, sessionId: string): Promise<void>;
}
