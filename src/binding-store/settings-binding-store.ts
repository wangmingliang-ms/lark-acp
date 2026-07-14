import type { BindingStore, ChatBinding } from "./binding-store.js";
import {
  isSettingsFileReadable,
  readSettingsFileObjectTolerant,
  writeSettingsFileObject,
} from "../settings-file/settings-file.js";

/** Shape of one entry under the settings.json `bindings` block. */
interface StoredBinding {
  cwd: string;
}

/**
 * {@link BindingStore} backed by the `bindings` block of a single
 * `settings.json`. This keeps every piece of humming state in one file
 * (Miller's decision) and is the file the agent edits for natural-language
 * binding — the bridge watches it and hot-reloads.
 *
 * Reads/writes are whole-file: the store loads settings.json, mutates only the
 * `bindings` key, and writes the whole object back atomically (temp + rename)
 * so a concurrent reader never sees a half-written file. Other top-level keys
 * (credentials, runtime, agents) are preserved untouched.
 */
export class SettingsBindingStore implements BindingStore {
  private readonly settingsPath: string;

  constructor(settingsPath: string) {
    this.settingsPath = settingsPath;
  }

  async init(): Promise<void> {
    // The shared writer creates the parent directory on the first write.
  }

  async close(): Promise<void> {
    // Writes are synchronous + atomic; nothing to flush.
  }

  async get(chatId: string): Promise<ChatBinding | null> {
    const stored = this.readBindings()[chatId];
    if (!stored) return null;
    return this.hydrate(chatId, stored);
  }

  async set(binding: ChatBinding): Promise<void> {
    const root = readSettingsFileObjectTolerant(this.settingsPath);
    const bindings = this.bindingsOf(root);
    bindings[binding.chatId] = { cwd: binding.cwd };
    root["bindings"] = bindings;
    writeSettingsFileObject(this.settingsPath, root);
  }

  async delete(chatId: string): Promise<void> {
    const root = readSettingsFileObjectTolerant(this.settingsPath);
    const bindings = this.bindingsOf(root);
    if (!(chatId in bindings)) return;
    delete bindings[chatId];
    root["bindings"] = bindings;
    writeSettingsFileObject(this.settingsPath, root);
  }

  async list(): Promise<readonly ChatBinding[]> {
    const stored = this.readBindings();
    return Object.entries(stored).map(([chatId, b]) => this.hydrate(chatId, b));
  }

  /**
   * Whether settings.json is currently readable as JSON. Returns `true` when
   * the file is absent (a legitimately empty state) or parses cleanly; `false`
   * only when the file exists but is malformed (e.g. an agent is mid-write).
   * Callers that diff bindings (hot-reload) use this to skip a transient bad
   * read instead of mistaking it for "all bindings removed".
   */
  isReadable(): boolean {
    return isSettingsFileReadable(this.settingsPath);
  }

  // ----- internals --------------------------------------------------------

  private hydrate(chatId: string, stored: StoredBinding): ChatBinding {
    const now = Date.now();
    return {
      chatId,
      cwd: stored.cwd,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Read only the `bindings` map (empty object when file/key absent or bad). */
  private readBindings(): Record<string, StoredBinding> {
    return this.bindingsOf(readSettingsFileObjectTolerant(this.settingsPath));
  }

  private bindingsOf(root: Record<string, unknown>): Record<string, StoredBinding> {
    const raw = root["bindings"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, StoredBinding> = {};
    for (const [chatId, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const cwd = (val as Record<string, unknown>)["cwd"];
        if (typeof cwd === "string") out[chatId] = { cwd };
      }
    }
    return out;
  }
}
