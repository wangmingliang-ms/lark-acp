import fs from "node:fs";
import path from "node:path";
import type { BindingStore, ChatBinding } from "./binding-store.js";

const BINDINGS_FILE_NAME = "bindings.json";

/**
 * Raised when the bindings file exists but cannot be read. A corrupt /
 * unparseable file is treated as empty (see {@link FileBindingStore.init})
 * rather than raised, so this only fires on real IO failures.
 */
export class BindingStoreIoError extends Error {
  override readonly name = "BindingStoreIoError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * JSON-file backed {@link BindingStore}. On-disk shape is a flat
 * `Record<chatId, ChatBinding>`. Writes are coalesced via `setImmediate`
 * so a burst of `set()` calls produces one fsync — same strategy as
 * {@link FileSessionStore}.
 */
export class FileBindingStore implements BindingStore {
  private readonly filePath: string;
  private readonly data = new Map<string, ChatBinding>();
  private flushScheduled = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, BINDINGS_FILE_NAME);
  }

  /** @throws {BindingStoreIoError} when the storage dir cannot be created. */
  async init(): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      throw new BindingStoreIoError(`failed to create binding store dir`, { cause: err });
    }
    if (!fs.existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt / unreadable file — treat as empty rather than crash the
      // bridge on startup. A subsequent set() overwrites it cleanly.
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const binding = toBinding(chatId, value);
      if (binding) this.data.set(chatId, binding);
    }
  }

  async close(): Promise<void> {
    // Flush any pending write synchronously so a deferred setImmediate can't
    // fire after the caller considers the store closed (and, in tests, after
    // the temp dir is gone).
    if (this.flushScheduled) this.flushNow();
  }

  async get(chatId: string): Promise<ChatBinding | null> {
    return this.data.get(chatId) ?? null;
  }

  async set(binding: ChatBinding): Promise<void> {
    this.data.set(binding.chatId, binding);
    this.scheduleFlush();
  }

  async delete(chatId: string): Promise<void> {
    if (!this.data.delete(chatId)) return;
    this.scheduleFlush();
  }

  async list(): Promise<readonly ChatBinding[]> {
    return [...this.data.values()];
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
        // next set()/delete() reschedules a flush. Not silent (§12).
        process.stderr.write(`[humming] binding store flush failed: ${String(err)}\n`);
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
    const obj: Record<string, ChatBinding> = {};
    for (const [chatId, binding] of this.data) obj[chatId] = binding;
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }
}

/**
 * Validate one on-disk entry into a {@link ChatBinding}. Returns `null` for
 * structurally-invalid entries so a partially-corrupt file degrades to
 * "those chats are unbound" instead of throwing.
 */
function toBinding(chatId: string, value: unknown): ChatBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  const cwd = v["cwd"];
  if (typeof cwd !== "string") return null;

  const createdAt = typeof v["createdAt"] === "number" ? v["createdAt"] : Date.now();
  const updatedAt = typeof v["updatedAt"] === "number" ? v["updatedAt"] : createdAt;

  return {
    chatId,
    cwd,
    createdAt,
    updatedAt,
  };
}
