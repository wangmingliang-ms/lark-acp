import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { LarkLogger } from "../logger/logger.js";
import type {
  SessionCapabilitiesSnapshot,
  SessionControls,
} from "../session-store/session-store.js";

export type ControlRequest =
  | {
      readonly id?: string | number;
      readonly method: "capabilities";
      readonly params: { readonly chatId: string; readonly threadId?: string | null };
    }
  | {
      readonly id?: string | number;
      readonly method: "setControls";
      readonly params: {
        readonly chatId: string;
        readonly threadId?: string | null;
        readonly controls: SessionControls;
      };
    };

export type ControlResponse =
  | { readonly ok: true; readonly result: unknown; readonly id?: string | number }
  | { readonly ok: false; readonly error: string; readonly id?: string | number };

export interface BridgeControlHandlers {
  capabilities(chatId: string, threadId: string | null): Promise<SessionCapabilitiesSnapshot>;
  setControls(chatId: string, threadId: string | null, controls: SessionControls): Promise<unknown>;
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
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    removeStaleSocket(this.socketPath);

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buf = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk) => {
        buf += chunk;
      });
      socket.on("end", () => {
        this.handleRaw(buf)
          .then((response) => socket.end(`${JSON.stringify(response)}\n`))
          .catch((err: unknown) =>
            socket.end(`${JSON.stringify({ ok: false, error: formatError(err) })}\n`),
          );
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
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
        case "capabilities":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.capabilities(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
            ),
          };
        case "setControls":
          return {
            ok: true,
            id: parsed.id,
            result: await this.handlers.setControls(
              parsed.params.chatId,
              parsed.params.threadId ?? null,
              parsed.params.controls,
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
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.end(JSON.stringify(request));
    });
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(buf) as ControlResponse;
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (!isRecord(value)) return false;
  if (value["method"] === "capabilities") {
    const params = value["params"];
    return isRecord(params) && typeof params["chatId"] === "string";
  }
  if (value["method"] === "setControls") {
    const params = value["params"];
    return isRecord(params) && typeof params["chatId"] === "string" && isRecord(params["controls"]);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeStaleSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
  }
}

function removeQuietly(socketPath: string): void {
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
