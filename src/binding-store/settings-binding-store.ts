import fs from "node:fs";
import path from "node:path";
import type { BindingStore, ChatBinding } from "./binding-store.js";

/**
 * Resolve an agent selection string into a concrete invocation, so a binding
 * read from settings.json (which stores only `{ cwd, agent }`) can be turned
 * into the full {@link ChatBinding} the bridge needs. Injected by the CLI,
 * which owns the preset registry.
 */
export type BindingAgentResolver = (agentSelection: string | undefined) => {
  readonly agentLabel: string;
  readonly agentCommand: string;
  readonly agentArgs: readonly string[];
  readonly agentEnv?: Readonly<Record<string, string>>;
};

/** Shape of one entry under the settings.json `bindings` block. */
interface StoredBinding {
  cwd: string;
  agent?: string;
}

/**
 * {@link BindingStore} backed by the `bindings` block of a single
 * `settings.json`. This keeps every piece of lark-acp state in one file
 * (Miller's decision) and is the file the agent edits for natural-language
 * binding — the bridge watches it and hot-reloads (phase 2).
 *
 * Reads/writes are whole-file: the store loads settings.json, mutates only the
 * `bindings` key, and writes the whole object back atomically (temp + rename)
 * so a concurrent reader never sees a half-written file. Other top-level keys
 * (credentials, runtime, agents) are preserved untouched.
 */
export class SettingsBindingStore implements BindingStore {
  private readonly settingsPath: string;
  private readonly resolveAgent: BindingAgentResolver;

  constructor(settingsPath: string, resolveAgent: BindingAgentResolver) {
    this.settingsPath = settingsPath;
    this.resolveAgent = resolveAgent;
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
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
    const root = this.readRoot();
    const bindings = this.bindingsOf(root);
    bindings[binding.chatId] = {
      cwd: binding.cwd,
      ...(binding.agentLabel ? { agent: binding.agentLabel } : {}),
    };
    root["bindings"] = bindings;
    this.writeRoot(root);
  }

  async delete(chatId: string): Promise<void> {
    const root = this.readRoot();
    const bindings = this.bindingsOf(root);
    if (!(chatId in bindings)) return;
    delete bindings[chatId];
    root["bindings"] = bindings;
    this.writeRoot(root);
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
    if (!fs.existsSync(this.settingsPath)) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8")) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }

  // ----- internals --------------------------------------------------------

  /** Turn a `{ cwd, agent }` entry into a full ChatBinding via the resolver. */
  private hydrate(chatId: string, stored: StoredBinding): ChatBinding {
    const inv = this.resolveAgent(stored.agent);
    const now = Date.now();
    return {
      chatId,
      cwd: stored.cwd,
      agentLabel: inv.agentLabel,
      agentCommand: inv.agentCommand,
      agentArgs: inv.agentArgs,
      ...(inv.agentEnv ? { agentEnv: inv.agentEnv } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Read only the `bindings` map (empty object when file/key absent or bad). */
  private readBindings(): Record<string, StoredBinding> {
    return this.bindingsOf(this.readRoot());
  }

  private bindingsOf(root: Record<string, unknown>): Record<string, StoredBinding> {
    const raw = root["bindings"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, StoredBinding> = {};
    for (const [chatId, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const cwd = (val as Record<string, unknown>)["cwd"];
        const agent = (val as Record<string, unknown>)["agent"];
        if (typeof cwd === "string") {
          out[chatId] = { cwd, ...(typeof agent === "string" ? { agent } : {}) };
        }
      }
    }
    return out;
  }

  /**
   * Read the whole settings.json object. Returns `{}` when the file is absent
   * or unparseable (e.g. an agent is mid-write) so a transient bad read never
   * throws — the caller keeps its last-good in-memory state.
   */
  private readRoot(): Record<string, unknown> {
    if (!fs.existsSync(this.settingsPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Atomically write the whole settings object: temp file + rename. */
  private writeRoot(root: Record<string, unknown>): void {
    const dir = path.dirname(this.settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.settingsPath);
  }
}
