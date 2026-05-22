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

### Unified Card：一张卡片承载整轮对话

为避免每次 thought / text / tool 切换都新发一张卡片刷屏，桥接层在 `LarkAcpClient` 内部维护一条**结构化时间线**（`TimelineEntry[]`），每次 ACP 流事件追加 / 更新条目，再 debounce 后整体渲染成一张飞书互动卡片：

```ts
type TimelineEntry =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId; title; toolKind; status; detail? };
```

- 同类型相邻条目会合并（`appendText` 把连续的 chunk 拼到最后一项）；
- 工具条目通过 `toolCallId → index` 索引表 O(1) 查找更新（`tool_call_update` 事件）；
- 渲染时连续条目用 `hr` 分隔，思考用 markdown 引用块（`> `）与正文区分；
- 卡片头部 `STATUS_HEADER` 实时反映 Agent 状态：`thinking` / `calling_tool` / `responding` / `complete` / `cancelled` / `failed`；
- 运行中卡片底部带"中断当前任务"按钮；finalize 时按钮消失、头部变为终态色。

`scheduleFlush()` 用 100ms 的 debounce 合并连续事件，避免高频 `patchCard` 触发限流。`flushing` 标志防止首次创建卡片时与 patch 竞态。`finalize(status)` 会等待 in-flight flush 完成，再做最后一次 patch。

### 中断 / 取消链路

用户有两种方式中断当前 prompt：

1. `/cancel`、`取消`、`/stop`、`停止` 任意命令消息；
2. 点击运行中卡片底部的"中断当前任务"按钮。

两条路径最终都进入 `ChatRuntime.cancel()`：

```
按钮点击 → bridge.handleCardAction
              └─ value.cancel === true → handleCancelButton(chatId)
                                          └─ runtime.cancel()
                                              ├─ client.cancelPendingPermission()
                                              ├─ connection.cancel({ sessionId })
                                              └─ queue.length = 0
```

Agent 收到 cancel 后 `prompt()` 以 `stopReason: "cancelled"` 返回，`finalize("cancelled")` 把卡片头改成 "⛔ 已取消"。Agent 子进程**不会**被杀掉——下次消息直接复用同一 session。`shutdown()` 才会真正杀掉子进程，用在 `/new` / `/restart` 命令、空闲超时、或 Agent 认证失败 / 已死等场景。

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

`sendInterruptCard` 失败时**默认 cancel 而非 allow**，避免静默放行。

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

桥接层不会主动把任何二进制资源塞进 prompt。Agent 如果真的需要图片或文件内容，应通过未来的飞书工具（见下文「飞书工具注入」）凭 `message_id` / `image_key` / `file_key` 自行拉取。这样可以避免给小模型塞过大的 base64 上下文，也让授权和限频留给 Agent 自己控制。

每条消息前会被注入一段上下文文本：

```
[上下文: 群聊 "项目协作群" (oc_xxx) 中用户 张三 (ou_xxx) 的消息]
```

### Agent 输出 → 飞书 post 富文本

仅用于系统通知（取消提示、Agent 错误）的 `replyText` 走 `presenter/lark-markdown.ts`：

- `marked@18` 解析 markdown AST；
- 标题 → 加粗段落；段落 → 内联文本/链接/样式；
- 代码块 → `code_block`（语言走白名单 + 别名映射，非白名单语言 fallback 无 language）；
- 列表 / 引用 → 飞书 `md` 标签（飞书 post 中唯一原生支持列表/引用的元素）；
- 表格 → 列宽对齐的 `code_block`（`md` 标签不支持表格）；
- 长消息按 `\n\`\`\`\n`/`\n\n`/`\n`边界拆分到`MAX_MARKDOWN_CHUNK = 4000` 以下；
- 行内代码 → 用反引号包裹的纯文本（post 没有 inline-code 元素）；
- 图片 → 退化为可点击链接（post 的 `img` 需要 `image_key`，agent 发的 URL 没法直接用）。

Agent 的主输出**不**走 `replyText`——它进入 unified card 的时间线，由 `presenter/lark-presenter.ts` 渲染成卡片的 `markdown` 元素。

---

## 路线图

### 飞书工具注入（高优 / 进行中）

目前桥接层是**单向**的——飞书消息 → ACP prompt，Agent 输出 → 飞书卡片。Agent 无法主动**调用**飞书的能力（发选项卡让用户选、下载用户上传的文件、给指定群发消息、查群成员等）。

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

另一种更轻量的方向：复用 `LarkAcpClient` 已有的 `requestPermission` 通道——把"发选项卡让用户选"伪装成一个授权请求。这条路不需要 MCP server，但语义不太对（授权 ≠ 业务问答），先不优先。

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

- **工具调用与 unified card 的关系**：Agent 调用 `lark.askChoice` 时，问答卡片应该是另发一张消息，还是嵌进当前 unified card？嵌进去会让"取消"按钮的语义变模糊；另发一张又会破坏"一轮对话一张卡片"的设计。倾向另发，但需要在 unified card 里留一条 `tool: lark.askChoice` 时间线条目作为索引。
- **阻塞 vs. 异步**：MCP 工具调用是同步的（agent 等待返回），但飞书侧的用户操作是异步事件回调。需要在 MCP server 端做 promise bridge，与现有 `pendingPermissions` 模式同构。
- **权限边界**：`sendMessage` 给任意 chat 发消息是高风险能力，是否需要白名单 / 配置开关 / 卡片确认？至少要有 `enabledTools: string[]` 或 `tools.allow` / `tools.deny` 的配置项。
- **飞书 API 限频**：Agent 可能会高频调用，需要在 MCP server 层加 rate limit，避免触发飞书的接口风控。
- **Agent 兼容性**：不是所有 ACP agent 都启用了 MCP 客户端能力。要在 `initialize` 后检查 `agentCapabilities` 决定是否注入工具。

### 其他待办

- **测试**：尚无 unit / integration test；计划用 `vitest`。
- **API 文档完整度**：JSDoc / `@throws` 注释参差，需要补齐到 1.0 之前。
