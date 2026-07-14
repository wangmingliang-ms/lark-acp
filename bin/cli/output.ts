import process from "node:process";
import type { Command } from "commander";
import type { SessionCapabilitiesSnapshot } from "../../src/index.js";
import { addJsonOption } from "./options.js";

export type CapabilitiesView = Omit<SessionCapabilitiesSnapshot, "session"> & {
  readonly session: Omit<SessionCapabilitiesSnapshot["session"], "chatId"> & {
    readonly chatId?: string;
  };
};

export type CapabilityProjection = {
  readonly name: string;
  readonly description: string;
  readonly project: (snapshot: CapabilitiesView, json: boolean) => void;
};

/**
 * Registers shared projection commands while callers retain capability acquisition.
 */
export function registerCapabilityProjection<TOptions extends { readonly json?: boolean }>(
  parent: Command,
  projection: CapabilityProjection,
  configureOptions: (cmd: Command) => void,
  fetchSnapshot: (options: TOptions) => Promise<CapabilitiesView>,
): void {
  const cmd = parent.command(projection.name).description(projection.description);
  configureOptions(cmd);
  addJsonOption(cmd);
  cmd.action(async function (this: Command) {
    const options = this.optsWithGlobals<TOptions>();
    const snapshot = await fetchSnapshot(options);
    projection.project(snapshot, options.json === true);
  });
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printCapabilities(snapshot: CapabilitiesView, json: boolean): void {
  if (json) {
    printJson(snapshot);
    return;
  }
  const lines = [
    `Agent: ${snapshot.agent.label ?? snapshot.agent.command} (${snapshot.agent.cwd})`,
    `Session: ${snapshot.session.sessionId}${snapshot.session.title ? ` — ${snapshot.session.title}` : ""}`,
    "",
    ...formatModelsLines(snapshot),
    "",
    ...formatModesLines(snapshot),
    "",
    ...formatConfigLines(snapshot),
    "",
    ...formatPermissionsLines(snapshot),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printModels(snapshot: CapabilitiesView, json: boolean): void {
  if (json) {
    printJson({ models: snapshot.models ?? null });
    return;
  }
  process.stdout.write(`${formatModelsLines(snapshot).join("\n")}\n`);
}

export function printModes(snapshot: CapabilitiesView, json: boolean): void {
  if (json) {
    printJson({ modes: snapshot.modes ?? null });
    return;
  }
  process.stdout.write(`${formatModesLines(snapshot).join("\n")}\n`);
}

export function printPermissions(snapshot: CapabilitiesView, json: boolean): void {
  if (json) {
    printJson({
      bridgePermissionModes: snapshot.bridgePermissionModes,
      bridgePermissionMode: snapshot.bridgePermissionMode,
    });
    return;
  }
  process.stdout.write(`${formatPermissionsLines(snapshot).join("\n")}\n`);
}

function formatModelsLines(snapshot: CapabilitiesView): string[] {
  const models = snapshot.models;
  if (!models) return ["Models: (not supported by this Agent)"];
  const lines = ["Models:"];
  for (const model of models.availableModels) {
    const current = model.modelId === models.currentModelId ? " (current)" : "";
    lines.push(
      `  • ${model.modelId}${current}${model.description ? ` — ${model.description}` : ""}`,
    );
  }
  return lines;
}

function formatModesLines(snapshot: CapabilitiesView): string[] {
  const modes = snapshot.modes;
  if (!modes) return ["Modes: (not supported by this Agent)"];
  const lines = ["Modes:"];
  for (const mode of modes.availableModes) {
    const current = mode.id === modes.currentModeId ? " (current)" : "";
    lines.push(`  • ${mode.id}${current}${mode.description ? ` — ${mode.description}` : ""}`);
  }
  return lines;
}

function formatConfigLines(snapshot: CapabilitiesView): string[] {
  const configOptions = snapshot.configOptions;
  if (!configOptions || configOptions.length === 0) return ["Config: (none)"];
  const lines = ["Config:"];
  for (const option of configOptions) {
    const current = option.type === "boolean" ? String(option.currentValue) : option.currentValue;
    lines.push(`  • ${option.id} (${option.type}) = ${current} — ${option.name}`);
  }
  return lines;
}

function formatPermissionsLines(snapshot: CapabilitiesView): string[] {
  return [
    `Permission: ${snapshot.bridgePermissionMode} (available: ${snapshot.bridgePermissionModes.join(", ")})`,
  ];
}
