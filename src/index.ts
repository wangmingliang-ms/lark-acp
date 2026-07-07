/**
 * `humming` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Top-level exports:
 *
 * - {@link LarkBridge} — the orchestrator, instantiated once per process.
 * - {@link LarkLogger}, {@link createPinoLogger} — structured logging.
 * - {@link LarkPresenter}, {@link LarkCardPresenter} — pluggable UI surface.
 * - {@link SessionStore}, {@link FileSessionStore} — persistent chat → session mapping.
 */

export { LarkBridge } from "./bridge/bridge.js";
export { HUMMING_COMMAND_HELP_GROUPS, renderCommandHelpBody } from "./interpreter/commands.js";
export type {
  LarkBridgeOptions,
  LarkBridgeLarkOptions,
  LarkBridgeAgentOptions,
  LarkBridgeSessionOptions,
  LarkBridgeLifecycleOptions,
  AgentResolver,
  AgentListItem,
  ResolvedAgentInvocation,
} from "./bridge/bridge.js";

export type { PermissionMode } from "./acp/humming-client.js";
export { PERMISSION_MODES, listAgentSessions, probeAgentSessionCapabilities } from "./acp/index.js";
export type {
  ListedAgentSession,
  ListAgentSessionsResult,
  ProbeAgentSessionCapabilitiesResult,
} from "./acp/index.js";

export type { LarkLogger } from "./logger/logger.js";
export { createPinoLogger } from "./logger/logger.js";

export type {
  AgentStatus,
  LarkPresenter,
  CommandResultCardSpec,
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
  SessionControlPatch,
  SessionControlTarget,
  SessionControls,
  SessionRecord,
  SessionStore,
} from "./session-store/session-store.js";
export {
  FileSessionStore,
  SessionAlreadyBoundError,
  SessionStoreControlError,
} from "./session-store/file-session-store.js";

export type { BindingStore, ChatBinding } from "./binding-store/binding-store.js";
export { FileBindingStore, BindingStoreIoError } from "./binding-store/file-binding-store.js";
export { SettingsBindingStore } from "./binding-store/settings-binding-store.js";

export { LarkHttpClient } from "./lark/lark-http.js";
export type { LarkHttpOptions } from "./lark/lark-http.js";
export {
  FeishuRegistrationError,
  beginFeishuRegistration,
  initFeishuRegistration,
  pollFeishuRegistration,
  probeFeishuBot,
  renderQrToTerminal,
  runFeishuLinkRegistration,
  runFeishuQrRegistration,
} from "./lark/registration.js";
export type {
  FeishuBeginRegistrationResult,
  FeishuBotProbeResult,
  FeishuLinkRegistrationProgress,
  FeishuLinkRegistrationResult,
  FeishuQrRegistrationProgress,
  FeishuQrRegistrationResult,
  FeishuRegistrationCredentials,
  FeishuRegistrationDomain,
  FeishuRegistrationOptions,
  FeishuRegistrationTransport,
  PollFeishuRegistrationOptions,
  QrTerminalRenderer,
  RunFeishuLinkRegistrationOptions,
  RunFeishuQrRegistrationOptions,
} from "./lark/registration.js";
export {
  LIFECYCLE_NOTICE_KINDS,
  LifecycleNoticeTimeoutError,
  buildLifecycleNoticeCard,
  sendLifecycleNotice,
} from "./lark/lifecycle-notifier.js";
export type { LifecycleNoticeKind, LifecycleNoticeOptions } from "./lark/lifecycle-notifier.js";

export { installHomeTemplates } from "./home-templates.js";
export type { HomeTemplatePaths, InstallHomeTemplatesOptions } from "./home-templates.js";
