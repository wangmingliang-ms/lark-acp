import type * as acp from "@agentclientprotocol/sdk";

/**
 * Persistent mapping from a `(chatId, threadId)` pair → ACP session(s), used
 * so the bridge can resume the agent's conversation across process restarts.
 *
 * A chat's Feishu "topics" (话题) map to distinct sessions: each topic thread
 * carries its own {@link SessionRecord.threadId}. Messages sent outside any
 * topic use `threadId: null`, which resumes the chat's single "main"
 * conversation — identical to the pre-topic behaviour.
 *
 * The library does **not** ship a default — callers must construct a
 * {@link FileSessionStore} or their own implementation, and pass it to
 * `LarkBridge`.
 */

export interface SessionRecord {
  chatId: string;
  /**
   * Feishu topic (话题) id this session belongs to, or `null` for messages
   * sent outside any topic (the chat's "main" conversation).
   */
  threadId: string | null;
  sessionId: string;
  /**
   * Session-level profile selected before a real ACP session exists. Runtime
   * must start a fresh ACP session instead of trying to resume this id.
   */
  profileOnly?: boolean;
  /** Human-readable title reported by the ACP agent for this session, if known. */
  label?: string;
  title?: string;
  /** Agent-reported ISO timestamp for the session's last activity, if known. */
  sessionUpdatedAt?: string;
  agentCommand: string;
  agentArgs: string[];
  agentEnv?: Readonly<Record<string, string>>;
  /** Human label for the resolved agent preset/raw command, if known. */
  agentLabel?: string;
  cwd: string;
  controls?: SessionControls;
  /**
   * The single canonical not-yet-applied desired profile change for this
   * chat/thread (see docs/cli-command-model-SPEC.md §9.3). The Bridge is its
   * sole semantic owner: it merges later `configure`/`send` requests into
   * this field and validates the complete candidate before replacing it.
   */
  pendingConfiguration?: PendingSessionConfiguration;
  createdAt: number;
  updatedAt: number;
}

/**
 * A Message queued to run once its associated target profile (Pending
 * Configuration, or the current profile for a plain `send`) is fully active.
 */
export interface PendingSessionMessage {
  readonly prompt: string;
  readonly createdAt: number;
}

/** Desired Agent invocation captured by a Pending Configuration. */
export interface PendingTargetAgent {
  readonly sessionId: string;
  readonly profileOnly?: boolean;
  readonly agentCommand: string;
  readonly agentArgs: readonly string[];
  readonly agentEnv?: Readonly<Record<string, string>>;
  readonly agentLabel?: string;
  readonly cwd: string;
}

/**
 * The single canonical representation of a Topic's not-yet-applied desired
 * profile change (spec §9.3). At most one exists per chat/thread. A later
 * `configure`/`send` request merges into it field-by-field with
 * last-write-wins semantics (spec §9.4); the complete merged candidate is
 * validated against the resolved Desired Agent before it replaces the
 * previous value. It is applied — target profile, then controls, then the
 * attached Message — at the next Turn boundary while busy, or immediately
 * while idle (spec §9.5).
 */
export interface PendingSessionConfiguration {
  /** Present only when the desired change includes an Agent switch/start. */
  readonly targetAgent?: PendingTargetAgent;
  /** Accumulated Model/Mode/Permission/Config patch, validated against the Desired Agent. */
  readonly controls?: SessionControlPatch;
  /** Message to send once the target profile is fully active. */
  readonly message?: PendingSessionMessage;
  /** Card id of the "queued" notice; patched in place when applied or rejected. */
  readonly noticeMessageId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionControls {
  /** ACP `session/set_model` payload field. */
  modelId?: string;
  /** ACP `session/set_mode` payload field. */
  modeId?: string;
  /** humming client-side permission policy, not an ACP-native field. */
  bridgePermissionMode?: PermissionMode;
  /** ACP `session/set_config_option` values, keyed by configId. */
  config?: Readonly<Record<string, SessionConfigControlValue>>;
}

export interface SessionControlPatch extends SessionControls {
  /** Clear any explicit `controls.modelId`; used for `/model auto`. */
  clearModelId?: true;
}

export type PermissionMode = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";

export type SessionConfigControlValue =
  | { readonly type: "boolean"; readonly value: boolean }
  // ACP select config requests use `{ value: <valueId> }` with no `type` field.
  | { readonly value: string };

export type HummingSessionModelState = Omit<acp.SessionModelState, "currentModelId"> & {
  /** Absent when Humming intentionally clears the explicit model override (`/model auto`). */
  readonly currentModelId?: string;
};

export interface SessionCapabilitiesSnapshot {
  readonly session: {
    readonly chatId: string;
    readonly threadId: string | null;
    readonly sessionId: string;
    readonly title?: string;
  };
  readonly agent: {
    readonly label?: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  };
  readonly models?: HummingSessionModelState | null;
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
  readonly bridgePermissionModes: readonly PermissionMode[];
  readonly bridgePermissionMode: PermissionMode;
}

export interface SessionControlTarget {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly sessionId?: string;
}

export interface SessionStore {
  /**
   * Open / verify the underlying resource. Must be called before any other
   * method.
   *
   * @throws when the underlying resource (file system, database) cannot be
   *         initialised.
   */
  init(): Promise<void>;

  /** Release any open handles. */
  close(): Promise<void>;

  /**
   * Every session for a chat, across **all** its topics, sorted by
   * `updatedAt` descending. Used when a chat-wide operation (rebind / unbind)
   * must clear every topic's session.
   */
  listByChat(chatId: string): Promise<readonly SessionRecord[]>;

  /**
   * Sessions for one specific topic within a chat, sorted by `updatedAt`
   * descending. `threadId: null` selects the chat's "main" (non-topic)
   * conversation.
   */
  listByThread(chatId: string, threadId: string | null): Promise<readonly SessionRecord[]>;

  /**
   * Most recently updated session for a specific topic, or `null` if none.
   * `threadId: null` resumes the chat's "main" (non-topic) conversation.
   */
  getLatest(chatId: string, threadId: string | null): Promise<SessionRecord | null>;

  /** Upsert a record (key: `chatId` + `sessionId`). */
  save(record: SessionRecord): Promise<void>;

  /**
   * Replace the current session for one chat/thread with an existing ACP
   * session selected from the agent's own session list. Implementations should
   * reject if that ACP session is already bound to another chat/thread so one
   * live agent session is not driven concurrently from multiple topics.
   */
  bindThreadSession(record: SessionRecord): Promise<SessionRecord>;

  /** Merge control fields into one existing/current session record's live (already-applied) profile. */
  setControls(target: SessionControlTarget, controls: SessionControlPatch): Promise<SessionRecord>;

  /**
   * Replace the single canonical Pending Configuration for one
   * existing/current session. Callers (the Bridge) must have already merged
   * and validated the complete candidate (spec §9.4) — this store performs
   * no merging or validation of its own.
   *
   * @throws when no session exists yet for this chat/thread.
   */
  setPendingConfiguration(
    target: SessionControlTarget,
    configuration: PendingSessionConfiguration,
  ): Promise<SessionRecord>;

  /**
   * Clear the persisted Pending Configuration for one chat/thread, but only
   * when it is still deep-equal to `expected` — the value the caller read
   * before applying it. A later `configure`/`send` request may have already
   * replaced it with a newer candidate (spec §9.3); this conditional clear
   * ensures an in-progress application can never silently discard that newer
   * request. Applying a Pending Configuration must read it, apply target
   * profile -> controls -> Message in order, and only then call this — never
   * clear eagerly before application completes (spec §9.5, §9.6).
   *
   * @throws when no session exists yet for this chat/thread.
   */
  clearPendingConfigurationIfMatches(
    target: SessionControlTarget,
    expected: PendingSessionConfiguration,
  ): Promise<{ readonly record: SessionRecord; readonly cleared: boolean }>;

  /** Drop all persisted ACP sessions for one chat/thread. */
  clearThread(chatId: string, threadId: string | null): Promise<void>;

  delete(chatId: string, sessionId: string): Promise<void>;
}
