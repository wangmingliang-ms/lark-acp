import type {
  PendingSessionConfiguration,
  PendingSessionMessage,
  PendingTargetAgent,
  PermissionMode,
  SessionConfigControlValue,
  SessionControlPatch,
  SessionControls,
} from "./session-store.js";

export const SESSION_PERMISSION_MODES: readonly PermissionMode[] = [
  "alwaysAllow",
  "alwaysDeny",
  "alwaysAsk",
];

export function mergeSessionControls(
  existing: SessionControls | undefined,
  patch: SessionControlPatch | undefined,
): SessionControls {
  const out: SessionControls = { ...(existing ?? {}) };
  if (patch?.clearModelId === true) delete out.modelId;
  if (patch?.modelId !== undefined) out.modelId = patch.modelId;
  if (patch?.modeId !== undefined) out.modeId = patch.modeId;
  if (patch?.bridgePermissionMode !== undefined) {
    out.bridgePermissionMode = patch.bridgePermissionMode;
  }
  const config = mergeSessionConfig(existing?.config, patch?.config);
  if (config) out.config = config;
  else delete out.config;
  return out;
}

/**
 * Merge a control patch into an already-queued patch, preserving clear-model
 * intent until a concrete model override supersedes it.
 */
export function mergeSessionControlPatches(
  existing: SessionControlPatch | undefined,
  patch: SessionControlPatch,
): SessionControlPatch {
  const out: SessionControlPatch = { ...(existing ?? {}) };
  if (patch.clearModelId === true) {
    delete out.modelId;
    out.clearModelId = true;
  }
  if (patch.modelId !== undefined) {
    delete out.clearModelId;
    out.modelId = patch.modelId;
  }
  if (patch.modeId !== undefined) out.modeId = patch.modeId;
  if (patch.bridgePermissionMode !== undefined) {
    out.bridgePermissionMode = patch.bridgePermissionMode;
  }
  const config = mergeSessionConfig(existing?.config, patch.config);
  if (config) out.config = config;
  else delete out.config;
  return out;
}

/**
 * Merge a control patch into an already-accumulated patch, returning
 * `undefined` when the merged result has no fields at all (as opposed to
 * {@link mergeSessionControlPatches}, which always returns an object).
 */
export function mergeSessionControlPatchesOrUndefined(
  existing: SessionControlPatch | undefined,
  patch: SessionControlPatch | undefined,
): SessionControlPatch | undefined {
  if (existing === undefined && patch === undefined) return undefined;
  const merged = mergeSessionControlPatches(existing, patch ?? {});
  return hasSessionControls(merged) ? merged : undefined;
}

/** Incoming fields for a single `configure`/`send` request, before merging. */
export interface PendingSessionConfigurationInput {
  readonly targetAgent?: PendingTargetAgent;
  readonly controls?: SessionControlPatch;
  readonly message?: PendingSessionMessage;
}

/**
 * Merge a new `configure`/`send` request into an existing Pending
 * Configuration field-by-field, last-write-wins (spec §9.4): later scalars
 * (Agent, Message) and Config keys win, unmentioned fields are retained, and
 * omitting a field never clears it. Does not validate — the caller validates
 * the merged candidate against the resolved Desired Agent (spec §9.3, §9.6).
 */
export function mergePendingSessionConfiguration(
  existing: PendingSessionConfiguration | undefined,
  incoming: PendingSessionConfigurationInput,
): PendingSessionConfiguration {
  const targetAgent = incoming.targetAgent ?? existing?.targetAgent;
  const controls = mergeSessionControlPatchesOrUndefined(existing?.controls, incoming.controls);
  const message = incoming.message ?? existing?.message;
  const now = Date.now();
  return {
    ...(targetAgent ? { targetAgent } : {}),
    ...(controls ? { controls } : {}),
    ...(message ? { message } : {}),
    ...(existing?.noticeMessageId ? { noticeMessageId: existing.noticeMessageId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Whether a Pending Configuration candidate contains at least one desired
 * profile field (Agent, Model, Mode, Permission, or Config). A Message by
 * itself is not a configuration (spec §9.1).
 */
export function pendingConfigurationHasProfileField(
  configuration: Pick<PendingSessionConfiguration, "targetAgent" | "controls">,
): boolean {
  return (
    configuration.targetAgent !== undefined ||
    (configuration.controls !== undefined && hasSessionControls(configuration.controls))
  );
}

export function hasSessionControls(controls: SessionControlPatch | SessionControls): boolean {
  return (
    ("clearModelId" in controls && controls.clearModelId === true) ||
    controls.modelId !== undefined ||
    controls.modeId !== undefined ||
    controls.bridgePermissionMode !== undefined ||
    Object.keys(controls.config ?? {}).length > 0
  );
}

export function isSessionControlPatch(value: unknown): value is SessionControlPatch {
  if (!isRecord(value)) return false;

  const modelId = value["modelId"];
  if (modelId !== undefined && !isNonEmptyString(modelId)) return false;

  const clearModelId = value["clearModelId"];
  if (clearModelId !== undefined && clearModelId !== true) return false;
  if (modelId !== undefined && clearModelId === true) return false;

  const modeId = value["modeId"];
  if (modeId !== undefined && !isNonEmptyString(modeId)) return false;

  const bridgePermissionMode = value["bridgePermissionMode"];
  if (bridgePermissionMode !== undefined && !isSessionPermissionMode(bridgePermissionMode)) {
    return false;
  }

  const config = value["config"];
  if (config !== undefined && !isSessionConfigControlMap(config)) return false;

  return (
    modelId !== undefined ||
    clearModelId !== undefined ||
    modeId !== undefined ||
    bridgePermissionMode !== undefined ||
    config !== undefined
  );
}

/** Type guard for the wire-level {@link PendingTargetAgent} shape used by `configureSession`. */
export function isPendingTargetAgent(value: unknown): value is PendingTargetAgent {
  return (
    isRecord(value) &&
    typeof value["sessionId"] === "string" &&
    (value["profileOnly"] === undefined || typeof value["profileOnly"] === "boolean") &&
    typeof value["agentCommand"] === "string" &&
    Array.isArray(value["agentArgs"]) &&
    value["agentArgs"].every((item) => typeof item === "string") &&
    typeof value["cwd"] === "string" &&
    (value["agentLabel"] === undefined || typeof value["agentLabel"] === "string")
  );
}

/** Type guard for the wire-level {@link PendingSessionMessage} shape used by `configureSession`/`sendMessage`. */
export function isPendingSessionMessage(value: unknown): value is PendingSessionMessage {
  return (
    isRecord(value) &&
    typeof value["prompt"] === "string" &&
    value["prompt"].trim().length > 0 &&
    typeof value["createdAt"] === "number"
  );
}

function mergeSessionConfig(
  existing: SessionControls["config"] | undefined,
  patch: SessionControls["config"] | undefined,
): Record<string, SessionConfigControlValue> | undefined {
  const merged: Record<string, SessionConfigControlValue> = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isSessionConfigControlMap(value: unknown): value is SessionControls["config"] {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isSessionConfigControlValue);
}

function isSessionConfigControlValue(value: unknown): value is SessionConfigControlValue {
  if (!isRecord(value)) return false;
  const type = value["type"];
  const optionValue = value["value"];
  if (type === "boolean") return typeof optionValue === "boolean";
  if (type !== undefined && type !== "select") return false;
  return isNonEmptyString(optionValue);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSessionPermissionMode(value: unknown): value is PermissionMode {
  return isNonEmptyString(value) && SESSION_PERMISSION_MODES.some((mode) => mode === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
