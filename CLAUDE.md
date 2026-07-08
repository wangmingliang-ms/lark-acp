# LARK API

本项目是把飞书作为ACP的客户端的桥接库，虽然有API SDK调用，但是也不免会涉及到参考飞书官方API文档，必要时候需要参看：https://open.larksuite.com/document/server-docs/getting-started/getting-started

# ACP

ACP（Agent Communication Protocol）参考文档 https://agentcommunicationprotocol.dev/core-concepts/architecture

# 本地开发与运行

## 构建与测试

```bash
npm install
npm run build      # tsc → dist/（bin 入口会 chmod +x）
npm test           # vitest run（单元 src/**、bin/**；集成 tests/**）
```

提交前三件套（CI 同款）：`tsc --noEmit`、`eslint`、`prettier --check`。

## 运行 / 管理 bridge

CLI 入口是 `bin/humming.ts`（构建到 `dist/bin/humming.js`）。日常用内置子命令管理，
状态文件都在 `~/.humming/`（`bridge.pid`、`bridge.log`、`settings.json`、`sessions.json`）：

```bash
humming start --agent claude    # 后台启动
humming status                  # 是否在跑 + PID + 运行时长
humming logs -f                 # 实时日志
humming restart --agent claude  # 改代码后重启
humming stop                    # 停止
humming proxy --agent claude    # 前台运行（占终端，Ctrl-C 停）
```

- **开发工作流**：仓库根 `npm link` 一次，让全局 `humming` 软链到本地 `dist/`；此后
  改代码只需 `npm run build && humming restart --agent claude` 即可生效。
- **进程管理实现**在 `bin/process-control.ts`（跨平台：`process.kill(pid,0)` 探活、
  detached spawn、PID 文件）；`start`/`restart` 通过替换 argv 里的子命令 token 复用
  `proxy`，把所有选项原样转发。崩溃自愈 / 开机自启不在此层，交给 systemd / 计划任务。
- **改动 CLI 行为后**务必手动 E2E（`start`→`status`→`restart`→`stop`），并确认
  `logs` 里出现 `WebSocket connected`；单元测试只覆盖纯函数（`bin/process-control.test.ts`）。

## humming 自身操作指南

- Chat binding 是 repo-only：`settings.json` 的 `bindings.<chatId>` 只写 `{ "cwd": "/absolute/path/to/repo" }`，不要写 agent。Agent / Model / Mode / Permission / Config controls 都属于 topic/session profile；新 topic 会继承同 chat + repo 最近 session profile，repo 没有历史 session 时才使用全局默认 Agent（`runtime.agent`）。
- 当用户要求列出某个 agent 的 settings / session settings / capabilities / existing sessions 时，必须使用 humming 提供的 CLI/control 命令，不要去 Claude/Codex/Gemini/OpenCode 的缓存目录或项目目录里猜状态。Humming 会把当前 chat/topic 注入到 agent 子进程的 `HUMMING_CHAT_ID` / `HUMMING_THREAD_ID`，CLI 会自动 fallback 到这些 env vars；在 Humming agent 内执行命令时优先省略 `--chat-id` / `--thread-id`，避免 Windows PowerShell/cmd 与 bash 环境变量语法差异。
  - Agent preset 列表：`humming agents`
  - 当前 live session settings/capabilities：`humming control capabilities --json`
  - 指定 Agent 的 capabilities（不改变当前 topic）：`humming control agent-capabilities --agent <agent> --json`
  - 某 agent 的已有 ACP sessions：`humming sessions list --agent <agent> --json`
- 修改当前 topic 的 Model / Mode / Permission / Config controls 前必须先查询 live capabilities，确认 id/value 存在后再用 `humming sessions set-control ... --json '<controls>'`。成功后 Humming 会发「Session profile 已更新」通知，展示当前 Agent、Mode、Model、Permission 和 Controls；失败时 runtime 与 `sessions.json` 都不能被污染。如果同一条自然语言请求还包含 controls 生效后要执行的真实任务，成功排队/验证 controls 后再用 `humming sessions queue-task --prompt-file <task.md>`（短任务也可 `humming sessions queue-task -- <task>`）单独登记任务；Humming 会在当前 prompt 结束后先 apply pendingControls，成功后自动把 pending task 投递给生效后的 session profile。没有任务就不要 queue-task。
- 切换当前 topic 的 Agent 是破坏性 session boundary。Feishu 里优先让用户发送 `/agent <agent>`：如果 topic 已经有真实 session，Humming 会先发 context-loss warning，说明旧 Agent 内部 session context、未输出信息、旧 controls、以及这条切换消息里的任务内容都不会迁移；用户点「确认切换」后才 probe/切换，点取消则旧 session 保持不变。不要在用户自然语言要求切换时从 Agent 内静默执行 `humming sessions set-agent --agent <agent>` 绕过 warning；CLI 只用于用户已明确确认或 admin/recovery 场景。不要改 `settings.json` 的 `runtime.agent`，也不要在 `bindings` 里写 agent。probe 成功后才停止当前 topic runtime、清掉旧 session binding，并在下一条消息用新 Agent 创建全新 ACP session；旧 Agent 的内部历史不会自动迁移。切换时只会从当前 chat 最近的目标 Agent session 继承 Model / Mode / Permission / Config controls，不会继承旧 Agent controls、history 或 sessionId。
- Model / Mode / Config IDs 是 agent-specific。Claude 的 `opus` / `default` / `acceptEdits` 等控制不要带到 Copilot/Codex；切换后先查新 Agent capabilities，再用新返回里的 id 设置 controls。
- `sessions bind` 只能绑定当前 chat repo 内的 session；如果该 session 已经绑定到另一个 chat/thread，必须拒绝并提示用户先重置原 thread，不要通过手改 `sessions.json` 绕过。绑定成功通知应包含 Title / Agent / Repo / Mode / Model / Permission / Controls，且不要在群里打印完整 session/chat/thread id。

# TypeScript 工程准则（TypeScript 5.x / Strict Mode）

适用于本仓库所有 TypeScript 代码。AI 助手与人类贡献者都应遵守。

## 1. 避免魔法值

除显而易见的平凡值（`0`、`1`、一天 `24` 小时）外，禁止硬编码未加说明的数字或字符串字面量。

- 使用 `const` 常量，配合 `as const` 收窄字面量类型；或定义字面量 union。
- 优先使用所引入库已暴露的常量；库中确无定义时再自行声明。
- 常量应放在与其语义最贴近的模块中，不要堆到一个全局 `constants.ts`。

## 2. 错误处理：默认抛异常 + 文档化

TS / Node 生态以异常为主，**默认采用抛异常 + JSDoc `@throws` 文档化**的风格，与标准库、绝大多数第三方库保持一致。

- 任何可能抛出（含 `Promise` reject）的函数，必须在 JSDoc 中通过 `@throws` 描述失败原因与错误类型。
- 错误类型用自定义 `Error` 子类区分语义，并带上有用的上下文字段；不要把多种语义不同的错误合并成同一个原始 `Error`。
- 仅在以下**特定边界**才考虑 Result / Either 风格的返回类型（明确"失败是预期分支而非异常"）：
  - schema 校验 / 反序列化（如 `zod` 的 `safeParse`）
  - 用户输入 / 表单校验
  - 解析器 / 协议握手等"成功失败都是常规结果"的场景
- 不要为了一致性把整个工程改成 Result 风格——会和生态摩擦严重。

## 3. 优先使用原生异步模式

- 使用 `async` / `await` 与原生 `Promise`。
- 不要无理由引入 RxJS、Effect-TS 等重型抽象。
- 并发原语优先 `Promise.all` / `Promise.allSettled` 与 `AbortController` / `AbortSignal`，而不是再造一套调度层。
- 需要节流 / 限流时使用 `p-limit`、`p-queue`、`p-retry` 等成熟库。

## 4. 类型系统的纪律

不安全的类型断言和 `any` 会让 strict mode 形同虚设。

- **禁止** `any`：需要"任意类型"的位置一律用 `unknown` 加类型守卫。
- **禁止不安全的 `as`**——即"绕过类型检查的强转"。以下用法是允许甚至推荐的：
  - `as const`：字面量收窄
  - `satisfies` 之后的隐式收窄（优先 `satisfies` 而不是 `as`）
  - 经过类型守卫 / schema 校验后的合法收窄
  - DOM API 中已知具体子类型时的向下转型（写一行注释说明）
- **禁止** `!` 非空断言：通过 early return / 类型守卫 / `??` / `?.` 处理；确实必须断言时写一行注释说明理由（与 Rust `expect("...")` 同义）。
- 解析外部数据（HTTP / 文件 / 用户输入 / IPC）一律走 schema 校验（推荐 `zod`），不允许直接 `as SomeType`。

## 5. 保持代码可维护性

- 长函数拆分为聚焦的辅助函数。
- 函数 / 变量使用有意义的名称，不要 `data`、`info`、`tmp`。
- 每个函数只做一件事。
- 默认写 pure function，副作用收敛到模块边界（IO / 网络 / 全局状态）。
- 仅为非显而易见的逻辑添加简洁注释；不要写"这段代码做什么"，要写"为什么这么做"。

## 6. 扁平化控制流

- early return / guard clause 让主路径保持在外层作用域。
- 类型收窄替代多层 `if`：`if (!user) return; user.xxx` 优于嵌套 `if (user) { ... }`。
- 错误分支优先 `throw` 或 `return`，避免用 `else` 包裹主逻辑。
- discriminated union + `switch` + `never` 穷尽性检查，代替散落的 `if / else if` 链：

  ```ts
  function assertNever(x: never): never {
    throw new Error(`unexpected: ${String(x)}`);
  }

  switch (event.kind) {
    case "open":
      return handleOpen(event);
    case "close":
      return handleClose(event);
    default:
      return assertNever(event);
  }
  ```

- 善用 `map` / `filter` / `reduce` / `flatMap` 替代命令式循环。

## 7. 字符串处理优先使用方法而非索引切片

优先使用 `String.prototype` 的方法：`split`、`trim`、`startsWith`、`endsWith`、`replaceAll`、`match`。

- 用 `s.startsWith("xxx") ? s.slice(3) : null` 代替手算 index。
- 能用正则就不要拼字符串拼位置。
- 处理路径用 `node:path`，不要自己拼 `/`。
- 处理 URL 用 `URL` / `URLSearchParams`，不要自己拼 query string。

## 8. 模块组织

`index.ts` 是 Node / npm 生态的标准目录入口（`import "./agent"` 自动解析到 `./agent/index.ts`），保留这个约定。规则约束的是它**怎么用**：

- **`index.ts` 只暴露子模块的公开 API**，是面向外部的"门面"。
- 子模块**内部互相引用走具体文件名**（`./session`、`./transport`），不要绕回自己的 `index.ts`。
- **禁止 `export * from "./xxx"`** 把整个子树打包；逐个 named re-export，让公开面是显式的。
- **避免深层 barrel 链**（A 的 index 引 B 的 index 引 C 的 index）——会破坏 tree-shaking、引入隐式循环依赖、让"这个符号在哪定义"变得模糊。
- 文件名直接反映其内容；子模块命名要与同级 module 在架构上并列，并能在父 module 的语境下简明反映其职责。

示例：

```
src/
  agent/
    index.ts          # 子模块公开入口：仅 re-export 对外 API
    agent.ts          # 主体实现
    session.ts        # 内部组件，被 agent.ts 直接 import
    session.test.ts
  transport/
    index.ts
    transport.ts
    websocket.ts
    http.ts
```

## 9. 不要造轮子

成熟社区实现优先：

- Schema 校验：`zod`
- 时间处理：Temporal（polyfill 或 Node 原生）/ `date-fns`
- HTTP 客户端：`undici` / `ky`
- 并发控制：`p-limit` / `p-queue` / `p-retry`
- 日志：`pino`
- CLI 参数：`commander` / `yargs`

不确定有无现成方案时，先看流行库依赖了什么，再决定是否复用而非自己写半成品。

## 10. 白箱（单元）测试

- 与被测代码同目录，命名 `<module>.test.ts`。
- 不要混入主代码文件；不要用 `__tests__/` 等其他命名。
- 整个工程统一使用同一测试运行器（推荐 `vitest`）。

## 11. 黑箱（集成 / E2E）测试

- 放在仓库根 `tests/` 目录下，命名 `<test_name>.test.ts`。
- 涉及外部服务时使用 `testcontainers`（Node 版本）搭建环境。
- 公共环境搭建逻辑放在 `tests/common.ts`，被各测试文件以 `import` 方式复用。

## 12. 语义正确性

从可维护性与 AI 友好性出发，重视语义正确。

### 子模块命名

与同级 module 在架构上并列，并能在父 module 的语境下简明反映其职责和功能。

### 不要忽略错误

- 禁止 `try { ... } catch { /* swallow */ }`。
- 禁止 `catch (e: any)`；统一 `catch (e: unknown)`，必要时收窄。
- 错误要么被显式处理（日志 / 降级 / 转换为业务错误），要么原样向上传播。
- 转换错误时保留原始原因：`throw new MyError("...", { cause: e })`。
- 不要用一个泛泛的 `Error` 表达多种失败语义；用自定义子类或带 `kind` 字段的 union。

### 类型即文档

类型的定义本身就在说明"它如何看待所组织的数据中各种关系"。

- 用 discriminated union 表达"几种互斥的形态"，不要用一堆可选字段堆出来。
- 用 `readonly` / `ReadonlyArray` / `ReadonlyMap` 表达不可变性。
- 用 `as const` 元组表达固定结构。
- 避免把 `Record<string, unknown>` 或宽泛 `object` 当成结构使用。
- 当一个原始类型（多为 `string` / `number`）在领域里有特殊语义且容易和其他同底层类型混淆时（如 `UserId` vs `OrderId`），考虑使用 branded type：

  ```ts
  type UserId = string & { readonly __brand: "UserId" };
  ```

  不要为了"看起来更类型安全"给所有 id 都加 brand——只在真有混淆风险时使用。

---

## tsconfig 基线

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
  },
}
```

## 工具链

- ESLint：`@typescript-eslint/strict-type-checked` + `@typescript-eslint/stylistic-type-checked`。
- Prettier：保持默认配置，行宽 100。
- 提交前钩子：`tsc --noEmit` + `eslint` + `prettier --check`。CI 同样跑这三项。

## 风格细则

- **默认不使用 `enum`**，改用 `as const` 对象 + 字面量 union（避免数字 enum 的隐式转换问题、利于 tree-shaking）。
- **不可变优先**：函数参数偏好 `readonly T[]`、`ReadonlyMap`、`ReadonlySet`；新建对象用 spread 而非 mutate。
- **`type` vs `interface`**：默认用 `type`；只在需要 declaration merging（扩展第三方库或全局类型）时才用 `interface`。
- **import 用 `import type`** 区分类型导入；启用 `verbatimModuleSyntax` 强制约束。
- **优先 named export**，避免 default export（利于自动重命名 / 静态分析 / IDE 跳转）。
