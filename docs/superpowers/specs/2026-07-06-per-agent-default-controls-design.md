# Per-Agent 默认 Session Controls — 设计文档

- 日期：2026-07-06
- 状态：待评审
- 涉及范围：`bin/agents.ts`、`bin/lark-acp.ts`、`src/bridge/bridge.ts`、`src/bridge/chat-runtime.ts`、`~/.lark-acp/AGENTS.md` / `CLAUDE.md`

## 1. 背景

lark-acp 是一个飞书（Lark）↔ ACP 桥接程序：一个机器人服务多个飞书群，每个群通过
`bindings` 绑定到一个仓库目录 + 一个 coding agent（`claude` / `codex` / `copilot` 等）。

每个 ACP session 都带有一组「controls」：

- `modelId` — ACP `session/set_model`
- `modeId` — ACP `session/set_mode`
- `config` — ACP `session/set_config_option`（每个 agent 暴露的 boolean/select 开关）
- `bridgePermissionMode` — lark-acp 客户端侧的审批策略（`alwaysAsk` / `alwaysAllow` /
  `alwaysDeny`），**非 ACP 原生字段**

今天这些 controls 只能通过 `lark-acp sessions set-control` **手动**设置，并持久化到
`sessions.json` 的 `SessionRecord.controls`。缺失的能力是：**新建 session 时按 agent 自动套用
一组默认 controls**。

目前唯一的「默认权限」是全局的 `runtime.permissionMode`（`bin/lark-acp.ts:245`），它对所有
agent、所有群一视同仁；`model` / `mode` / `config` 则完全没有任何默认值。

### 关键技术约束

`modelId` / `modeId` / `config` 的可选值 **每个 agent 各不相同**，且只有在 agent 子进程启动、
返回 `session/new` 响应之后才能从 `SessionCapabilitiesSnapshot`（`models` / `modes` /
`configOptions`）得知。因此默认值 **必须按 agent 分开配置**，无法用一组通配值。

## 2. 目标与非目标

### 目标

1. 在 `settings.json` 的 `agents.<id>` 块下，为每个 agent 配置一组默认 controls。
2. 新建 / 重建 session 时，自动套用「当前 agent」的默认 controls。
3. 切换 agent 时，默认 controls 相应更新（套用新 agent 的默认值）。
4. 用户手动设置过的 controls 优先于默认值。
5. 默认值非法时降级放行（session 照常启动）并在飞书群发 warning 卡片。

### 非目标

- **不** 新增用于编辑默认值的 CLI 命令。用户直接改 `settings.json`（手改，或让 agent 改），
  依赖既有的 settings.json 热重载生效。
- **不** 改变既有 `sessions set-control` 手动通道的行为（含其「非法即硬失败」的语义）。
- **不** 为默认值引入跨 agent 的通配 / 归一化机制。

## 3. 配置结构

在既有的 `agents.<id>` 块下新增一个可选字段 `defaultControls`，其结构与 `sessions.json` 的
`SessionRecord.controls`（即 `SessionControls`）**完全一致**：

```jsonc
{
  "agents": {
    "claude": {
      "defaultControls": {
        "modelId": "claude-sonnet-4-5",
        "modeId": "default",
        "bridgePermissionMode": "alwaysAsk",
        "config": { "someToggle": { "type": "boolean", "value": true } },
      },
    },
    "codex": {
      "defaultControls": {
        "modelId": "gpt-5-codex",
        "bridgePermissionMode": "alwaysAllow",
      },
    },
  },
}
```

字段对照：

| `agents.<id>.defaultControls`（settings.json）       | `controls`（sessions.json） | 含义                    |
| ---------------------------------------------------- | --------------------------- | ----------------------- |
| `modelId?: string`                                   | `modelId?`                  | ACP `session/set_model` |
| `modeId?: string`                                    | `modeId?`                   | ACP `session/set_mode`  |
| `bridgePermissionMode?: PermissionMode`              | `bridgePermissionMode?`     | 审批策略                |
| `config?: Record<string, SessionConfigControlValue>` | `config?`                   | ACP config 开关         |

- 四个字段全部可选，只写关心的项。
- 两者是同一个 `SessionControls` 类型：一个是「默认起点」，一个是「当前实际值」。这使得优先级
  规则可以退化为逐字段 `controls[x] ?? defaultControls[x]`。
- `defaultControls` 是 agent preset 的固有属性（与 `command` / `args` / `env` 并列），随 agent
  的解析结果一路传递到 `ChatRuntime`——不额外维护一张按 label 反查的表。

### 命名说明

字段名与 `sessions.json` 的 `controls` 对齐（含 `bridgePermissionMode` 这一较长名字）。这样
`defaultControls` 名副其实就是 `controls` 的默认值，代码 fallback 最直观，且避免一层「permission
→ bridgePermissionMode」的翻译。

## 4. 优先级语义

每一项（`modelId` / `modeId` / `bridgePermissionMode` / `config`）**独立**按以下顺序取第一个
存在的值：

```
① session 持久化的手动改动（sessions.json 的 controls[x]）   ← 手动优先
② 该 agent 的 defaultControls[x]（settings.json）           ← 出厂设置
③ 不设（交给 agent / 既有全局默认）
```

- **手动优先**：一旦用户对某项手动 `set-control` 过（该改动已持久化到 `controls`），重启 /
  恢复 session 都保留它，默认值只在该项 **缺失** 时兜底。
- **回到默认值的时机**：`controls[x]` 不存在时（即 ①），落到 ②。这自然发生于——
  - 全新的群（无历史 session）
  - `/new` 开新会话（`teardownThread` + `clearThreadSessions`）
  - **切换 agent**（`/bind` 改 agent、或热重载改 `bindings`）：`clearChatSessions` 清掉旧
    session，下一条消息重建时 `latest` 为 `null`，于是逐字段落到「新 agent 的
    defaultControls」——正是「切 agent 时更新默认值」的诉求，**无需** 额外的切换监听逻辑。

### `bridgePermissionMode` 的特殊性

`bridgePermissionMode` 目前有一个全局兜底 `runtime.permissionMode`
（经 `LarkBridge` 的 `display.permissionMode` 传入 `ChatRuntimeOptions.permissionMode`）。
加入 agent 默认值后，该项的完整优先级为：

```
① controls.bridgePermissionMode（持久化）
② agent defaultControls.bridgePermissionMode
③ 全局 runtime.permissionMode（既有 this.opts.permissionMode）
④ 内置 DEFAULT_PERMISSION_MODE（"alwaysAsk"）
```

即 agent 默认值插在「持久化」与「全局默认」之间。`model` / `mode` / `config` 无全局兜底，只有
①②。

## 5. 非法值处理（混合方案）

`bootstrap` 拿到「要套用的 controls」后，按来源分两类处理：

- **来自 session 持久化的 `latest.controls`**：维持现状，直接经 `applyControlsToState` 下发
  （用户手动设过的，不重新做 capabilities 校验，行为与今天一致）。
- **来自 agent `defaultControls` 的兜底项**：先逐项对 `SessionCapabilitiesSnapshot` 做
  `validateControls` 式校验：
  - 合法项 → 收集进「待下发」集合。
  - 非法项 → 从待下发中剔除 + 记 `logger.warn` + 收集进「待报告」集合。

校验通过的合法项照常下发；session **始终照常启动**。若「待报告」非空，通过 presenter
（`replyNoticeCard` / `sendNoticeCard`）发一张 **warning 卡片**（`template: "orange"`），把所有
被忽略的项合并列出，例如：

> ⚠️ 部分默认 session 设置无效，已忽略：
> • model `gpt-5-codex` 不在当前 agent（GitHub Copilot）的可选列表中
> 其余默认设置已正常应用。

每次重建 session 只要存在被忽略的默认项就发一次卡片。

### 关键实现约束

现有 `applyControlsToState`（`src/bridge/chat-runtime.ts`）是 **原子回滚** 的：任意一项下发失败
会回滚 **全部** 已应用项。因此 **不能** 把含非法项的 controls 整包丢给它。必须 **先分拣**，只把
「已通过 capabilities 校验的合法项」组成一个新的 `SessionControls` 再交给 `applyControlsToState`。

分拣所需的校验逻辑与既有 `validateControls`（`chat-runtime.ts`，检查 `modelId ∈ availableModels`、
`modeId ∈ availableModes`、`config` 命中 `configOptions` 及类型匹配、`bridgePermissionMode ∈
PERMISSION_MODES`）一致，但语义不同：`validateControls` 遇非法 **抛错**，分拣器遇非法 **剔除并
收集**。实现上应把「按 capabilities 过滤出合法子集 + 非法项清单」抽成一个纯函数，`applyControls`
（手动通道）继续用抛错版，`bootstrap`（默认值通道）用过滤版。

## 6. 数据流与代码改动点

自顶向下的数据管道：`settings.json` → preset 解析 → `ResolvedAgentInvocation` → `EffectiveBinding`
→ `ChatRuntimeOptions` → `bootstrap`。

### 6.1 `bin/agents.ts`

- `AgentPreset`、`UserPresetPatch` 各新增可选字段 `defaultControls?: SessionControls`。
- `buildRegistry` / `mergePatch` 让 `defaultControls` 像 `env` 一样可被 user patch 覆盖 / 合并。
- `ResolvedAgent` 新增 `defaultControls?`，`resolveAgent` 透传。
- 从 `src/session-store` 复用 `SessionControls` 类型（bin 已从 `../src/index.js` 引入类型，见
  `bin/lark-acp.ts` 顶部的 `import type { … SessionControls … }`）。

### 6.2 `bin/lark-acp.ts`（schema 与解析）

- `parseAgentPatch`（约 `bin/lark-acp.ts:476` 区域）新增解析 `entry["defaultControls"]`。
- 新增一个 `parseDefaultControls(id, value)`，做 **结构** 校验：
  - `modelId` / `modeId` 为 string；
  - `bridgePermissionMode` ∈ `PERMISSION_MODES`（复用 `isPermissionMode`）；
  - `config` 为对象，值为 `{ type: "boolean", value: boolean }` 或 `{ value: string }`；
  - 结构非法 → 抛 `CliError`（配置写错，启动即报错，符合既有 config 校验风格）。
  - **值** 的合法性（`modelId` 是否真的属于某 agent）**不在此校验**——那要等 agent 启动后才
    知道，留到运行时（第 5 节）。
- `resolveDefaultAgent`（`bin/lark-acp.ts:1372` 区域）产出的 `ResolvedAgentInvocation` 带上
  `defaultControls`。
- `SettingsBindingStore` 的 `BindingAgentResolver`（`src/binding-store/settings-binding-store.ts:11`）
  返回值补 `defaultControls`，使 `/bind` 与热重载得到的 `ChatBinding` 也带默认值。

### 6.3 `src/bridge/bridge.ts`（透传）

- `ResolvedAgentInvocation`（`bridge.ts:153`）新增 `defaultControls?: SessionControls`。
- `EffectiveBinding`（`bridge.ts:284`）新增 `defaultControls?: SessionControls`。
- `resolveBinding`（`bridge.ts` 约 `:1243` 后）在三个分支（stored binding / defaultCwd /
  reception）都带上对应的 `defaultControls`。
  - stored binding 分支：`defaultControls` 来源于 `ChatBinding`（由 resolver 注入）。
  - default / reception 分支：来源于 `this.defaultAgent.defaultControls`。
- `acquireRuntime`（`bridge.ts:873`）构造 `ChatRuntime` 时传入 `defaultControls: effective.defaultControls`。
  - 注意 `pinned` 分支（有历史 session 时用 `pinned` 的 cwd/command/args/label 重建
    `effective`）：`defaultControls` 应沿用 **传入的 `binding`** 的值。因为 rebind 会
    `clearChatSessions`，`pinned` 的 agent 恒等于当前 binding 的 agent，二者默认值一致；且真正
    决定用不用默认值的是 `bootstrap` 里 `latest.controls` 是否存在，不影响正确性。

`ChatBinding`（`src/binding-store/binding-store.ts`）需新增可选 `defaultControls?` 字段以承载
resolver 注入的默认值，供 `resolveBinding` 读取。

### 6.4 `src/bridge/chat-runtime.ts`（核心）

- `ChatRuntimeOptions`（`chat-runtime.ts:224`）新增 `defaultControls?: SessionControls`。
- `bootstrap`（`chat-runtime.ts:206`）改造末尾的 `if (latest?.controls)` 块（约 `:289`）：

  1. **权限初值**：`LarkAcpClient` 的 `permissionMode` 由
     ```ts
     latest?.controls?.bridgePermissionMode ?? this.opts.permissionMode;
     ```
     改为
     ```ts
     latest?.controls?.bridgePermissionMode ??
       this.opts.defaultControls?.bridgePermissionMode ??
       this.opts.permissionMode;
     ```
  2. **逐字段合并**：计算 `effectiveControls`，对 `modelId` / `modeId` / `config` 每项取
     `latest?.controls?.[x] ?? defaultControls?.[x]`。（`config` 做逐 key 合并，持久化 key 优先。）
  3. **分拣 + 下发**：
     - 若 `effectiveControls` 完全来自 `latest.controls`（无默认值介入），保持既有路径直接
       `applyControlsToState`。
     - 若含默认值兜底项，先用「过滤版校验」按 `state.sessionCapabilities` 拆成 { 合法子集,
       非法清单 }，仅对合法子集 `applyControlsToState`；`bridgePermissionMode` 合法则
       `setPermissionMode`。
  4. **warning 卡片**：非法清单非空时发 orange 卡片（用 `firstMessage.messageId` 作 reply
     anchor）。

  合并与分拣逻辑抽成纯函数便于单测（见第 7 节）。

### 6.5 文档

- `~/.lark-acp/AGENTS.md` 与 `CLAUDE.md`（内容一致，由 `installHomeTemplates` 安装，源模板见
  `src/home-templates.ts`）补一段 `agents.<id>.defaultControls` 的说明：结构、优先级、非法降级
  行为，以及「让 agent 直接改 settings.json 即可调整默认值」。

## 7. 测试计划

### 7.1 纯函数单测（新增）

抽出的「合并 + 分拣」纯函数，输入 `(latestControls?, defaultControls?, capabilitiesSnapshot)`，
输出 `{ toApply: SessionControls, ignored: IgnoredControl[] }`：

- 无 `latestControls`、`defaultControls` 全合法 → `toApply` == defaults，`ignored` 为空。
- 有 `latestControls`、部分字段 defaults 兜底 → 逐字段手动优先；`config` 逐 key 合并正确。
- `defaultControls.modelId` 不在 `availableModels` → 该项进 `ignored`，其余合法项进 `toApply`。
- `defaultControls.config` 命中不存在的 `configId` / 类型不符 → 进 `ignored`。
- `bridgePermissionMode` 非法枚举 → 进 `ignored`（结构校验已在 CLI 层拦截大部分，这里防御性覆盖）。
- agent 不暴露 `models` / `modes`（snapshot 相应字段为 null）而 defaults 却设了 → 进 `ignored`。

### 7.2 `bootstrap` 集成测（新增 / 扩展 chat-runtime 测试）

- 无持久化 + 有 agent defaults → 新 session 套用 defaults（断言 `unstable_setSessionModel` /
  `setSessionMode` / `setSessionConfigOption` 被以默认值调用）。
- 有持久化 controls + 有 defaults → 手动值优先，defaults 不覆盖已有项。
- 非法默认值 → session 正常 bootstrap（不抛错）、合法项仍下发、presenter 收到一张 orange 卡片。
- 「切 agent」路径（`clearChatSessions` 后 `latest` 为 null）→ 套用新 agent 的 defaults。
- `bridgePermissionMode` 优先级链：持久化 > agent 默认 > 全局 > 内置。

### 7.3 CLI schema 解析测（扩展 `bin` 测试）

- 合法 `defaultControls` 解析为 `SessionControls`。
- 结构非法（`modelId` 非 string、`bridgePermissionMode` 非枚举、`config` 值形状错）→ 抛
  `CliError`。
- user patch 对内置 agent 补 `defaultControls` 的合并行为。

## 8. 边界与风险

- **原子回滚陷阱**（已在第 5 节处理）：默认值通道绝不能把非法项交给 `applyControlsToState`。
- **`pinned` 分支默认值来源**（已在 6.3 处理）：用传入 binding 的 `defaultControls`。
- **热重载幂等**：改 `settings.json` 的 `defaultControls`（不动 `bindings`）——当前热重载按
  binding 签名（cwd + agentLabel，见 `bindingSnapshotOf` / `sameBindingSnapshot`）diff，**不会**
  因仅改 `defaultControls` 而重建 runtime。这是可接受的：默认值只在「新建 session」时生效，既有
  运行中的 session 本就不该被默认值改动打扰（手动优先原则）。新默认值会在下次 `/new` / 切 agent /
  重启后自然生效。此点在文档中向用户说明。
- **持久化不变**：本特性不改 `sessions.json` 结构；默认值只影响 `bootstrap` 时首次下发，之后
  `persistSession` 仍照常把生效的 controls 落盘（于是「默认值」在首次生效后即转化为该 session 的
  `controls`，符合手动优先的长期语义）。
- **卡片噪音**：仅在存在被忽略的默认项时发卡片；配置正确时零噪音。
