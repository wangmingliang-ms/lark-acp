/**
 * `lark-acp` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Top-level exports:
 *
 * - {@link LarkBridge} — the orchestrator, instantiated once per process.
 * - {@link LarkLogger}, {@link createPinoLogger} — structured logging.
 * - {@link LarkPresenter}, {@link LarkCardPresenter} — pluggable UI surface.
 * - {@link SessionStore}, {@link FileSessionStore} — persistent chat → session mapping.
 */

export { LarkBridge } from "./bridge/bridge.js";
export type {
  LarkBridgeOptions,
  LarkBridgeLarkOptions,
  LarkBridgeAgentOptions,
  LarkBridgeSessionOptions,
  LarkBridgeLifecycleOptions,
  AgentResolver,
  ResolvedAgentInvocation,
} from "./bridge/bridge.js";

export type { PermissionMode } from "./acp/lark-acp-client.js";
export { PERMISSION_MODES } from "./acp/lark-acp-client.js";

export type { LarkLogger } from "./logger/logger.js";
export { createPinoLogger } from "./logger/logger.js";

export type {
  AgentStatus,
  LarkPresenter,
  NoticeCardSpec,
  NoticeTemplate,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "./presenter/presenter.js";
export { LarkCardPresenter } from "./presenter/lark-presenter.js";
export type { LarkCardPresenterOptions } from "./presenter/lark-presenter.js";

export type {
  PermissionMode as SessionPermissionMode,
  SessionCapabilitiesSnapshot,
  SessionConfigControlValue,
  SessionControlTarget,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "./session-store/session-store.js";
export { FileSessionStore, SessionStoreControlError } from "./session-store/file-session-store.js";

export type { BindingStore, ChatBinding } from "./binding-store/binding-store.js";
export { FileBindingStore, BindingStoreIoError } from "./binding-store/file-binding-store.js";
export { SettingsBindingStore } from "./binding-store/settings-binding-store.js";
export type { BindingAgentResolver } from "./binding-store/settings-binding-store.js";

export { LarkHttpClient } from "./lark/lark-http.js";
export type { LarkHttpOptions } from "./lark/lark-http.js";
export {
  LIFECYCLE_NOTICE_KINDS,
  LifecycleNoticeTimeoutError,
  buildLifecycleNoticeCard,
  sendLifecycleNotice,
} from "./lark/lifecycle-notifier.js";
export type { LifecycleNoticeKind, LifecycleNoticeOptions } from "./lark/lifecycle-notifier.js";
