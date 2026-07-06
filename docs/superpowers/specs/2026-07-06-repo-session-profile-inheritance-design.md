# Repo-scoped 最近 Session Profile 继承 — 设计文档

- 日期：2026-07-06
- 状态：已实现；2026-07-06 补充 topic-level Agent switch 与 capabilities probe
- 取代：Per-Agent `defaultControls` 设计
- 涉及范围：`src/binding-store/*`、`src/session-store/*`、`src/bridge/bridge.ts`、`src/bridge/chat-runtime.ts`、`bin/humming.ts`、`src/interpreter/lark-interpreter.ts`、`templates/home/AGENTS.md` / `CLAUDE.md`

## 1. 背景与决策

Humming 的实际工作模型是：

```text
一个 Feishu/Lark chat 绑定一个 repo；
一个 chat/repo 下会有很多 topic；
每个 topic 对应一个 ACP session；
每个 session 可以有自己的 Agent + Model + Mode + Permission + Config controls。
```

旧设计想在 `settings.json` 的 `agents.<id>.defaultControls` 里配置静态默认值。这个方向不做了。

新的决策是：

> 新建 topic / 新建 session 时，优先从当前 chat + repo 下最近一个 session 克隆完整 session profile。

这里的 session profile 包含：

- Agent invocation
  - `agentCommand`
  - `agentArgs`
  - `agentEnv`
  - `agentLabel`
- Controls
  - `modelId`
  - `modeId`
  - `bridgePermissionMode`
  - `config`

不克隆对话历史、不克隆 agent 内部 session 上下文。

## 2. 分层模型

### 2.1 Global 层

Global 只提供 cold-start fallback：

```text
runtime.agent / CLI default agent
runtime.permissionMode
```

其中：

- `defaultAgent`：当 repo 下没有任何可继承 session profile 时，用它创建第一个 session。
- `runtime.permissionMode`：当 session 没有自己的 permission control 时的最终 fallback。

### 2.2 Chat binding 层

Chat binding 只绑定 repo，不绑定 agent：

```jsonc
{
  "bindings": {
    "<chat-id>": {
      "cwd": "/absolute/path/to/repo",
    },
  },
}
```

不再把 agent 写入 `bindings`。

`/bind` 的语义也改为：

```text
/bind <repo>
```

即：只把当前 chat 绑定到 repo。

如果没有任何 session profile 可继承，新 session 使用 global default agent。

> 不考虑向后兼容；旧的 `/bind <repo> <agent>` 和 `bindings.<chat>.agent` 可以直接移除/拒绝/忽略。

### 2.3 Session / topic 层

Session 是实际运行 profile 的所有者：

```ts
SessionRecord {
  chatId: string;
  threadId: string | null;
  sessionId: string;
  cwd: string;

  agentCommand: string;
  agentArgs: string[];
  agentEnv?: Record<string, string>;
  agentLabel?: string;

  controls?: {
    modelId?: string;
    modeId?: string;
    bridgePermissionMode?: "alwaysAsk" | "alwaysAllow" | "alwaysDeny";
    config?: Record<string, SessionConfigControlValue>;
  };
}
```

Agent、Model、Mode、Permission、Config controls 都是同一个层级的 session metadata。

## 3. 新 session profile 选择规则

当收到一条消息，需要为 `(chatId, threadId)` 获取 runtime 时：

### 3.1 当前 topic 已有 session record

```text
resume 当前 topic 自己的 session record
```

使用该 record 的：

- `sessionId`
- `agentCommand` / `agentArgs` / `agentEnv` / `agentLabel`
- `controls`

### 3.2 当前 topic 没有 session record，但当前 chat/repo 下有历史 session

```text
从同 chat + 同 cwd/repo 的最近一个 session 克隆 profile
```

克隆：

- Agent invocation
- controls

不克隆：

- `sessionId`
- 对话历史
- agent 内部上下文
- tool history

然后创建一个新的 ACP session。

### 3.3 当前 chat/repo 下没有历史 session

```text
使用 global default agent 创建新 session
```

controls 为空；`bridgePermissionMode` 走 `runtime.permissionMode` fallback。

### 3.4 当前绑定 repo 不存在

已有行为保持：

```text
发 warning card，然后自动 rebind 到 ~/.humming，后续消息不重复 warning。
```

rebind 后的 `~/.humming` 也成为普通 repo scope；之后新 topic 会从 `~/.humming` 下最近 session profile 继承。

## 4. “最近 session”的定义

候选 session 必须满足：

```text
chatId 相同
cwd 相同（path.resolve 后相同）
不是当前 thread 的已存在 session（如果当前 thread 已有 session，应走 resume 分支）
agentCommand 非空
```

排序：

```text
updatedAt desc
```

如果未来需要更贴近 agent 活跃时间，可以改为：

```text
max(updatedAt, Date.parse(sessionUpdatedAt ?? ""), createdAt)
```

第一版使用 `updatedAt` 即可，因为 controls 更新、session persist 都会更新它。

注意：**不按 agent 过滤**。因为 Agent 本身就是要被继承的 profile 字段。

## 5. Controls 继承与非法项处理

从最近 session 克隆来的 controls 不应该硬失败。

原因：agent 可能升级，历史 `modelId` / `modeId` / `config` 可能已经失效。

处理方式：

1. 先启动继承来的 Agent。
2. 从 `session/new` 的 capabilities 得到可用 models/modes/configOptions。
3. 对 inherited controls 做分拣：
   - 合法项 → apply
   - 非法项 → ignore + 收集 warning
4. session 正常启动。
5. 如果有 ignored controls，发 orange warning card。
6. 把实际成功应用的 controls 持久化到新 session record。

warning 文案示例：

```text
⚠️ 部分继承的 session 设置无效，已忽略
• Model gpt-5-codex：不在当前 agent 的 availableModels 中
• Config approval_mode：configId 不存在
其余继承设置已正常应用。
```

手动 `sessions set-control` 的语义不变：非法即硬失败、runtime/store 不污染。

## 6. Agent 切换语义

Agent 是 session profile 的一部分。

在一个 topic 内切换 Agent 时，语义是：

```text
Agent switch is a session boundary.
```

也就是说：

- 切换 Agent 会创建新的 ACP session。
- 旧 Agent 的内部对话历史不会自动迁移到新 Agent。
- Humming 会替换当前 topic 的旧 session binding；旧 Agent 自己的 session 数据仍留在该 Agent 的私有存储中，但当前 topic 不再 resume 它。
- 自动继承/克隆只复制工作 profile，不复制 conversation history。

实现命令：

```bash
humming sessions set-agent --chat-id "$HUMMING_CHAT_ID" --thread-id "$HUMMING_THREAD_ID" --agent copilot
```

实现细节：

1. 当前 topic runtime 若正在运行，先 supersede/shutdown，并从 runtime map 删除。
2. 清掉当前 `(chatId, threadId)` 的旧 session records。
3. 写入一个 `profileOnly: true` 的 `SessionRecord`，只保存新 Agent invocation + repo，不保存旧 controls。
4. 下条消息 acquire runtime 时看到 `profileOnly` record，会使用该 record 的 Agent，但不会 resume 这个 pseudo `sessionId`，而是创建全新的 ACP session。
5. 新 session 创建成功后，真实 session record 会替换 profile-only record。

通知要求：

- 成功发送 `Agent 已切换` notice。
- 展示 Agent / Repo / Mode / Model / Permission / Controls before/after。
- 明确提示旧 Agent 内部历史不会自动迁移。
- 不显示完整 session/chat/thread/app id。

旧 controls 不跨 Agent 自动复制：Model / Mode / Config id 是 agent-specific，Claude 的 `opus` / `default` / `acceptEdits` 等不能直接套到 Copilot/Codex。切换后需要按新 Agent 的 capabilities 再设置 controls。

## 6.1 指定 Agent capabilities probe

新增命令用于在不改变当前 topic 的情况下查询某个 Agent 的真实 model/mode/config capabilities：

```bash
humming control agent-capabilities --chat-id "$HUMMING_CHAT_ID" --thread-id "$HUMMING_THREAD_ID" --agent copilot --json
```

语义：

- 按 `--agent`、当前 chat binding / `--cwd` / runtime cwd 解析目标 Agent 与 cwd。
- 启动一个短暂 Agent 进程。
- 创建 throwaway ACP session，读取 `session/new` 返回的 capabilities。
- 立即停止 Agent 进程。
- 不修改 `sessions.json`，不替换当前 topic runtime。

这个命令解决“当前 topic 仍在 Claude session 上，但用户想看 Copilot 可用 model/mode/config”的问题；`humming control capabilities` 仍然只查询当前 live runtime。

这是因为：

- ACP 没有标准 API 表示“把 Agent A 的完整 conversation history 转给 Agent B”。
- 各 Agent 的 session state 格式不同。
- Humming 当前不是完整 transcript store。

## 7. 可选增强：Agent switch handoff summary

可以在 topic-level Agent switch 中支持显式 handoff：

```text
switch agent with summary handoff
```

流程：

1. 切换前，向旧 Agent 发送一个总结 prompt，例如：
   ```text
   请总结当前 session 到目前为止完成了什么、关键决策、当前状态、未完成事项。
   这份总结会交给另一个 agent 继续工作。
   ```
2. 将 summary 保存到 Humming 管理的文件中，例如：
   ```text
   ~/.humming/handoffs/<chatId>/<threadId>/<timestamp>-<oldAgent>-to-<newAgent>.md
   ```
3. 停掉旧 runtime，创建新 Agent session。
4. 自动向新 Agent 发送一条 handoff prompt：
   ```text
   这个 session 刚刚从 <oldAgent> 迁移到你这里。
   下面是旧 Agent 对前序工作的总结：

   <summary>
   ```
5. 新 Agent 从 summary 继续，而不是从旧 Agent 的完整内部历史继续。

第一版可以不实现 handoff summary，只实现 profile inheritance；但 Agent switch 的 UX 文案必须明确：不带 handoff 时历史不会迁移。

## 8. 代码改动点

### 8.1 Binding model

`ChatBinding` 改为 repo-only：

```ts
export interface ChatBinding {
  readonly chatId: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

`SettingsBindingStore`：

- `StoredBinding` 只保留 `cwd`。
- `set()` 只写 `{ cwd }`。
- `hydrate()` 不再 resolve agent。
- 可以移除 `BindingAgentResolver`。

### 8.2 `/bind` command

`LarkCommand.bind` 改为：

```ts
{
  kind: "bind";
  cwd: string;
}
```

`detectBindCommand()`：

- `/bind` → usage
- `/bind <repo>` → bind
- `/bind <repo> <anything>` → 第一版建议报 usage/warning：`/bind` no longer accepts agent; Agent belongs to session profile.

### 8.3 Bridge profile resolution

`resolveBinding(chatId)` 只解析 repo cwd，不解析 agent。

`acquireRuntime(chatId, threadId, binding)`：

1. 查询当前 thread 的 pinned session。
2. 如果有 pinned：用 pinned 的 agent + controls resume。
3. 如果没有 pinned：查同 chat + cwd 最近 session profile。
4. 如果有 recent：用 recent 的 agent + controls 创建新 session。
5. 如果没有 recent：用 global defaultAgent 创建新 session。

### 8.4 SessionStore helper

新增方法或 bridge 内部 helper：

```ts
findRecentProfileByRepo(chatId, cwd, excludeThreadId): Promise<SessionRecord | null>
```

可以先用 `listByChat(chatId)` 实现，不一定要加到 interface。

### 8.5 ChatRuntime inherited controls

`ChatRuntimeOptions` 新增：

```ts
inheritedControls?: SessionControls
```

`bootstrap()`：

- `latest.controls`：resume 分支，保持现状。
- `inheritedControls`：new session 分支，filter/apply/persist，非法项 warning。
- `bridgePermissionMode` 初始值：
  ```ts
  latest?.controls?.bridgePermissionMode ??
    inheritedControls?.bridgePermissionMode ??
    this.opts.permissionMode;
  ```

## 9. 测试计划

### Binding tests

- `/bind <repo>` 只写 repo，不写 agent。
- `/where` 显示 repo binding；Agent 来源显示为 cold-start default 或另行说明，不再作为 binding 字段。
- 旧 `/bind <repo> <agent>` 不再作为 chat-level agent bind。

### Session profile inheritance tests

- 当前 thread 有 session → resume 自己，不 clone 最近 session。
- 当前 thread 无 session，同 chat+repo 有最近 Claude session → 新 topic 用 Claude。
- 最近 session 是 Codex → 新 topic 用 Codex。
- recent controls 合法 → model/mode/config/permission 被 apply 并 persist 到新 session。
- recent controls 部分非法 → 合法项 apply，非法项 warning，不阻塞启动。
- repo 下没有 session → 使用 global defaultAgent。

### Agent switch tests

- topic-level switch agent 创建新 session boundary。
- 不带 handoff 时不迁移历史，发明确提示。
- `profileOnly` record 不会被 resume；下一条消息创建真实 ACP session 后替换它。
- 旧 Agent controls 不污染新 Agent profile。
- notice 不显示完整 session/chat/thread id。
- 指定 Agent capabilities probe 不修改当前 topic runtime / sessions。

### Agent switch tests（后续）

- 带 handoff 时生成 summary 文件并把 summary prompt 发送给新 Agent。

## 10. 用户可见语义总结

```text
/bind 只绑定 repo。
Agent/Model/Mode/Permission/Controls 属于 session profile。
新 topic 默认继承当前 repo 最近 session 的 profile。
如果 repo 里还没有 session，则使用全局默认 Agent。
切换 Agent 不会自动迁移历史；可选 handoff summary 后续支持。
查指定 Agent 能力用 agent-capabilities probe；查当前 session 能力用 capabilities。
```
