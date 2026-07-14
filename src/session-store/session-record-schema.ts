/**
 * Zod schema for `sessions.json` (`Record<chatId, SessionRecord[]>`), parsed in
 * {@link FileSessionStore}. `./session-store.js` stays the domain owner and the
 * exported schemas are annotated against it so drift is a compile error.
 */
import { z } from "zod";
import { SESSION_PERMISSION_MODES } from "./session-controls.js";
import type { PermissionMode, SessionControls, SessionRecord } from "./session-store.js";

/** ACP permission policy — the canonical `bridgePermissionMode` validator. */
export const permissionModeSchema: z.ZodType<PermissionMode> = z.enum(SESSION_PERMISSION_MODES);

const sessionConfigControlValueSchema = z.union([
  z.object({ type: z.literal("boolean"), value: z.boolean() }),
  z.object({ value: z.string().min(1) }),
]);

const sessionControlsShape = {
  modelId: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  bridgePermissionMode: permissionModeSchema.optional(),
  config: z.record(z.string(), sessionConfigControlValueSchema).optional(),
};

/** Canonical {@link SessionControls} validator; the CLI reuses it in `settings.json`. */
export const sessionControlsSchema: z.ZodType<SessionControls> = z.object(sessionControlsShape);

const sessionControlPatchSchema = z.object({
  ...sessionControlsShape,
  clearModelId: z.literal(true).optional(),
});

const pendingTargetAgentSchema = z.object({
  sessionId: z.string(),
  profileOnly: z.boolean().optional(),
  agentCommand: z.string(),
  agentArgs: z.array(z.string()),
  agentEnv: z.record(z.string(), z.string()).optional(),
  agentLabel: z.string().optional(),
  cwd: z.string(),
});

const pendingSessionMessageSchema = z.object({
  prompt: z.string(),
  createdAt: z.number(),
});

const pendingSessionConfigurationSchema = z.object({
  targetAgent: pendingTargetAgentSchema.optional(),
  controls: sessionControlPatchSchema.optional(),
  message: pendingSessionMessageSchema.optional(),
  noticeMessageId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** One persisted {@link SessionRecord}; `threadId` is a required own key (`string | null`). */
export const sessionRecordSchema: z.ZodType<SessionRecord> = z.object({
  chatId: z.string(),
  threadId: z.union([z.string(), z.null()]),
  sessionId: z.string(),
  profileOnly: z.boolean().optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  sessionUpdatedAt: z.string().optional(),
  agentCommand: z.string(),
  agentArgs: z.array(z.string()),
  agentEnv: z.record(z.string(), z.string()).optional(),
  agentLabel: z.string().optional(),
  cwd: z.string(),
  controls: sessionControlsSchema.optional(),
  pendingConfiguration: pendingSessionConfigurationSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** The whole `sessions.json` shape: `Record<chatId, SessionRecord[]>`. */
export const sessionsFileSchema = z.record(z.string(), z.array(sessionRecordSchema));
