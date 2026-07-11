import type {
  PermissionMode,
  SessionConfigControlValue,
  SessionControlPatch,
  SessionControls,
} from "./session-store.js";

const SESSION_PERMISSION_MODES: readonly PermissionMode[] = [
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
