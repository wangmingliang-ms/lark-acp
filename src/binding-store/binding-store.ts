/**
 * Persistent mapping from `chatId` → the repo that chat is bound to.
 *
 * This is what lets a single Lark bot serve many project groups: each chat
 * points at its own working directory. Distinct from {@link SessionStore},
 * which records agent-side conversation ids and per-topic session profiles
 * (agent + controls) for resume — a binding answers only "which repo is this
 * chat pointed at", of which there is exactly one per chat.
 *
 * The library does **not** ship a default — callers construct a
 * {@link SettingsBindingStore} (or their own implementation) and pass it to
 * `LarkBridge`.
 */

/**
 * A chat's current repo binding. Agent/model/mode/permission/config live on
 * {@link SessionRecord}; new topics inherit the current repo's recent session
 * profile, falling back to the global default agent only when the repo has no
 * history.
 */
export interface ChatBinding {
  readonly chatId: string;
  /** Absolute working directory the agent subprocess runs in. */
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BindingStore {
  /**
   * Open / verify the underlying resource. Must be called before any other
   * method.
   *
   * @throws when the underlying resource (file system) cannot be initialised.
   */
  init(): Promise<void>;

  /** Release any open handles. */
  close(): Promise<void>;

  /** The binding for a chat, or `null` if the chat is unbound. */
  get(chatId: string): Promise<ChatBinding | null>;

  /** Upsert a chat's binding (key: `chatId`). */
  set(binding: ChatBinding): Promise<void>;

  /** Remove a chat's binding. No-op if the chat was unbound. */
  delete(chatId: string): Promise<void>;

  /** Every known binding, insertion order not guaranteed. */
  list(): Promise<readonly ChatBinding[]>;
}
