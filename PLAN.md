# PLAN.md

`lark-acp` 的内部设计速览 + 待办路线。和 `CHANGELOG.md` 不同，这里只记录「当下还没做完」或「外部读者需要知道但读 README 看不到」的东西。

---

## 当前架构（Background）

### 模块结构

```
src/
  bridge/         顶层编排：LarkBridge / ChatRuntime
  acp/            ACP 客户端实现：spawn agent、LarkAcpClient (acp.Client)
  interpreter/    入站方向：飞书消息 → ACP ContentBlock[]
  presenter/      出站方向：ACP 状态 → 飞书互动卡片 / post 富文本
  lark/           飞书 SDK 薄封装：HTTP（lark-http）+ WebSocket（lark-ws）
  session-store/  chat → sessionId 持久化（文件）
  logger/         pino 封装
bin/
  lark-acp.ts     CLI 入口
  agents.ts       内置 agent 预设 + 用户配置合并（CLI-only，库不暴露）
  mock-agent.ts   本地端到端调试用的脚本化 ACP agent
```

每个子目录的 `index.ts` 仅 re-export 公开 API；子模块内部直接互相引用具体文件，避免 barrel 链。

命名上，**interpreter** 把外部世界（飞书）"翻译"给 Agent 看，**presenter** 把 Agent 的内部状态"呈现"给外部世界（飞书）；两者在 `LarkBridge` 内部对称地承担入站/出站职责。

### 数据流

```
飞书 WS                     LarkBridge                          Agent (ACP 子进程)
    │                            │                                    │
    │ message_received           │                                    │
    ├───────────────────────────►│                                    │
    │                            │ larkMessageToPrompt()              │
    │                            │ （interpreter，附件转占位文本）     │
    │                            │                                    │
    │                            │ ChatRuntime.enqueue()              │
    │                            │   ├─ 首次：spawnAgent / resume     │
    │                            │   └─ 后续：复用同一 sessionId      │
    │                            │                                    │
    │                            │ connection.prompt(blocks) ────────►│
    │                            │                                    │
    │                            │◄─ sessionUpdate stream ────────────┤
    │                            │   • agent_message_chunk            │
    │                            │   • agent_thought_chunk            │
    │                            │   • tool_call / tool_call_update   │
    │                            │                                    │
    │  patchCard(timeline) ◄─────┤                                    │
    │  （unified card debounce 100ms）                                 │
    │                            │                                    │
    │                            │◄─ requestPermission ───────────────┤
    │  replyCard(permission) ◄───┤                                    │
    │                            │                                    │
    │ card.action.trigger ──────►│                                    │
    │                            │ resolve permission ───────────────►│
    │                            │                                    │
    │                            │◄─ prompt result {stopReason} ──────┤
    │                            │                                    │
    │  patchCard(final) ◄────────┤ finalize(status)                   │
```

### Hermes-style 输出流：post 消息 + Approval 卡片

普通 agent 输出不再使用大 interactive card 作为主载体，而是参考 Hermes Agent：用飞书 `post` 富文本消息展示文本、思考和工具调用；只有需要按钮的场景（例如 `requestPermission` approval）仍使用 interactive card。

`LarkAcpClient` 内部仍维护结构化时间线（`TimelineEntry[]`），每次 ACP 流事件追加 / 更新条目，再 debounce 后渲染/更新为一条飞书 post 消息：

```ts
type TimelineEntry =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId; title; toolKind; status; detail? };
```

- 同类型相邻条目会合并（`appendText` 把连续的 chunk 拼到最后一项）；
- ToolCall 是时间线切分点：出现工具调用前会先结束当前 message segment；工具调用自己作为简洁的一行 post 消息展示，后续工具状态通过 `updatePost` 更新同一条消息；工具之后继续输出文本时开新的 message segment；
- 思考以引用块形式展示，工具调用以 `⏸/⏳/✅/❌ **kind**: title` 的紧凑格式展示，不把大 diff 塞进正文；
- `scheduleFlush()` 用 100ms debounce 合并连续事件，避免高频更新触发限流。`flushing` 标志防止首次创建消息时与 update 竞态。`finalize(status)` 会等待 in-flight flush 完成，再做最后一次 update。

### 中断 / 取消链路

用户通过 `/cancel`、`取消`、`/stop`、`停止` 任意命令消息中断当前 prompt。普通 post 消息无法承载按钮；需要交互按钮的 approval 仍走 card。

```
取消命令 → ChatRuntime.cancel()
            ├─ client.cancelPendingPermission()
            ├─ connection.cancel({ sessionId })
            └─ queue.length = 0
```

Agent 收到 cancel 后 `prompt()` 以 `stopReason: "cancelled"` 返回。Agent 子进程**不会**被杀掉——下次消息直接复用同一 session。`shutdown()` 才会真正杀掉子进程，用在 `/new` / `/restart` 命令、空闲超时、或 Agent 认证失败 / 已死等场景。

### 工具调用授权流程

```
agent.requestPermission(params)
        │
        ▼
LarkAcpClient.requestPermission
  ├─ requestId = uuid()
  ├─ pendingPermissions.set(requestId, { resolve, timer, cardMessageId })
  ├─ 起 permissionTimeoutMs 超时（默认 5 分钟）
  └─ presenter.sendInterruptCard()  → 飞书互动卡片
                                       payload: { r: requestId, o: optionId, c: chatId, ... }

用户点击按钮 → 飞书 card.action.trigger
        │
        ▼
LarkBridge.handleCardAction
  └─ runtime.handleCardAction(requestId, optionId)
       └─ pp.resolve({ outcome: "selected", optionId })  → ACP agent

超时 / 会话结束 / sendInterruptCard 失败：
  └─ pp.resolve({ outcome: "cancelled" })，原卡片 patch 成"已失效"
```

`sendInterruptCard` 失败时**默认 cancel 而非 allow**，避免静默放行。`--permission-mode alwaysAllow` / `alwaysDeny` 会跳过卡片直接自动应答，适合无人值守场景。

### 多会话并发与生命周期

`LarkBridge` 持有 `Map<chatId, ChatRuntime>`：

- **懒创建**：首条消息触发 `acquireRuntime`，调用 `spawnAgent` 或 `spawnAndResumeAgent`；
- **FIFO 串行**：单个 chat 内消息按到达顺序排队，避免同一 session 上并发 prompt；
- **空闲驱逐**：默认 24h 不活跃即 `shutdown()`，回收子进程；
- **总数上限**：默认 10 个并发 chat，达到上限时驱逐 lastActivity 最久的；
- **跨进程恢复**：`SessionStore` 持久化 `chatId → sessionId`，进程重启后下次消息会优先 `unstable_resumeSession` / `loadSession`；都不行才 `newSession`。

### 飞书消息 → ACP ContentBlock

`interpreter/lark-interpreter.ts` 处理飞书消息的所有类型：

| 飞书消息类型                                               | 转换结果                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `text`                                                     | `{ type: "text", text }`；`@mention` 会替换成名字                       |
| `image`                                                    | 描述性文本占位 `[图片 (message_id=..., image_key=...)]`，**不下载字节** |
| `post`                                                     | 富文本展平：内联 `<img>` 替换为图片占位，文本/链接/at 拼回纯文本        |
| `file` / `audio` / `media` / `sticker`                     | 描述性文本占位（带 `file_key`）                                         |
| `share_chat` / `share_user` / `location` / `merge_forward` | 描述性文本占位                                                          |

桥接层不会主动把任何二进制资源塞进 prompt。Agent 如果真的需要图片或文件内容，应通过未来的飞书工具（见下文「飞书工具注入」）凭 `message_id` / `image_key` / `file_key` 自行拉取。

每条消息前会被注入一段上下文文本：

```
[上下文: 群聊 "项目协作群" (oc_xxx) 中用户 张三 (ou_xxx) 的消息]
```

---

## 路线图

### ACP 协议侧补完（高优）

桥接层目前只用了 ACP 的 `initialize` / `newSession` / `loadSession` / `unstable_resumeSession` / `prompt` / `cancel` / `requestPermission`。SDK 已经定义但还没接的能力：

#### Slash command（`AvailableCommandsUpdate`）

ACP agent 可以在 session 启动时（或运行中）通过 `availableCommands_update` 通知客户端它支持哪些斜杠命令（如 Claude Code 的 `/clear`、`/compact`、`/model`）。每个命令带 `name` / `description` / `input` schema。

桥接层目前只识别硬编码的 `/cancel` / `/new`，需要：

- 在 `LarkAcpClient` 里捕获 `availableCommands_update` 事件，按 chatId 维护当前可用命令列表；
- 把 agent 暴露的命令转成飞书侧入口——候选方案：
  - 在 unified card 顶部 / 底部加一组按钮，点击后桥接层把命令名拼成 prompt 发给 agent；
  - 用户输入 `/foo` 时，先匹配桥接层硬编码命令，再回退到 agent 的 availableCommands；
  - `lark-acp commands` 子命令在终端列出当前 chat 可用的斜杠命令（调试用）。
- 对带 `input` schema 的命令（要参数），考虑用飞书互动卡片的 input 元素收集再提交。

#### Session list（`session/list`）

`SessionListCapabilities` / `ListSessionsRequest` 让客户端能列出 agent 端持久化的 session。可以实现 `/sessions` 命令在飞书里展示当前 chat 历史 sessions、点击切换。

需要：

- 在 `acquireRuntime` / 启动时探测 `agentCapabilities.session.list` 是否为 true；
- 加 `/sessions` 命令处理，调用 `connection.listSessions()`，把返回结果渲染成卡片列表；
- 卡片上每项一个按钮："切换到这个 session"——按下后 `loadSession` 替换当前 `ChatRuntime` 的 sessionId，并把 `SessionStore` 里的 mapping 也改掉。

#### Session mode（`SetSessionModeRequest` / `SessionModeState`）

ACP 的 session mode 是 agent 自定义的运行档位（如 Claude Code 的 `default` / `acceptEdits` / `bypassPermissions` / `plan`）。Agent 在 session 启动 / 运行中通过 `current_mode_update` 通知 mode，客户端可以通过 `session/setMode` 切换。

需要：

- 在 `LarkAcpClient` 监听 `current_mode_update`，把当前 mode + 可选 modes 列表挂到 runtime state；
- 卡片头部或底部展示当前 mode（小 tag），并提供切换入口（按钮 / 选择器）；
- 卡片按钮 callback 触发 `connection.setSessionMode({ sessionId, modeId })`。
- 这个能力和「permission mode」语义有重叠——前者是 agent 内部档位，后者是桥接层对 `requestPermission` 的兜底策略。两者互不替代，UI 上要分清。

#### Session fork（`session/fork`）

让用户从某条历史 prompt 分支出新 session（"从这里开始重写"）。优先级低于上面三项。

#### Model 切换（`SetSessionModelRequest`）

Agent 在 session state 里可能暴露多个可选模型（`SessionModelState`）。可以加 `/model` 命令或卡片里的模型选择器。优先级低。

### 飞书工具注入（高优）

桥接层是**单向**的——飞书消息 → ACP prompt，Agent 输出 → 飞书卡片。Agent 无法主动**调用**飞书的能力（发选项卡让用户选、下载用户上传的文件、给指定群发消息、查群成员等）。

下一步要把这些能力作为 **ACP 工具**暴露给 Agent，让 Agent 能在自己的工具调用循环中直接驱动飞书。

#### 方案方向

ACP 的 `newSession` / `loadSession` / `unstable_resumeSession` 都接受 `mcpServers` 参数。最自然的实现是把桥接层自己跑成一个本地 MCP server，把它的 stdio / unix socket 地址塞进 `mcpServers`：

```ts
connection.newSession({
  cwd,
  mcpServers: [
    { name: "lark", command: "node", args: ["./mcp-lark-server.js"], env: {...} },
    // 或 { name: "lark", url: "http://127.0.0.1:xxx/sse" } 走 SSE transport
  ],
});
```

这样 Agent 端**不需要任何改动**——它通过自己原生的 MCP 客户端发现并调用工具，调用结果再以工具调用的形式回到 ACP 流里，桥接层照常渲染到 unified card。

#### 候选工具清单

按优先级粗分：

**用户交互（高优）**

- `lark.askChoice(question, options[])` —— 发互动卡片让用户从选项中选一个，Agent 阻塞等待结果；
- `lark.askText(question)` —— 提示用户在当前 chat 回复一条文本，桥接层捕获下一条用户消息作为返回；
- `lark.sendCard(card)` —— Agent 自己构造卡片 JSON 直接发送（advanced，需要约束 schema）。

**资源访问（高优）**

- `lark.downloadMessageFile(messageId, fileKey)` —— 复用已有的 `messageResource.get`，扩展支持 `type: "file"` / `"audio"` 等；
- `lark.downloadMessageImage(messageId, imageKey)` —— 桥接层已实现，包一层暴露给 Agent；
- `lark.listChatHistory(chatId, limit)` —— 拉取最近 N 条消息（需要权限 `im:message:readonly`）。

**主动外发（中优）**

- `lark.sendMessage(chatId, content)` —— Agent 主动给某个群/用户发消息（不在当前 prompt 上下文中）；
- `lark.uploadImage(bytes)` —— 上传图片拿到 `image_key`，配合 `sendMessage` 发图。

**元信息（低优）**

- `lark.getUserInfo(openId)` / `lark.getChatInfo(chatId)` / `lark.listChatMembers(chatId)` —— 复用 `lark-http.ts` 的缓存层。

#### 待解决的设计问题

- **阻塞 vs. 异步**：MCP 工具调用是同步的（agent 等待返回），但飞书侧的用户操作是异步事件回调。需要在 MCP server 端做 promise bridge，与现有 `pendingPermissions` 模式同构。
- **权限边界**：`sendMessage` 给任意 chat 发消息是高风险能力，是否需要白名单 / 配置开关 / 卡片确认？至少要有 `enabledTools: string[]` 或 `tools.allow` / `tools.deny` 的配置项。
- **飞书 API 限频**：Agent 可能会高频调用，需要在 MCP server 层加 rate limit，避免触发飞书的接口风控。
- **Agent 兼容性**：不是所有 ACP agent 都启用了 MCP 客户端能力。要在 `initialize` 后检查 `agentCapabilities` 决定是否注入工具。

### 工程化

- **测试**：尚无 unit / integration test；计划用 `vitest`，与被测代码同目录、`<module>.test.ts` 命名；E2E 用 mock agent + 假 Lark HTTP server。
- **API 文档完整度**：JSDoc / `@throws` 注释参差，需要补齐到 1.0 之前。
- **结构化错误类型**：目前大量地方抛 `new Error(...)`；按 CLAUDE.md 第 12 节，需要拆成带 `kind` 的子类（`AgentSpawnError` / `LarkApiError` / `SessionResumeError` 等）。
