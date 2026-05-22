# lark-acp

> ⚠️ **WIP**：API 与模块结构仍在迭代中。库（`src/`）和 CLI（`bin/lark-acp.ts`）均可使用，但接口可能在 1.0 之前继续调整。

把 [飞书/Lark](https://open.larksuite.com/) 机器人桥接到任何符合 [ACP（Agent Client Protocol）](https://agentcommunicationprotocol.dev/) 的 AI Agent 子进程上。

桥接层负责：

- 订阅飞书消息与卡片回调，把用户消息转换成 ACP `prompt`；
- 拉起 / 复用 Agent 子进程，处理 ACP 握手、`newSession` / `loadSession` / `unstable_resumeSession`；
- 把 Agent 流式输出（文本、思考、工具调用）合并渲染到一张飞书互动卡片上，并提供"中断"按钮；
- 处理工具调用授权请求 → 飞书卡片按钮 → ACP 回调的整条链路；
- 持久化 chat → sessionId 映射，支持跨进程恢复会话。

内部架构、unified card / 取消链路 / 授权流程的细节、以及未来要做的飞书工具注入计划，都放在 [`PLAN.md`](./PLAN.md) 里。

---

## CLI: `lark-acp`

`bin/lark-acp.ts` 是一层薄薄的命令行入口，负责加载凭据、解析运行时参数，再用 `LarkBridge` 把指定的 ACP agent 子进程接到飞书上。

### 安装与运行

```bash
# 在仓库内开发：
bun install
bun run build
node dist/bin/lark-acp.js --help

# 或者通过 npm 安装后：
lark-acp --help
```

> ℹ️ 虽然脚本住在 `bin/` 目录里（这是 npm 生态对 `package.json#bin` 入口的传统约定），它本身是一个普通的 Node.js / TypeScript 脚本，不是预编译的二进制。`package.json#bin` 把 `dist/bin/lark-acp.js` 注册成 PATH 上的命令。

### 命令格式

```
lark-acp [global-options] proxy --agent <preset> [-- <extra-args>...]
lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
lark-acp agents
lark-acp help
lark-acp version
```

两种启动方式：

- **`--agent <preset>`** —— 使用内置预设，最常用。运行 `lark-acp agents` 查看完整列表（当前提供 `claude` / `claude-agent` / `codex` / `copilot` / `gemini` / `opencode`）。
- **`-- <agent-cmd>`** —— 任意自定义命令（自研 ACP server、未在预设里的工具）。`--` 后的所有 token 原样转发，agent 自己的 flag 不会被本工具吞掉。

两种方式可以组合：`proxy --agent claude -- --debug` 会在预设的 args 末尾追加 `--debug` 再启动。

所有全局选项**必须**出现在 `proxy` 子命令之前。

### 内置 agent 预设

`lark-acp proxy --agent <preset>` 直接展开成下列命令，避免每次重复输入冗长的 `npx @scope/package-name`。`lark-acp agents` 命令会输出最新清单。

| Preset         | 展开命令                                       | 说明                                                                                                          |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `claude`       | `npx -y @zed-industries/claude-code-acp`       | Zed 维护的 Claude Code ACP 适配器，会拉起本地 `claude` 子进程并桥接到 ACP；需先在终端跑过 `claude` 完成登录。 |
| `claude-agent` | `npx -y @agentclientprotocol/claude-agent-acp` | 直接走 Anthropic API 的 Claude Agent SDK 适配器；需要 `ANTHROPIC_API_KEY`。                                   |
| `codex`        | `npx -y @zed-industries/codex-acp`             | OpenAI Codex 的 ACP 适配器。                                                                                  |
| `copilot`      | `npx -y @github/copilot --acp --yolo`          | GitHub Copilot CLI 原生支持 `--acp`。                                                                         |
| `gemini`       | `npx -y @google/gemini-cli --experimental-acp` | Google Gemini CLI 的实验性 ACP 模式。                                                                         |
| `opencode`     | `opencode acp`                                 | OpenCode 自带 `acp` 子命令；预设假设 `opencode` 已在 `$PATH` 上。                                             |

> ⚠️ 直接 `proxy -- claude`（**不带**适配器）不会工作 —— Claude Code CLI 本身没有 ACP server 模式，会被当作普通交互式 REPL 启动。所以才需要 `--agent claude` 走 Zed 适配器；其它 CLI 同理。

如果需要的 agent 不在预设里（自研 ACP server、未发布到 npm 的工具等），用 raw command 路径：

```bash
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

### 全局选项

| 选项                   | 说明                                              |
| ---------------------- | ------------------------------------------------- |
| `--cwd <dir>`          | agent 子进程工作目录（默认当前目录）              |
| `--config <path>`      | 覆盖配置文件路径                                  |
| `--data-dir <dir>`     | 覆盖会话存储目录                                  |
| `--idle-timeout <min>` | 闲置 N 分钟后驱逐 chat（`0` 表示永不，默认 1440） |
| `--max-chats <n>`      | 最大并发 chat 数（默认 10）                       |
| `--hide-thoughts`      | 不在卡片中渲染 `agent_thought_chunk`              |
| `--hide-tools`         | 不在卡片中渲染 `tool_call` 时间线条目             |
| `--hide-cancel-button` | 不渲染卡片底部的"中断当前任务"按钮                |
| `-h`, `--help`         | 显示帮助                                          |
| `-v`, `--version`      | 显示版本                                          |

### 配置文件

CLI 读取一份**通用配置文件**（默认 `$XDG_CONFIG_HOME/lark-acp/config.json`，回退 `~/.config/lark-acp/config.json`），里面包含凭据和运行时默认值。CLI flag 优先级最高，环境变量次之，配置文件兜底，最后才是内置默认值。

完整 schema（所有字段都可选）：

```jsonc
{
  "credentials": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  "dataDir": "./var/lark-acp", // 等价 --data-dir
  "runtime": {
    "cwd": "/work/project", // 等价 --cwd
    "idleTimeoutMinutes": 1440, // 等价 --idle-timeout
    "maxChats": 10, // 等价 --max-chats
    "hideThoughts": false, // 等价 --hide-thoughts
    "hideTools": false,
    "hideCancelButton": false,
  },
}
```

文件路径和敏感字段的覆盖关系：

| 字段                              | 来源（高 → 低）                                                   |
| --------------------------------- | ----------------------------------------------------------------- |
| `credentials.appId` / `appSecret` | 环境变量 `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET` → 配置文件     |
| 配置文件路径                      | `--config` → 环境变量 `LARK_ACP_CONFIG` → XDG 默认                |
| `dataDir`                         | `--data-dir` → 环境变量 `LARK_ACP_DATA_DIR` → 配置文件 → XDG 默认 |
| `runtime.*`                       | 同名 CLI flag → 配置文件 → 内置默认                               |

> 在飞书开放平台 [开发者后台](https://open.larksuite.com/app) 创建一个"自建应用"，从「凭证与基础信息」页拿 `App ID` / `App Secret`；在「事件与回调」里把订阅模式切到 **长连接 (WebSocket)**，并订阅 `im.message.receive_v1` / `card.action.trigger`。

会话状态（`sessions.json`）默认写到 `$XDG_DATA_HOME/lark-acp`（回退 `~/.local/share/lark-acp`）。

### 配置示例

#### 最小配置（仅写一个文件，其它走默认）

```bash
# 1. 准备目录（首次使用时一次性执行）
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp"

# 2. 写入凭据
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json" <<'EOF'
{
  "credentials": {
    "appId":     "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json"

# 3. 启动桥接
lark-acp proxy --agent claude
```

最终目录布局：

```
~/.config/lark-acp/
└── config.json                # 凭据 + 可选的运行时默认值
~/.local/share/lark-acp/
└── sessions.json              # 运行起来后自动生成的 chat→sessionId 映射
```

#### 完整配置（凭据 + 运行时默认值）

把所有运行时默认值固化到文件里，命令行只剩 `proxy --agent` 那段：

```jsonc
{
  "credentials": {
    "appId": "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  "runtime": {
    "cwd": "/srv/projects/main",
    "idleTimeoutMinutes": 60,
    "maxChats": 20,
    "hideThoughts": true,
  },
}
```

```bash
lark-acp proxy --agent claude
```

需要临时覆盖某项时再传 flag，例如 `--cwd /tmp/sandbox` 会盖掉文件里的 `runtime.cwd`。

#### 用环境变量代替凭据文件

适合 CI、容器、或临时切换不同 App：

```bash
export LARK_ACP_APP_ID="cli_a1b2c3d4e5f60001"
export LARK_ACP_APP_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

lark-acp proxy --agent claude
```

环境变量同时存在时，覆盖文件中 `credentials` 块的同名字段。

#### 自定义路径

把配置和状态都收到项目内部，便于多账号切换 / 隔离：

```bash
lark-acp \
  --config   ./secrets/lark-acp.json \
  --data-dir ./var/lark-acp \
  proxy --agent claude
```

或用环境变量等价：

```bash
LARK_ACP_CONFIG=./secrets/lark-acp.json \
LARK_ACP_DATA_DIR=./var/lark-acp \
  lark-acp proxy --agent claude
```

#### 把命令固定下来（systemd / pm2 等）

`lark-acp` 是前台进程，自身不带 daemon 模式，由进程管理器托管即可。systemd unit 的 `ExecStart` 示例：

```ini
[Service]
Environment=LARK_ACP_APP_ID=cli_a1b2c3d4e5f60001
Environment=LARK_ACP_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ExecStart=/usr/local/bin/lark-acp --cwd /srv/projects/main proxy --agent claude
Restart=on-failure
```

### 退出与信号

CLI 在收到 `SIGINT` / `SIGTERM` 时会尝试优雅停止：调用 `bridge.stop()` 关闭所有 chat runtime，再退出。Agent 子进程由 `LarkBridge` 内部的 `ChatRuntime.shutdown()` 负责清理。

### 快速示例

```bash
# 1. 接 Claude Code（最常用）
#    会话由 lark-acp 自己持久化，重启自动恢复，无需手动 resume。
lark-acp proxy --agent claude

# 2. 接 OpenCode，agent 工作目录设到具体项目
lark-acp --cwd /work/project proxy --agent opencode

# 3. 接 GitHub Copilot CLI，关掉思考输出
lark-acp --hide-thoughts proxy --agent copilot

# 4. 自研 ACP server（不在预设里）
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

---

## 库使用：`LarkBridge`

如果不走 CLI，而是把桥接层嵌进自己的应用，直接 `import` 即可：

```ts
import { LarkBridge, FileSessionStore } from "lark-acp";

const bridge = new LarkBridge({
  feishu: { appId, appSecret },

  agent: {
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    cwd: "/path/to/project",
    env: { ... },
    showThoughts: true,           // 是否在卡片中渲染 agent_thought_chunk
    showTools: true,              // 是否渲染 tool_call / tool_call_update
    showCancelButton: true,       // 是否渲染卡片底部"中断当前任务"按钮
    permissionTimeoutMs: 300_000, // 授权卡片自动 cancel 超时
  },

  session: {
    idleTimeoutMs: 24 * 3600_000, // 0 = never
    maxConcurrentChats: 10,
  },

  sessionStore: new FileSessionStore({ path: "./sessions.json" }),
});

await bridge.start();
```

`bridge.stop()` 优雅停止；`LarkCardPresenter` / `LarkPresenter` 接口可替换以接入别的 UI（比如 Web / 自定义协议）。完整 API 见 `src/index.ts` 的 re-export。

---

## 工程约定

仓库的 TypeScript 风格规范见 [`CLAUDE.md`](./CLAUDE.md)。要点：默认抛异常 + JSDoc `@throws`，仅在 schema 解析等"失败是预期分支"的边界用 Result 风格；禁 `any` / 不安全 `as` / `!`；默认 `type` 而非 `interface`；ESM + NodeNext，import 路径写 `.js` 后缀。`tsconfig.json` 启用了 `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax` / `noFallthroughCasesInSwitch`。

格式化由 Prettier（行宽 100）统一：`bun run fmt` 写盘，`bun run fmt:check` 校验，Zed 在 `.zed/settings.json` 里配置成保存即格式化。

---

## 参考

- ACP 协议：<https://agentcommunicationprotocol.dev/core-concepts/architecture>
- 飞书开放平台：<https://open.larksuite.com/document/server-docs/getting-started/getting-started>
- 路线图与设计文档：[`PLAN.md`](./PLAN.md)
- 工程规范：[`CLAUDE.md`](./CLAUDE.md)

License: MIT
