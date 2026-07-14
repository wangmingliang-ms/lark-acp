/**
 * Zod schemas for `settings.json` and other externally-authored JSON the CLI
 * reads (docs/cli-command-model-SPEC.md §13, invariant 12). No handwritten
 * JSON validators — every external shape is parsed through one of these.
 */
import { z } from "zod";
import { permissionModeSchema, sessionControlsSchema } from "../../../src/index.js";
import type { SessionCapabilitiesSnapshot, SessionConfigControlValue } from "../../../src/index.js";

const feishuRegistrationDomainSchema = z.enum(["feishu", "lark"]);

const userPresetPatchSchema = z.object({
  label: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const storedBindingSchema = z.object({
  cwd: z.string().min(1),
});

const fileCredentialsSchema = z.object({
  appId: z.string().min(1).optional(),
  appSecret: z.string().min(1).optional(),
});

const fileSetupSchema = z.object({
  domain: feishuRegistrationDomainSchema.optional(),
  ownerOpenId: z.string().min(1).optional(),
  botName: z.string().min(1).optional(),
});

const fileRuntimeSchema = z.object({
  cwd: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  idleTimeoutMinutes: z.number().int().min(0).optional(),
  maxChats: z.number().int().min(1).optional(),
  hideThoughts: z.boolean().optional(),
  hideTools: z.boolean().optional(),
  hideCancelButton: z.boolean().optional(),
  permissionMode: permissionModeSchema.optional(),
  defaultControls: sessionControlsSchema.optional(),
  groupRequireMention: z.boolean().optional(),
  unboundCwd: z.string().optional(),
  lifecycleNotifyChatIds: z.array(z.string()).optional(),
  globalControlChatIds: z.array(z.string()).optional(),
  idleStatusCardMs: z.number().int().min(0).optional(),
});

export const fileConfigSchema = z.object({
  credentials: fileCredentialsSchema.default({}),
  setup: fileSetupSchema.default({}),
  dataDir: z.string().min(1).optional(),
  runtime: fileRuntimeSchema.default({}),
  agents: z.record(z.string(), userPresetPatchSchema).default({}),
  bindings: z.record(z.string(), storedBindingSchema).default({}),
});

/** Parsed shape of `settings.json`, after Zod validation and defaulting. */
export type FileConfig = z.infer<typeof fileConfigSchema>;
export type FileRuntime = z.infer<typeof fileRuntimeSchema>;
export type FileSetup = z.infer<typeof fileSetupSchema>;
export type StoredBinding = z.infer<typeof storedBindingSchema>;
export type UserPresetPatch = z.infer<typeof userPresetPatchSchema>;

export const EMPTY_FILE_CONFIG: FileConfig = fileConfigSchema.parse({});

/** A message payload read from `--message-file`/`--message-stdin`; must be non-blank once trimmed. */
export const messageContentSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, "message must not be empty"));

/** One `--config <id=value>` assignment; `true`/`false` values become boolean config entries. */
export function parseConfigAssignmentValue(raw: string): SessionConfigControlValue {
  if (raw === "true") return { type: "boolean", value: true };
  if (raw === "false") return { type: "boolean", value: false };
  return { value: raw };
}

const modelStateSchema = z
  .object({
    availableModels: z.array(
      z.object({
        modelId: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
      }),
    ),
    currentModelId: z.string().optional(),
  })
  .nullable();

const modeStateSchema = z
  .object({
    availableModes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
      }),
    ),
    currentModeId: z.string(),
  })
  .nullable();

const selectConfigValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
});

const selectConfigGroupSchema = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(selectConfigValueSchema),
});

const configOptionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("boolean"),
    id: z.string(),
    name: z.string(),
    currentValue: z.boolean(),
    description: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("select"),
    id: z.string(),
    name: z.string(),
    currentValue: z.string(),
    options: z.union([z.array(selectConfigValueSchema), z.array(selectConfigGroupSchema)]),
    description: z.string().nullable().optional(),
  }),
]);

/** Fully validate the capability snapshot received from the Bridge control socket. */
export const sessionCapabilitiesSnapshotSchema: z.ZodType<SessionCapabilitiesSnapshot> = z.object({
  session: z.object({
    chatId: z.string(),
    threadId: z.string().nullable(),
    sessionId: z.string(),
    title: z.string().optional(),
  }),
  agent: z.object({
    label: z.string().optional(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
  }),
  models: modelStateSchema.optional(),
  modes: modeStateSchema.optional(),
  configOptions: z.array(configOptionSchema).nullable().optional(),
  bridgePermissionModes: z.array(permissionModeSchema),
  bridgePermissionMode: permissionModeSchema,
});
