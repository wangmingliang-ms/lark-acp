import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { LarkLogger } from "../logger/logger.js";
import type {
  PendingSessionMessage,
  PendingTargetAgent,
  SessionCapabilitiesSnapshot,
  SessionControlPatch,
  SessionRecord,
} from "../session-store/session-store.js";
import {
  isPendingSessionMessage,
  isPendingTargetAgent,
  isSessionControlPatch,
} from "../session-store/session-controls.js";
import {
  isLifecycleTransaction,
  type LifecycleTransaction,
} from "../../bin/lifecycle-coordinator.js";

export interface AgentProbeFailureTarget {
  readonly label?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Wire payload for `configureSession` — see docs/cli-command-model-SPEC.md §9. */
export interface ConfigureSessionInput {
  readonly targetAgent?: PendingTargetAgent;
  readonly controls?: SessionControlPatch;
  readonly message?: PendingSessionMessage;
}

export type ControlRequest =
  | {
      readonly id?: string | number;
      readonly method: "ping";
      readonly params: Record<string, never>;
    }
  | {
      readonly id?: string | number;
      readonly method: "beginLifecycle";
      readonly params: { readonly transaction: LifecycleTransaction };
    }
  | {
      readonly id?: string | number;
      readonly method: "shutdown";
      readonly params: Record<string, never>;
    }
  | {
      readonly id?: string | number;
      readonly method: "restart";
      readonly params: Record<string, never>;
    }
  | {
      readonly id?: string | number;
      readonly method: "capabilities";
      readonly params: { readonly chatId: string; readonly threadId?: string | null };
    }
  | {
      readonly id?: string | number;
      readonly method: "configureSession";
      readonly params: {
        readonly chatId: string;
        readonly threadId?: string | null;
        readonly targetAgent?: PendingTargetAgent;
        readonly controls?: SessionControlPatch;
        readonly message?: PendingSessionMessage;
        readonly noticeMessageId?: string | null;
      };
    }
  | {
      readonly id?: string | number;
      readonly method: "sendMessage";
      readonly params: {
        readonly chatId: string;
        readonly threadId?: string | null;
        readonly message: PendingSessionMessage;
        readonly noticeMessageId?: string | null;
      };
    }
  | {
      readonly id?: string | number;
      readonly method: "bindSession";
      readonly params: { readonly record: SessionRecord; readonly noticeMessageId?: string | null };
    }
  | {
      readonly id?: string | number;
      readonly method: "agentProbeFailed";
      readonly params: {
        readonly chatId: string;
        readonly threadId?: string | null;
        readonly agent: AgentProbeFailureTarget;
        readonly error: string;
        readonly noticeMessageId?: string | null;
      };
    };

export type ControlResponse =
  | { readonly ok: true; readonly result: unknown; readonly id?: string | number }
  | { readonly ok: false; readonly error: string; readonly id?: string | number };

export interface BridgeControlHandlers {
  beginLifecycle(transaction: LifecycleTransaction): Promise<{
    readonly accepted: true;
    readonly transactionId: string;
    readonly readyToExit: true;
  }>;
  shutdown(): Promise<unknown>;
  restart(): Promise<unknown>;
  capabilities(chatId: string, threadId: string | null): Promise<SessionCapabilitiesSnapshot>;
  /**
   * Merge a desired target Agent / controls / message into the chat/thread's
   * single Pending Configuration, validate the complete candidate against the
   * resolved Desired Agent, and either apply it now (idle) or queue it for
   * the next Turn boundary (busy). See docs/cli-command-model-SPEC.md §9.
   */
  configureSession(
    chatId: string,
    threadId: string | null,
    input: ConfigureSessionInput,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
  /**
   * Send a Message to the current Topic Session without changing its
   * configuration. Must not overtake an existing Pending Configuration (spec
   * §10).
   */
  sendMessage(
    chatId: string,
    threadId: string | null,
    message: PendingSessionMessage,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
  bindSession(record: SessionRecord, noticeMessageId?: string | null): Promise<unknown>;
  agentProbeFailed(
    chatId: string,
    threadId: string | null,
    agent: AgentProbeFailureTarget,
    error: string,
    noticeMessageId?: string | null,
  ): Promise<unknown>;
}

export interface BridgeControlServerOptions {
  readonly socketPath: string;
  readonly logger: LarkLogger;
  readonly handlers: BridgeControlHandlers;
}

export class BridgeControlServer {
  private readonly socketPath: string;
  private readonly logger: LarkLogger;
  private readonly handlers: BridgeControlHandlers;
  private server: net.Server | null = null;

  constructor(opts: BridgeControlServerOptions) {
    this.socketPath = opts.socketPath;
    this.logger = opts.logger.child({ name: "control" });
    this.handlers = opts.handlers;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!isWindowsNamedPipe(this.socketPath)) {
      fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    }
    removeStaleSocket(this.socketPath);

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buf = "";
      let handled = false;
      socket.setEncoding("utf-8");
      socket.on("error", (err) => {
        const code = errnoCode(err);
        if (code === "EPIPE" || code === "ECONNRESET") {
          this.logger.debug({ err }, "control client disconnected before response");
          return;
        }
        this.logger.warn({ err }, "control socket error");
      });
      socket.on("data", (chunk) => {
        if (handled) return;
        buf += chunk;
        const newline = buf.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        this.reply(socket, buf.slice(0, newline));
      });
      socket.on("end", () => {
        if (handled) return;
        handled = true;
        this.reply(socket, buf);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    this.server.on("error", (err) => {
      this.logger.error({ err }, "control server error");
    });
    this.logger.info({ socketPath: this.socketPath }, "control socket listening");
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeQuietly(this.socketPath);
  }

  private async reply(socket: net.Socket, raw: string): Promise<void> {
    try {
      const response = await this.handleRaw(raw);
      socket.end(`${JSON.stringify(response)}\n`);
    } catch (err: unknown) {
      socket.end(`${JSON.stringify({ ok: false, error: formatError(err) })}\n`);
    }
  }

  private async handleRaw(raw: string): Promise<ControlResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `invalid JSON request: ${formatError(err)}` };
    }
    if (!isControlRequest(parsed)) return { ok: false, error: "invalid control request" };
    try {
      switch (parsed.method) {
        case "ping":
          return {
            ok: true,
            id: parsed.id,
            result: { ready: true },
          };
        case "beginLifecycle":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.beginLifecycle(parsed.params.transaction),
          };
        case "shutdown":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.shutdown(),
          };
        case "restart":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.restart(),
          };

        case "capabilities":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.capabilities(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
            ),
          };
        case "configureSession":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.configureSession(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
              {
                ...(parsed.params.targetAgent ? { targetAgent: parsed.params.targetAgent } : {}),
                ...(parsed.params.controls ? { controls: parsed.params.controls } : {}),
                ...(parsed.params.message ? { message: parsed.params.message } : {}),
              },
              parsed.params.noticeMessageId ?? null,
            ),
          };
        case "sendMessage":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.sendMessage(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
              parsed.params.message,
              parsed.params.noticeMessageId ?? null,
            ),
          };
        case "bindSession":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.bindSession(
              parsed.params.record,
              parsed.params.noticeMessageId ?? null,
            ),
          };
        case "agentProbeFailed":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.agentProbeFailed(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
              parsed.params.agent,
              parsed.params.error,
              parsed.params.noticeMessageId ?? null,
            ),
          };
        default:
          return assertNever(parsed);
      }
    } catch (err) {
      return { ok: false, id: parsed.id, error: formatError(err) };
    }
  }
}

export async function sendControlRequest(
  socketPath: string,
  request: ControlRequest,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      const newline = buf.indexOf("\n");
      if (newline < 0) return;
      const frame = buf.slice(0, newline);
      settle(() => {
        socket.end();
        try {
          const parsed = JSON.parse(frame) as ControlResponse;
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("end", () => {
      if (settled) return;
      settle(() => {
        if (buf.trim().length === 0) {
          reject(new Error("empty control response"));
          return;
        }
        try {
          const parsed = JSON.parse(buf) as ControlResponse;
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (!isRecord(value)) return false;
  if (value["method"] === "beginLifecycle") {
    const params = value["params"];
    return isRecord(params) && isLifecycleTransaction(params["transaction"]);
  }
  if (
    value["method"] === "ping" ||
    value["method"] === "shutdown" ||
    value["method"] === "restart"
  ) {
    return isRecord(value["params"]) && Object.keys(value["params"]).length === 0;
  }
  if (value["method"] === "capabilities") {
    const params = value["params"];
    return isRecord(params) && typeof params["chatId"] === "string";
  }
  if (value["method"] === "configureSession") {
    const params = value["params"];
    if (!isRecord(params) || typeof params["chatId"] !== "string") return false;
    if (params["targetAgent"] !== undefined && !isPendingTargetAgent(params["targetAgent"])) {
      return false;
    }
    if (params["controls"] !== undefined && !isSessionControlPatch(params["controls"])) {
      return false;
    }
    if (params["message"] !== undefined && !isPendingSessionMessage(params["message"])) {
      return false;
    }
    return true;
  }
  if (value["method"] === "sendMessage") {
    const params = value["params"];
    return (
      isRecord(params) &&
      typeof params["chatId"] === "string" &&
      isPendingSessionMessage(params["message"])
    );
  }
  if (value["method"] === "bindSession") {
    const params = value["params"];
    return isRecord(params) && isSessionRecord(params["record"]);
  }
  if (value["method"] === "agentProbeFailed") {
    const params = value["params"];
    return (
      isRecord(params) &&
      typeof params["chatId"] === "string" &&
      isAgentProbeFailureTarget(params["agent"]) &&
      typeof params["error"] === "string"
    );
  }
  return false;
}

function isWindowsNamedPipe(socketPath: string): boolean {
  return socketPath.startsWith("\\\\.\\pipe\\");
}

function isAgentProbeFailureTarget(value: unknown): value is AgentProbeFailureTarget {
  return (
    isRecord(value) &&
    (value["label"] === undefined || typeof value["label"] === "string") &&
    typeof value["command"] === "string" &&
    Array.isArray(value["args"]) &&
    value["args"].every((item) => typeof item === "string") &&
    typeof value["cwd"] === "string"
  );
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isRecord(value) &&
    typeof value["chatId"] === "string" &&
    (typeof value["threadId"] === "string" || value["threadId"] === null) &&
    typeof value["sessionId"] === "string" &&
    typeof value["agentCommand"] === "string" &&
    Array.isArray(value["agentArgs"]) &&
    value["agentArgs"].every((item) => typeof item === "string") &&
    typeof value["cwd"] === "string" &&
    typeof value["createdAt"] === "number" &&
    typeof value["updatedAt"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeStaleSocket(socketPath: string): void {
  if (isWindowsNamedPipe(socketPath)) return;
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

function removeQuietly(socketPath: string): void {
  if (isWindowsNamedPipe(socketPath)) return;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // best-effort cleanup only
  }
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function assertNever(x: never): never {
  throw new Error(`unexpected control request: ${String(x)}`);
}
