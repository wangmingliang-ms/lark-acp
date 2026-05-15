/**
 * Spawn and kill ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export interface SpawnAgentOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  log: (msg: string) => void;
}

export async function spawnAgent(opts: SpawnAgentOpts): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log } = opts;

  log(`Spawning agent: ${command} ${args.join(" ")}`);

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32", // npx/npm not on PATH without shell on Windows
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(`[agent stderr] ${line}`);
  });

  // Wrap Node streams into Web streams for the ACP SDK
  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize protocol
  let initResult: Awaited<ReturnType<typeof connection.initialize>>;
  try {
    initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  } catch (err) {
    throw new Error(`Failed to initialize agent (${command} ${args.join(" ")}). Is the agent installed?\n${err instanceof Error ? err.message : err}`);
  }

  // Authenticate if the agent advertises any auth methods.
  // For cloud/hosted agents this is required before newSession() and prompt().
  if (initResult.authMethods && initResult.authMethods.length > 0) {
    const method = initResult.authMethods[0];
    log(`Agent requires authentication (method: ${method.id} / ${method.name}), authenticating...`);
    try {
      await connection.authenticate({ methodId: method.id });
    } catch (err) {
      throw new Error(`Agent authentication failed during setup. Ensure the agent CLI is logged in before starting lark-acp.\n${err instanceof Error ? err.message : err}`);
    }
    log(`Authentication complete`);
  }

  // Create a session
  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await connection.newSession({ cwd, mcpServers: [] });
  } catch (err) {
    throw new Error(`Failed to create agent session.\n${err instanceof Error ? err.message : err}`);
  }
  log(`Agent initialized, session: ${sessionResult.sessionId}`);

  return { process: proc, connection, sessionId: sessionResult.sessionId };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
