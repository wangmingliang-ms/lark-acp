export { HummingClient, PERMISSION_MODES } from "./humming-client.js";
export type { HummingClientOptions, PermissionMode } from "./humming-client.js";
export {
  spawnAgent,
  spawnAndResumeAgent,
  listAgentSessions,
  probeAgentSessionCapabilities,
  killAgent,
  AgentAuthError,
} from "./agent-process.js";
export type {
  AgentProcess,
  ListedAgentSession,
  ListAgentSessionsOptions,
  ListAgentSessionsResult,
  ProbeAgentSessionCapabilitiesResult,
  SpawnAgentOptions,
} from "./agent-process.js";
export {
  projectLifecycleDiagnostic,
  RingBufferLifecycleDiagnosticSink,
} from "./lifecycle-diagnostics.js";
export type {
  AcknowledgementLifecycleDiagnostic,
  DeliveryLifecycleDiagnostic,
  DiagnosticCorrelation,
  LifecycleDiagnosticEvent,
  LifecycleDiagnosticLoggerProjection,
  LifecycleDiagnosticSink,
  LifecycleTransitionName,
  RouterLifecycleDiagnostic,
  SemanticPhase,
  TransitionLifecycleDiagnostic,
} from "./lifecycle-diagnostics.js";
