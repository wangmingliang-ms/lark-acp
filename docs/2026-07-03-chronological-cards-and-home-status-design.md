# 时序化卡片切段 + 主页状态标识 — 设计

日期：2026-07-03
状态：已实现（2026-07-04，见 `feat(render): seal cards before permission prompts`）

## 1. 背景与问题

当前一次 prompt 对应**一张"统一卡片"（unified card）**，在整轮对话期间被反复原地
`patch`（见 `src/acp/lark-acp-client.ts` 的 `renderCard` / `updateUnifiedCard`）。所有文本、
思考、工具调用都累积进 `timeline` 数组，塞进这**同一张卡**，直到 `finalize()` 才重置。

由此产生两个体验问题：

1. **卡片越来越长**：长会话把全部内容堆在一张卡里原地增长。
2. **审批卡时序错乱**：需要 Approve 时，审批卡走的是独立消息
   （`sendInterruptCard` → `http.replyCard`，reply 到用户原始消息）。统一卡是**原地
   patch、位置钉死**，而审批卡是**新消息、只能出现在列表最底部**。于是审批卡全部堆在
   大卡下方，即使它逻辑上发生在大卡后半段内容"之前"，视觉时序完全乱掉。

此外还有一个独立诉求（点 2–4）：用户大部分时间停留在**飞书主页/消息列表**，每个话题
（话题 / topic / thread）是一个独立 ListItem。用户希望**不点进会话**，就能在那一行看到
该话题的当前状态。

## 2. 目标

- **G1（时序正确）**：卡片严格按时间顺序出现。会话进行到需要 Approve 时，立即在**当前
  位置**冒出审批卡；Approve 之后的会话内容出现在审批卡**下方的新卡**里，而不是回填到
  上方那张钉死的大卡。
- **G2（主页可见状态）**：在飞书主页会话/话题列表里，不点进去就能一眼看到该话题的
  三态：🔄 处理中 / ⏳ 等待确认 / ✅ 已完成。

## 3. 非目标

- 不改成 Hermes 那种"纯消息流（不用卡片）"渲染。已评估并否决——保留卡片的信息密度
  （思考折叠面板、工具 ✅/⏳ 状态、diff 代码块）。但本设计有意让代码简单、便于将来若要
  迁移到消息流时改动更小。
- 不保留"中断当前任务"按钮作为刚需（用户确认非刚需）。封存卡本就渲染成
  `cancellable: false`，按钮自然消失——正好契合。仍可用聊天指令取消。
- 不改动 ① 反应 emoji（会话内 typing 指示，`addReaction("THINKING")`）与 ② 卡片
  header 的细状态（会话内展示）。二者维持现状。

## 4. 名词：飞书里的三个状态层

| #                  | 机制                                     | 代码位置                      | 会话内可见 | **主页列表可见**      |
| ------------------ | ---------------------------------------- | ----------------------------- | ---------- | --------------------- |
| ① 反应 emoji       | `addReaction(messageId,"THINKING")`      | `chat-runtime.ts` prompt 起止 | ✅         | ❌                    |
| ② 卡片 header      | `STATUS_HEADER`                          | `lark-presenter.ts`           | ✅         | ❌                    |
| ③ 列表预览 summary | `config.summary.content`（**当前未用**） | —                             | —          | ✅ **唯一能透到主页** |

G2 只能靠 ③ 实现；① / ② 都到不了主页列表。

## 5. 方案 A：卡片切段（满足 G1）

### 5.1 目标时序

```
用户消息
  └─ 会话卡 C1（封存：冻结、header=🔄 进行当中、无按钮）
  └─ 审批卡 A1（header=⏳ 待确认） ← 就在 C1 正下方冒出（seal 之后才发，保证顺序）
       …（用户点 Approve）…
  └─ 会话卡 C2（Approve 之后的新内容从这里开始）
  └─ 审批卡 A2        ← 若又需确认
  └─ 会话卡 C3
```

飞书消息的先后位置 = **发送时间顺序**（与 reply 谁无关）。因此只要保证发送顺序为
`C1 封存 → A1 → C2`，它们在列表 / 话题线程里就按此顺序排列。

### 5.2 话题模式兼容性

现有代码所有卡片都 reply 到同一条 `currentMessageId`（用户原始消息），而该消息本身处于
话题内，故 reply 它的所有卡片（C1/A1/C2）都自动落在**同一话题线程**。`threadId` 已透传进
按钮 payload 用于路由回对应 runtime。方案 A 不改变这一点，天然兼容话题模式。

### 5.3 新增 `LarkAcpClient.sealCard()`

在 `requestPermission()` 发送审批卡**之前** `await this.sealCard(params)`。逻辑仿照现有
`finalize()`：

1. 清 `flushTimer`；`while (this.flushing) await …` 等待在途 flush / 建卡完成（`this.flushing`
   已覆盖 `sendUnifiedCard` 建卡窗口，避免竞态）。
2. **移除待批工具条目**（选项 ①）：若 `params.toolCall.toolCallId` 已在 `timeline`（取决于
   agent 先发 `tool_call` 还是先发 `requestPermission`），渲染前将其滤除——该工具由审批卡
   代表，不在 C1 显示。
3. 对 C1 做**最后一次渲染**：`cancellable: false`（按钮消失）+ header 用新的封存态
   `sealed`（🔄 进行当中，蓝色）。真正的等待用户确认状态由紧随其后的审批卡 A1 表达。
4. 重置 `cardId = null`、`timeline = []`、`toolIndex.clear()`。后续内容靠现有 `renderCard`
   懒建卡逻辑自动开 **C2**。

**幂等**：若此刻 `cardId` 为空且 `timeline` 为空，直接 no-op。→ **并发多个 approve**
（agent 一次请求多个工具权限）时只封存一次；A1、A2… 依次排在下方；全部批准后 C2 继续。

### 5.4 被批工具结果落 C2

Approve 通过后 agent 才发 `tool_call_update`(completed)。此时 `toolIndex` 已清空，
`upsertTool` 找不到旧条目 → 在 **C2** 新建一条 ✅ 工具条目（含内容 / diff）。

**title 回填**：`tool_call_update` 有时不带 `title`（会显示成 "unknown"）。`sealCard()` 时
把待批工具的 `title / kind`（来自 `params.toolCall`）**暂存**；C2 首次渲染该工具时回填，
保证显示正常。暂存结构示例：`Map<toolCallId, { title, kind }>`，命中后即用即删。

### 5.5 `finalize()` 空卡保护

若本轮以 approve 结尾（`timeline` 为空且 `cardId` 为空），`finalize()` **跳过渲染**，不再
新发一张空的 "_准备中…_" 卡。

## 6. 主页状态标识：summary（满足 G2）

### 6.1 机制

给卡片 `config` 增加 `summary.content`（飞书 v2 卡片字段，自定义聊天列表预览文案）。
当前 `CARD_CONFIG_V2 = { width_mode:"fill", update_multi:true }`，新增该字段。

### 6.2 三态映射

| 语义            | summary.content                                  | 何时的卡片                                                    |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| 🔄 正在进行     | `🔄 处理中…`                                     | 会话卡 C1/C2（thinking / calling_tool / responding / sealed） |
| ⏳ 等我 Approve | `⏳ 等待确认`                                    | 审批卡 A1（seal 之后紧接发出的新消息）                        |
| ✅ 已处理结束   | `✅ 已完成`（失败 `⚠️ 出错` / 取消 `⛔ 已取消`） | finalize 后的会话卡                                           |

因方案 A 保证消息严格时序，"话题列表里最新一条消息" = "当前状态卡"，故列表 summary
自动等于当前状态。每个话题独立 ListItem、各自最新卡片带各自 summary，天然隔离。

### 6.3 待验证风险

`summary` 在**新发消息**时必然生效；卡片被 **patch** 时飞书客户端列表预览是否同步刷新，
官方文档未明确。但三态的关键切换（进行↔等确认）在方案 A 下**都伴随一条新消息**，新消息
summary 必为新值，故风险很低；仅"进行中 → 已完成"这种纯 patch 收尾需真机验证。若 patch
不刷新预览且体验不可接受，退路：finalize 时不 patch 而补发一条极简收尾消息（本设计**暂不
采用**，仅作备选）。

## 7. 改动清单

- `src/presenter/presenter.ts`
  - `AgentStatus` 增加成员 `sealed`。
  - （可选）为 summary 三态定义一个映射的输入来源——由 `AgentStatus` 推导即可，无需新增
    `UnifiedCardState` 字段。
- `src/presenter/lark-presenter.ts`
  - `STATUS_HEADER` 增加 `sealed: { content:"🔄 进行当中", template:"blue" }`。
  - 新增 `AgentStatus → summary 文案` 映射（三态归并：sealed→处理中；complete→已完成；
    cancelled/failed→对应；其余→处理中）。
  - `buildV2Card` / `buildUnifiedCard`：在 `config` 注入 `summary.content`。审批卡
    （`buildPermissionCard`）也注入 `summary.content = "⏳ 等待确认"`。
- `src/acp/lark-acp-client.ts`
  - 新增 `sealCard(params)`：封存 + 移除待批工具 + 暂存 title/kind + 重置状态。
  - `requestPermission()`：发审批卡前 `await this.sealCard(params)`。
  - 暂存待批工具 title/kind 的字段 + `upsertTool` 回填逻辑。
  - `finalize()`：空卡保护。

## 8. 测试（白箱，`*.test.ts` 同目录）

- `sealCard` 时序：seal 先于审批卡发送；seal 后 `cardId/timeline` 已重置。
- 幂等：空状态下 `sealCard` no-op；并发多 approve 只封存一次。
- 待批工具移除：seal 时若 timeline 含该工具，C1 渲染不含它。
- 结果落 C2：approve 后 `tool_call_update` 在新卡新建 ✅ 条目；title 回填正确。
- `finalize` 空卡保护：以 approve 结尾时不发空卡。
- summary：三态各自渲染出正确 `config.summary.content`；封存会话卡 header=🔄 进行当中，审批卡 header=⏳ 待确认。

## 9. 提交前三件套

`tsc --noEmit`、`eslint`、`prettier --check`（CI 同款）。改动 CLI 行为无——本次纯渲染层，
无需 E2E 进程管理验证；但 summary 的 patch 刷新需一次真机观察。
