import type * as acp from "@agentclientprotocol/sdk";

export interface SessionRuntimeCapabilities {
  readonly models?: acp.SessionModelState | null;
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
}

export function capabilitiesFromSessionResponse(response: {
  readonly models?: acp.SessionModelState | null;
  readonly modes?: acp.SessionModeState | null;
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
}): SessionRuntimeCapabilities {
  return {
    ...(response.models !== undefined ? { models: response.models } : {}),
    ...(response.modes !== undefined ? { modes: response.modes } : {}),
    ...(response.configOptions !== undefined ? { configOptions: response.configOptions } : {}),
  };
}
