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
  label?: string;
  title?: string;
  agentCommand: string;
  agentArgs: string[];
  /** Human label for the resolved agent preset/raw command, if known. */
  agentLabel?: string;
  cwd: string;
  controls?: SessionControls;
  createdAt: number;
  updatedAt: number;
}

export interface SessionControls {
  /** ACP `session/set_model` payload field. */
  modelId?: string;
  /** ACP `session/set_mode` payload field. */
  modeId?: string;
  /** lark-acp client-side permission policy, not an ACP-native field. */
  bridgePermissionMode?: PermissionMode;
  /** ACP `session/set_config_option` values, keyed by configId. */
  config?: Readonly<Record<string, SessionConfigControlValue>>;
}

export type PermissionMode = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";

export type SessionConfigControlValue =
  | { readonly type: "boolean"; readonly value: boolean }
  // ACP select config requests use `{ value: <valueId> }` with no `type` field.
  | { readonly value: string };

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
  readonly models?: acp.SessionModelState | null;
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

  /** Merge control fields into one existing/current session record. */
  setControls(target: SessionControlTarget, controls: SessionControls): Promise<SessionRecord>;

  delete(chatId: string, sessionId: string): Promise<void>;
}
