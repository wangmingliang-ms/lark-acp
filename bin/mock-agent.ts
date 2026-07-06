#!/usr/bin/env node
/**
 * `lark-acp-mock` — minimal ACP agent that always returns the same scripted
 * turn. Useful for end-to-end testing the Lark <-> ACP bridge UI without
 * spending real model tokens.
 *
 * The scripted turn covers every surface the bridge is expected to render:
 *
 *   1. an `agent_thought_chunk` (思考) so the presenter exercises the
 *      thought timeline branch.
 *   2. a `tool_call` + `tool_call_update` pair (工具调用) that completes
 *      without permission gating.
 *   3. a `requestPermission` call (权限许可) that blocks until the user
 *      picks an option in the Lark interrupt card.
 *   4. one or more `agent_message_chunk` payloads carrying a fully-formed
 *      markdown document — headings, lists, fenced code, tables, links —
 *      so `lark-markdown.ts` is hit on every block kind.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const MOCK_TURN_DELAY_MS = 400;
const PROTOCOL_LOG_PREFIX = "[mock-agent]";

const SESSION_ID_BYTE_LEN = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;

const PERMISSION_OPTION_ALLOW = "allow";
const PERMISSION_OPTION_REJECT = "reject";

const TOOL_CALL_READ_ID = "mock_tool_read";
const TOOL_CALL_EDIT_ID = "mock_tool_edit";

const MOCK_THOUGHT = [
  "用户想看一个完整的 mock 输出，那我应该依次发送：",
  "1) 一段思考；",
  "2) 一次无需许可的工具调用；",
  "3) 一次需要许可的工具调用；",
  "4) 一段带完整 Markdown 元素的回答。",
].join("\n");

const MOCK_FILE_PATH = "/mock/project/README.md";
const MOCK_CONFIG_PATH = "/mock/project/config.json";
const MOCK_LIST_SESSION_ID = "mock_existing_session";
const MOCK_LIST_SESSION_TITLE = "Mock existing desktop task";

const MOCK_MARKDOWN_INTRO = "好的，下面是一段固定的 mock 答复：\n\n";

const MOCK_MARKDOWN_BODY = `# Mock Agent 回答示例

这是一个 **固定输出** 的 mock agent，用于演示 Lark 端的渲染效果。它会依次触发：

- 思考（\`agent_thought_chunk\`）
- 工具调用（\`tool_call\` / \`tool_call_update\`）
- 权限许可（\`session/request_permission\`）
- Markdown 富文本回答（\`agent_message_chunk\`）

## 列表

1. 一级列表项 *斜体*
2. 一级列表项 **粗体**
   - 嵌套项目 \`inline code\`
   - 嵌套项目 ~~删除线~~
3. 链接示例：[ACP](https://agentcommunicationprotocol.dev)

## 代码

\`\`\`ts
export function greet(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

## 表格

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| sessionUpdate | 事件类型 | agent_message_chunk |
| toolCallId | 工具调用 ID | mock_tool_read |
| status | 工具状态 | completed |

> 这是一段引用，用来演示 blockquote 渲染。

---

回答结束。`;

interface SessionState {
  pendingPrompt: AbortController | null;
}

class MockAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection;
  private readonly sessions = new Map<string, SessionState>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomSessionId();
    this.sessions.set(sessionId, { pendingPrompt: null });
    return { sessionId };
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = params.cwd ?? process.cwd();
    return {
      sessions: [
        {
          sessionId: MOCK_LIST_SESSION_ID,
          title: MOCK_LIST_SESSION_TITLE,
          cwd,
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      ],
    };
  }

  async unstable_resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    this.sessions.set(params.sessionId, { pendingPrompt: null });
    return {};
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async setSessionMode(
    _params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse | void> {
    return {};
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    const controller = new AbortController();
    session.pendingPrompt = controller;

    try {
      await this.runScriptedTurn(params.sessionId, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    } finally {
      if (session.pendingPrompt === controller) {
        session.pendingPrompt = null;
      }
    }

    return { stopReason: "end_turn" };
  }

  private async runScriptedTurn(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.emitThought(sessionId, MOCK_THOUGHT);
    await sleep(MOCK_TURN_DELAY_MS, signal);

    await this.emitToolCall(sessionId, {
      toolCallId: TOOL_CALL_READ_ID,
      title: "Reading mock README",
      kind: "read",
      path: MOCK_FILE_PATH,
      rawInput: { path: MOCK_FILE_PATH },
    });
    await sleep(MOCK_TURN_DELAY_MS, signal);
    await this.completeToolCall(sessionId, {
      toolCallId: TOOL_CALL_READ_ID,
      title: "Reading mock README",
      kind: "read",
      output: "# Mock Project\n\nThis is a mocked README content.",
    });

    await this.emitMessage(sessionId, "我先看了一下项目说明，接下来需要修改一个配置文件。\n\n");
    await sleep(MOCK_TURN_DELAY_MS, signal);

    await this.emitToolCall(sessionId, {
      toolCallId: TOOL_CALL_EDIT_ID,
      title: "Modifying mock config",
      kind: "edit",
      path: MOCK_CONFIG_PATH,
      rawInput: { path: MOCK_CONFIG_PATH, content: '{"mocked": true}' },
    });

    const decision = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: TOOL_CALL_EDIT_ID,
        title: "Modifying mock config",
        kind: "edit",
        status: "pending",
        locations: [{ path: MOCK_CONFIG_PATH }],
        rawInput: { path: MOCK_CONFIG_PATH, content: '{"mocked": true}' },
      },
      options: [
        { kind: "allow_once", name: "允许这次修改", optionId: PERMISSION_OPTION_ALLOW },
        { kind: "reject_once", name: "跳过这次修改", optionId: PERMISSION_OPTION_REJECT },
      ],
    });

    if (decision.outcome.outcome === "cancelled") {
      return;
    }

    if (decision.outcome.optionId === PERMISSION_OPTION_ALLOW) {
      await this.completeToolCall(sessionId, {
        toolCallId: TOOL_CALL_EDIT_ID,
        title: "Modifying mock config",
        kind: "edit",
        output: '{"mocked": true, "applied": true}',
      });
      await sleep(MOCK_TURN_DELAY_MS, signal);
      await this.emitMessage(sessionId, MOCK_MARKDOWN_INTRO);
      await this.emitMessage(sessionId, MOCK_MARKDOWN_BODY);
      return;
    }

    await this.failToolCall(sessionId, {
      toolCallId: TOOL_CALL_EDIT_ID,
      title: "Modifying mock config",
      kind: "edit",
    });
    await sleep(MOCK_TURN_DELAY_MS, signal);
    await this.emitMessage(
      sessionId,
      "好的，已跳过这次修改。如果需要重新尝试，请再次发送消息触发 mock turn。",
    );
  }

  private async emitThought(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async emitMessage(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async emitToolCall(
    sessionId: string,
    args: {
      toolCallId: string;
      title: string;
      kind: acp.ToolKind;
      path: string;
      rawInput: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "pending",
        locations: [{ path: args.path }],
        rawInput: args.rawInput,
      },
    });
  }

  private async completeToolCall(
    sessionId: string,
    args: { toolCallId: string; title: string; kind: acp.ToolKind; output: string },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: args.output },
          },
        ],
        rawOutput: { content: args.output },
      },
    });
  }

  private async failToolCall(
    sessionId: string,
    args: { toolCallId: string; title: string; kind: acp.ToolKind },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "failed",
        rawOutput: { error: "rejected by user" },
      },
    });
  }
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTE_LEN));
  return Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_PAD, "0")).join("");
}

/**
 * Resolve after `ms` milliseconds, or reject early when `signal` aborts.
 *
 * @throws when `signal` aborts before the timer fires.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function main(): void {
  // ACP 通过 stdio 通信：客户端写入到 agent 的 stdin，agent 把响应写到 stdout。
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new MockAgent(conn), stream);
  process.stderr.write(`${PROTOCOL_LOG_PREFIX} ready\n`);
}

main();
