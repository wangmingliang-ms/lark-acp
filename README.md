# lark-acp

[![npm version](https://img.shields.io/npm/v/lark-acp.svg)](https://www.npmjs.com/package/lark-acp)
[![npm downloads](https://img.shields.io/npm/dm/lark-acp.svg)](https://www.npmjs.com/package/lark-acp)
[![node version](https://img.shields.io/node/v/lark-acp.svg)](https://www.npmjs.com/package/lark-acp)
[![license](https://img.shields.io/npm/l/lark-acp.svg)](./LICENSE)

> 💖 觉得本项目有帮助、或者只是看着有点意思？动动发财的小手在右上角点个 ⭐ Star 吧——这是对作者最直接的鼓励。

> ⚠️ **WIP**：仍在迭代中，1.0 之前 CLI 选项与配置字段可能继续调整。

把 [飞书/Lark](https://open.larksuite.com/) 机器人接到任何符合 [ACP（Agent Client Protocol）](https://agentcommunicationprotocol.dev/) 的 AI Agent 上：用户在飞书里发消息，agent 在你的机器上跑，过程和结果都以一张可交互的飞书卡片呈现，工具调用授权、中断、跨进程恢复会话都在卡片里完成。

实际使用强烈建议配合[飞书cli](https://github.com/larksuite/cli)与其skill一起使用，本桥阶层会把会话信息注入上下文，通过飞书cli可以衔接各种飞书操作。

<p align="center">
  <img src="docs/mock-example.png" alt="lark-acp 在飞书里的演示卡片" width="640">
</p>

---

## CLI: `lark-acp`

### 安装与运行

```bash
# 方式一：npx，从 GitHub 免安装直接跑
npx -y "github:wangmingliang-ms/lark-acp" --help

# 方式二：从 GitHub 安装（推荐，见下方「从 GitHub 安装」）
#   注意：npm 上的 lark-acp 名称已被无关的包占用，`npm i -g lark-acp` 会装错东西。
lark-acp --help

# 方式三：在仓库内本地构建（开发 / 想用未发布的改动）
bun install          # 或 npm install
bun run build        # 或 npm run build
node dist/bin/lark-acp.js --help
```

> **本地开发建议 `npm link`**：在仓库根执行一次 `npm link`，就把全局 `lark-acp`
> 软链到本仓库的 `dist/`。之后改了代码只需 `npm run build`（无需重新 link）即可
> 生效，配合下文的 `lark-acp restart` 快速迭代。撤销：`npm rm -g lark-acp`。

### 从 GitHub 安装

npm 官方仓库上的 `lark-acp` 名称已被无关的包占用，直接 `npm i -g lark-acp` 会装错东西。
推荐用下面的脚本直接从本仓库安装（脚本会克隆到临时目录、`npm install` 并 `npm run build`，再
`npm install -g --install-links` 安装成全局命令，最后清理临时目录）：

**Linux / macOS / WSL：**

```bash
curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.sh | sh
```

**Windows PowerShell：**

```powershell
irm https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.ps1 | iex
```

可用环境变量覆盖来源仓库与分支/标签：

```bash
LARK_ACP_REF=v0.2.0 sh install.sh          # 装某个 tag
LARK_ACP_REPO=4t145/lark-acp sh install.sh # 装上游仓库
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/uninstall.sh | sh
# Windows：irm https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/uninstall.ps1 | iex
# 或直接：npm rm -g lark-acp
```

### 命令格式

```
lark-acp [global-options] proxy --agent <preset> [-- <extra-args>...]
lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
lark-acp [global-options] start --agent <preset>   # 后台运行 proxy
lark-acp [global-options] stop | restart | status
lark-acp logs [-f] [-n <lines>]
lark-acp agents
lark-acp help
lark-acp version
```

两种启动方式：

- **`--agent <preset>`** —— 使用内置预设，最常用。运行 `lark-acp agents` 查看完整列表。
- **`-- <agent-cmd>`** —— 自定义命令，`--` 后的所有参数原样转发给 agent。

两种方式可以组合：`proxy --agent claude -- --debug` 会在预设末尾追加 `--debug` 再启动。

全局选项必须放在 `proxy`（或 `start` / `restart`）子命令之前。

`proxy` 是**前台**运行（占住终端，`Ctrl-C` 停止）；`start` 把同样的 `proxy` 放到**后台**跑，见下文「后台运行与进程管理」。

### 内置 agent 预设

| Preset         | 说明                                                |
| -------------- | --------------------------------------------------- |
| `claude`       | Claude Code，需先在终端跑过 `claude` 完成登录。     |
| `claude-agent` | Claude Agent SDK 适配器，需要 `ANTHROPIC_API_KEY`。 |
| `codex`        | OpenAI Codex 适配器。                               |
| `copilot`      | GitHub Copilot CLI。                                |
| `gemini`       | Google Gemini CLI（实验性）。                       |
| `opencode`     | OpenCode，需要 `opencode` 已在 `$PATH` 上。         |

不在预设里的 agent，用 raw command：

```bash
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

也可以在配置文件的 `agents` 字段里固化自己的预设（详见下文「配置文件」一节）。

### 全局选项

| 选项                    | 说明                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `--cwd <dir>`           | agent 工作目录（默认当前目录）                                                                         |
| `--config <path>`       | 覆盖配置文件路径                                                                                       |
| `--data-dir <dir>`      | 覆盖会话存储目录                                                                                       |
| `--idle-timeout <min>`  | 闲置 N 分钟后释放会话（`0` 表示永不，默认 1440）                                                       |
| `--max-chats <n>`       | 最大并发会话数（默认 10）                                                                              |
| `--hide-thoughts`       | 不在卡片里渲染思考过程                                                                                 |
| `--hide-tools`          | 不在卡片里渲染工具调用                                                                                 |
| `--hide-cancel-button`  | 不渲染卡片底部的"中断当前任务"按钮                                                                     |
| `--permission-mode <m>` | 工具授权策略：`alwaysAsk`（默认，弹卡片让用户选）/ `alwaysAllow`（自动允许）/ `alwaysDeny`（自动拒绝） |
| `-h`, `--help`          | 显示帮助                                                                                               |
| `-v`, `--version`       | 显示版本                                                                                               |

### 后台运行与进程管理

`proxy` 是前台进程。若不想开着终端，用 `start` 把它放到后台，并用一组跨平台
（Windows / Linux 通用）的子命令管理它的生命周期——无需 systemd、无需 shell 脚本：

```bash
lark-acp start --agent claude    # 后台启动（选项与 proxy 完全一致）
lark-acp status                  # 是否在跑？PID + 运行时长
lark-acp logs                    # 打印日志末尾（默认 40 行）
lark-acp logs -f                 # 实时跟踪（Ctrl-C 退出）
lark-acp logs -n 100             # 末尾 100 行
lark-acp restart --agent claude  # 停掉再以相同选项重启（改了代码后常用）
lark-acp stop                    # 停止后台 bridge
```

| 子命令    | 说明                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `start`   | 以后台进程方式启动 `proxy`，把 PID 写入 `<home>/bridge.pid`，输出重定向到 `<home>/bridge.log`（追加）。已在运行时会拒绝重复启动。 |
| `stop`    | 停止后台 bridge：先 `SIGTERM`（触发 bridge 自身的优雅关闭），超时再 `SIGKILL`。                                                   |
| `restart` | `stop` 后再 `start`，沿用同一组选项。                                                                                             |
| `status`  | 显示是否在运行，含 PID 与运行时长。                                                                                               |
| `logs`    | 打印 `bridge.log` 末尾；`-f` / `--follow` 持续跟踪，`-n <行数>` 指定行数（默认 40）。                                             |

要点：

- **状态文件都在 home 目录下**（`~/.lark-acp/`，可用 `--home` / `$LARK_ACP_HOME` 覆盖）：
  `bridge.pid`、`bridge.log`。`start` / `restart` 会把你传的全局 / proxy 选项、以及
  `-- <agent-cmd>` 透传部分**原样**转发给后台进程。
- **`start` 后的存活检查是安全网、不是健康检查**：它只捕获启动阶段就同步崩溃的情况
  （如 settings.json 无法解析）。凭据错误、agent 命令错误、网络问题不会让 bridge 立刻
  退出（分别会被 SDK 重试、在首条消息时才懒启动、被重试），请用 `logs` / `status`
  确认是否真的连上了 Lark（日志里出现 `WebSocket connected` 即为已连接）。
- **优雅停止仅限 POSIX**：Linux 上 `stop` 走 `SIGTERM` 优雅关闭；Windows 上 `process.kill`
  是硬终止。
- **崩溃自愈 / 开机自启不在此范围**：交给平台原生托管（Linux systemd unit、Windows 计划
  任务），由它们调用 `lark-acp start`（见下文「systemd 托管」）。

### 配置文件

CLI 读取一份配置文件（默认 `~/.config/lark-acp/config.json`），里面包含凭据和运行时默认值。优先级：CLI flag > 环境变量 > 配置文件 > 内置默认。

完整字段（都可选）：

```jsonc
{
  "credentials": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  "dataDir": "./var/lark-acp",
  "runtime": {
    "cwd": "/work/project",
    "idleTimeoutMinutes": 1440,
    "maxChats": 10,
    "hideThoughts": false,
    "hideTools": false,
    "hideCancelButton": false,
    "permissionMode": "alwaysAsk",
  },
  "agents": {
    // 在已有的内置预设上"打补丁"——只需要写要改的字段
    "claude": {
      "env": { "ANTHROPIC_BASE_URL": "https://my-proxy.example.com" },
    },
    // 新增一个用户自己的预设——必须同时给出 label 和 command
    "my-agent": {
      "label": "My ACP Agent",
      "command": "node",
      "args": ["./my-agent.js", "--acp"],
      "description": "本地自研 agent",
      "env": { "FOO": "bar" },
    },
  },
}
```

凭据可以用环境变量代替文件：`LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET`。

`lark-acp agents` 会列出当前配置下所有可用的预设，并标出来源（`[built-in]` / `[user]` / `[overridden]`）。

> 在飞书开放平台 [开发者后台](https://open.larksuite.com/app) 创建一个"自建应用"，从「凭证与基础信息」页拿 `App ID` / `App Secret`；在「事件与回调」里把订阅模式切到 **长连接 (WebSocket)**。具体步骤见下文「飞书开发者后台配置」。

### 飞书开发者后台配置

在 [飞书开放平台](https://open.feishu.cn/app)（海外版 [Lark Developer](https://open.larksuite.com/app)）创建一个"自建应用"后，需要配置三块：**权限**、**事件**、**回调**，然后发布版本。

#### 1. 添加权限

「权限管理 → 批量导入/导出权限 → 导入」，粘贴下面这份 JSON 后保存：

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:readonly",
      "cardkit:card:write",
      "contact:user.base:readonly"
    ],
    "user": []
  }
}
```

每条权限对应的能力：

| 权限                                    | 用途                                               |
| --------------------------------------- | -------------------------------------------------- |
| `im:message` / `im:message:send_as_bot` | 以机器人身份回复用户消息                           |
| `im:message.group_msg`                  | 在群聊中接收消息                                   |
| `im:message.p2p_msg:readonly`           | 在单聊中接收消息                                   |
| `im:message:readonly`                   | 拉取消息上下文（@提及解析、富文本展开）            |
| `im:message:update`                     | 更新交互卡片（流式渲染思考 / 工具调用 / 终态）     |
| `im:message.reactions:write_only`       | 给消息加 / 撤 emoji 反馈，标记任务进度             |
| `im:resource`                           | 下载用户上传的图片 / 文件二进制（按 `message_id`） |
| `im:chat:readonly`                      | 读群信息（注入到 prompt 上下文里：群名、群 id）    |
| `cardkit:card:write`                    | 发送 / 修改 v2 互动卡片                            |
| `contact:user.base:readonly`            | 读用户名（注入到 prompt 上下文里：发送者姓名）     |

#### 2. 添加事件

「事件与回调 → 事件配置」，把**订阅方式**切到 **使用长连接接收事件**（不需要配置回调地址）。然后添加这一个事件，订阅身份选"应用身份"：

| 事件名   | event_type              | 用途                       |
| -------- | ----------------------- | -------------------------- |
| 接收消息 | `im.message.receive_v1` | 用户发的每条消息进入桥接层 |

#### 3. 添加回调

同一页「事件与回调 → 事件配置」下方的"卡片回调"区，添加：

| 回调名       | event_type            | 用途                                        |
| ------------ | --------------------- | ------------------------------------------- |
| 卡片回传交互 | `card.action.trigger` | 用户点击卡片按钮（授权选项 / 中断当前任务） |

#### 4. 发布版本

「版本管理与发布 → 创建版本」，按提示填写资料后提交审核 / 发布。**应用可见范围**根据实际需要选——只有可见范围内的用户才能在飞书里找到这个机器人并对话。

#### 5. 启用

把 `App ID` / `App Secret` 填到 `config.json`（或环境变量 `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET`），运行：

```bash
lark-acp proxy --agent claude
```

然后在飞书里搜到这个机器人、单聊或拉到群里直接发消息即可。

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

#### 完整配置（凭据 + 运行时默认值）

把常用默认值固化到文件，命令行只剩 `proxy --agent`：

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

CLI flag 会临时覆盖文件里的同名项。

#### systemd 托管

想要**开机自启 + 崩溃自愈**，用 systemd 之类的进程管理器托管。注意此时应让 systemd 直接
管前台的 `proxy`（systemd 自己就是 supervisor，用 `start` 的后台模式反而会和它抢管理权）：

```ini
[Service]
Environment=LARK_ACP_APP_ID=cli_a1b2c3d4e5f60001
Environment=LARK_ACP_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ExecStart=/usr/local/bin/lark-acp --cwd /srv/projects/main proxy --agent claude
Restart=on-failure
```

反之，如果只是想在自己机器上**手动**方便地启停、又不想开着终端，用内置的
`lark-acp start` / `stop` / `restart`（见上文「后台运行与进程管理」）即可，无需 systemd。

### 快速示例

```bash
# 1. 接 Claude Code（最常用）
#    会话自动持久化，重启不丢上下文。
lark-acp proxy --agent claude

# 2. 接 OpenCode，工作目录指向具体项目
lark-acp --cwd /work/project proxy --agent opencode

# 3. 接 GitHub Copilot CLI，关掉思考输出
lark-acp --hide-thoughts proxy --agent copilot

# 4. 自研 ACP server
lark-acp proxy -- node ./my-acp-server.js --port 9000

# 5. 后台运行 + 管理（不占终端）
lark-acp start --agent claude
lark-acp status
lark-acp logs -f
lark-acp restart --agent claude
lark-acp stop
```

## 类似的项目

1. golang 版本，实现也很齐全，https://github.com/ri-char/Lark-ACP
2. 另一个node版本，本项目由此重构而来 https://github.com/JiaqiZhang-Dev/lark-acp

### 本实现的不同

1. 经过生产实践上的考虑，对permissionMode添加了代理层的设置
2. 多个消息合并成一个卡片，避免在群聊中消息轰炸
3. 作为库提供，方便二次开发

---

## 参考

- ACP 协议：<https://agentcommunicationprotocol.dev/core-concepts/architecture>
- 飞书开放平台：<https://open.larksuite.com/document/server-docs/getting-started/getting-started>

License: MIT
