# Humming Agent

[![npm version](https://img.shields.io/npm/v/humming-agent.svg)](https://www.npmjs.com/package/humming-agent)
[![npm downloads](https://img.shields.io/npm/dm/humming-agent.svg)](https://www.npmjs.com/package/humming-agent)
[![node version](https://img.shields.io/node/v/humming-agent.svg)](https://www.npmjs.com/package/humming-agent)
[![license](https://img.shields.io/npm/l/humming-agent.svg)](./LICENSE)

> 💖 觉得本项目有帮助、或者只是看着有点意思？动动发财的小手在右上角点个 ⭐ Star 吧——这是对作者最直接的鼓励。

> ⚠️ **WIP**：仍在迭代中，1.0 之前 CLI 选项与配置字段可能继续调整。

**Humming Agent** 是一个把飞书/Lark 作为 ACP 客户端的轻量本地桥接服务。它不直接发送 LLM 请求，而是通过 ACP 把聊天任务交给本机的第三方 Agent（Claude Code、Codex、Copilot、Gemini、OpenCode 等），并管理 repo 绑定、topic session 和会话配置。

用户在飞书里发消息，Agent 在你的机器上运行；过程和结果通过可交互的飞书卡片呈现，工具调用授权、中断和跨进程会话恢复也都在卡片里完成。

如需让 Agent 继续执行飞书操作，建议配合[飞书 CLI](https://github.com/larksuite/cli)及其 Skill 使用。Humming 会把当前会话信息注入上下文，Agent 可据此调用飞书 CLI。

<p align="center">
  <img src="docs/mock-example.png" alt="humming 在飞书里的演示卡片" width="640">
</p>

---

## CLI: `humming`

### 安装与运行

```bash
# 方式一：npx，从 GitHub 免安装直接跑
npx -y "github:wangmingliang-ms/humming" --help

# 方式二：从 GitHub 安装（推荐，见下方「从 GitHub 安装」）
humming --help

# 方式三：在仓库内本地构建（开发 / 想用未发布的改动）
bun install          # 或 npm install
bun run build        # 或 npm run build
node dist/bin/humming.js --help
```

> **本地开发建议 `npm link`**：在仓库根执行一次 `npm link`，就把全局 `humming`
> 软链到本仓库的 `dist/`。之后改了代码只需 `npm run build`（无需重新 link）即可
> 生效，配合下文的 `humming bridge restart` 快速迭代。撤销：`npm rm -g humming-agent`。

### 从 GitHub 安装

推荐用下面的脚本直接从本仓库安装。脚本会把仓库**持久化 clone** 到
`<home>/humming-project`（`<home>` 默认 `~/.humming`，可用 `$HUMMING_HOME` 覆盖），
在该 checkout 里 `npm install` + `npm run build`，再用 **`npm link`** 把全局 `humming`
命令软链到这个 checkout 的 `dist/`，随后执行 `humming init` 初始化 `~/.humming` 模板。
因为是软链而非拷贝，之后 `humming update` 重新构建该 checkout 即可让全局命令生效，无需重装。
重复运行脚本会幂等地把已有 checkout 硬同步到 `origin/$HUMMING_REF`（默认 `main`）：

**Linux / macOS / WSL：**

```bash
curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/humming/main/install.sh | sh
```

**Windows PowerShell：**

```powershell
irm https://raw.githubusercontent.com/wangmingliang-ms/humming/main/install.ps1 | iex
```

可用环境变量覆盖来源仓库与分支/标签：

```bash
HUMMING_REF=v0.2.0 sh install.sh          # 装某个 tag
HUMMING_REPO=your-org/humming sh install.sh # 装上游仓库
```

| 变量           | 默认值                     | 含义                                         |
| -------------- | -------------------------- | -------------------------------------------- |
| `HUMMING_HOME` | `~/.humming`               | home 目录；managed checkout 落在其下         |
| `HUMMING_REPO` | `wangmingliang-ms/humming` | GitHub `owner/repo`（仅在首次 clone 时使用） |
| `HUMMING_REF`  | `main`                     | 要同步的 git 分支/标签                       |

装好之后，升级不用再跑安装脚本，直接 `humming update` 即可（见下文
「升级：`humming update`」）。

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/humming/main/uninstall.sh | sh
# Windows：irm https://raw.githubusercontent.com/wangmingliang-ms/humming/main/uninstall.ps1 | iex
# 或直接：npm rm -g humming-agent
```

### 命令格式

```
humming bridge run [--agent <preset>] [-- <extra-args>...]
humming bridge run -- <agent-cmd> [agent-args...]
humming setup [--domain feishu|lark] [--force] # 扫码一键创建飞书/Lark Bot 并保存凭据
humming init                          # 初始化 ~/.humming 模板
humming bridge start [--agent <preset>] [options]   # 后台运行 bridge run（不接受 `--` 原始命令）
humming bridge stop | restart | status
humming bridge logs [-f] [-n <lines>]
humming run | start | stop | restart | status | logs  # 上述 bridge 命令的顶层快捷方式
humming update                        # 同步并重建 managed checkout
humming agent list [--json]
humming agent capabilities|models|modes|permissions --agent <preset> [--cwd <dir>] [--json]
humming session list [--agent <preset>] [--cwd <dir>] [--chat-id <id>] [--thread-id <id>] [--json]
humming session bind --agent <preset> --session-id <id> [--chat-id <id>] [--thread-id <id>]
humming session capabilities|models|modes|permissions [--chat-id <id>] [--thread-id <id>] [--json]
humming session configure [--agent <preset>] [--model <id>] [--mode <id>] [--permission <mode>] [--config <id=value>...] [--message <text>|--message-file <path>|--message-stdin]
humming session send --message <text>|--message-file <path>|--message-stdin
humming --help
humming --version
```

两种启动方式：

- **`--agent <preset>`** —— 使用内置预设，最常用。运行 `humming agent list` 查看完整列表。
- **`-- <agent-cmd>`** —— 自定义命令，`--` 后的所有参数原样转发给 agent；这是唯一允许的位置参数透传，且只在 `bridge run` 下生效。

两种方式可以组合：`bridge run --agent claude -- --debug` 会在预设末尾追加 `--debug` 再启动。

`--home` / `--settings-path` / `--data-dir` 这几个全局选项可以出现在命令行的任意位置（`bridge run` 前后皆可）。所有业务取值都用具名选项：`-a/--agent`、`-m/--model`、`--mode`、`-p/--permission`、`-c/--config`（可重复）、`-C/--cwd`、`--chat-id`、`--thread-id`、`--session-id`、`--json`；不接受位置参数形式的 Agent/Model 等取值。

`run/start/stop/restart/status/logs` 是对应 `bridge` 命令的顶层快捷方式，参数和行为完全相同。
例如 `humming start` 等价于 `humming bridge start`。`run` 是**前台**运行（占住终端，
`Ctrl-C` 停止）；`start` 把规范的 `bridge run` 放到**后台**跑。

### 一键扫码配置飞书 / Lark Bot

推荐先跑：

```bash
humming setup
```

Humming 会在终端显示二维码；用飞书 / Lark 手机 App 扫码确认后，飞书开放平台会自动创建一个适合 agent 的自建 Bot 应用，并把 App ID / App Secret 返回给本机 CLI。Humming 会把凭据保存到 `~/.humming/settings.json` 的 `credentials` block，并尽量把文件权限设置为 `0600`。

已有凭据时，`setup` 默认拒绝覆盖；确实要重新生成/替换时使用：

```bash
humming setup --force
```

国际版 Lark 可以显式指定：

```bash
humming setup --domain lark
```

安全约束：命令输出只显示脱敏后的 App ID，**不会打印 App Secret**。如果扫码流程不可用，仍可按下方「配置文件」和「飞书开发者后台配置」手动创建应用并填写凭据。

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
humming bridge run -- node ./my-acp-server.js --port 9000
```

也可以在配置文件的 `agents` 字段里固化自己的预设（详见下文「配置文件」一节）。

### `bridge run` / `bridge start` 选项

| 选项                                         | 说明                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `-a, --agent <preset>`                       | Agent 预设 id 或 raw command                                                                           |
| `-C, --cwd <dir>`                            | 未绑定 chat 的默认工作目录                                                                             |
| `--unbound-cwd <dir>`                        | 接待区（未绑定 chat）工作目录，空字符串表示关闭                                                        |
| `--home <dir>`                               | Humming home 目录（默认 `~/.humming`）                                                                 |
| `--settings-path <path>`                     | 覆盖 settings.json 路径                                                                                |
| `--data-dir <dir>`                           | 覆盖会话存储目录                                                                                       |
| `--idle-timeout <min>`                       | 闲置 N 分钟后释放会话（`0` 表示永不，默认 1440）                                                       |
| `--max-chats <n>`                            | 最大并发会话数（默认 10）                                                                              |
| `--hide-thoughts`                            | 不在卡片里渲染思考过程                                                                                 |
| `--hide-tools`                               | 不在卡片里渲染工具调用                                                                                 |
| `--hide-cancel-button`                       | 不渲染卡片底部的"中断当前任务"按钮                                                                     |
| `-p, --permission <m>`                       | 工具授权策略：`alwaysAsk`（默认，弹卡片让用户选）/ `alwaysAllow`（自动允许）/ `alwaysDeny`（自动拒绝） |
| `--require-mention` / `--no-require-mention` | 群聊里是否要求 @-mention 才响应                                                                        |
| `-h`, `--help`                               | 显示帮助                                                                                               |
| `-v`, `--version`                            | 显示版本                                                                                               |

`--home` / `--settings-path` / `--data-dir` 对所有子命令都生效（`bridge`、`agent`、`session`、`setup`、`init`、`update`），不仅限于 `bridge run`。

### 后台运行与进程管理

`bridge run` 是前台进程。若不想开着终端，用 `bridge start` 把它放到后台，并用一组跨平台
（Windows / Linux 通用）的子命令管理它的生命周期。Linux / WSL 上会优先使用
**systemd user service** 托管（关闭 terminal 不会停）；没有 systemd 时回退到普通 detached
子进程：

```bash
humming start --agent claude    # 后台启动（使用具名选项；原始命令仅支持 run）
humming status                  # 是否在跑？PID + 运行时长
humming logs                    # 打印日志末尾（默认 40 行）
humming logs -f                 # 实时跟踪（Ctrl-C 退出）
humming logs -n 100             # 末尾 100 行
humming restart                 # 停掉再以原启动参数重启（改了代码后常用）
humming stop                    # 停止后台 bridge
```

> **`--agent` 是可选的**：不带时，默认 agent 按 `--agent` → settings.json 的
> `runtime.agent` → 内置 `claude` 依次回退。所以在一台干净机器上，只要
> settings.json 里填好凭据，直接 `humming start` 就能起（用 claude）；想换默认
> agent，在 settings.json 写 `"runtime": { "agent": "codex" }` 即可，无需每次都敲
> `--agent`。
>
> **`bridge restart` 暂不接受改动过的启动选项**：它总是复用上一次 `start`/`restart` 持久化
> 的启动 argv。想换 `--agent` 等选项，请先 `humming stop`，再用新选项 `humming start`。

| 子命令    | 说明                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | 前台运行 bridge，`Ctrl-C` 停止。                                                                                                       |
| `start`   | 以后台进程方式启动 `bridge run`，把 PID 写入 `<home>/bridge.pid`，输出重定向到 `<home>/bridge.log`（追加）。已在运行时会拒绝重复启动。 |
| `stop`    | 停止后台 bridge：先 `SIGTERM`（触发 bridge 自身的优雅关闭），超时再 `SIGKILL`。                                                        |
| `restart` | `stop` 后再 `start`，沿用上一次持久化的启动参数。                                                                                      |
| `status`  | 显示是否在运行，含 PID 与运行时长。                                                                                                    |
| `logs`    | 打印 `bridge.log` 末尾；`-f` / `--follow` 持续跟踪，`-n <行数>` 指定行数（默认 40）。                                                  |

`humming update`（顶层命令，不在 `bridge` 之下）把 managed checkout 硬同步到 `origin/$HUMMING_REF` 并重建，然后按原始启动参数重启在跑的 bridge（见下文「升级：`humming update`」）。

要点：

- **状态文件都在 home 目录下**（`~/.humming/`，可用 `--home` / `$HUMMING_HOME` 覆盖）：
  `bridge.pid`、`bridge.log`。`bridge start` / `bridge restart` 会把你传的选项、以及
  `-- <agent-cmd>` 透传部分重写成一份规范的 `bridge run ...` argv 转发给后台进程，并持久化到
  `bridge.launch.json`，供 `humming update`（以及不带参数的 `humming bridge restart`）按原样重启，
  不会丢掉 `--agent` 等参数。managed checkout 位于同目录下的 `humming-project/`。
- **Lifecycle / binding 通知**：在 settings.json 写 `"runtime": { "lifecycleNotifyChatIds": ["oc_..."] }` 后，
  bridge 启动完成会给这些会话发「已启动」，`stop` 时发「正在停止」，`restart` 时发「正在重启」和「已重启」；若捕获到未处理异常 / Promise rejection，会写入 `bridge.log` 并发「Humming 发生未捕获错误」通知。通知是 best-effort，发送失败只记日志，不阻塞进程管理。每次 repo 绑定成功也会发「已绑定 repo」通知并列出修改明细；通过 CLI 绑定 topic session 成功时会发「已绑定 session」通知，包含 session title 和 Agent / Mode / Model / Permission / Config 修改明细；`session configure` 成功时会发「会话配置已更新」通知。
- **Agent 切换通知**：`session configure --agent <preset>` 会在当前回复完成后停止当前 topic runtime、清掉旧 session 绑定，并保存新 Agent 的会话配置。成功后发送「Agent 已切换」通知，说明旧 Agent 历史不会自动迁移；下一条消息会用新 Agent 创建全新 ACP session。切换时会从当前 chat 最近的目标 Agent session 继承 Mode / Model / Permission / Config（只继承配置，不继承 history/sessionId）。
- **初始化模板**：执行 `humming init` 会创建/刷新 `~/.humming/AGENTS.md`、`~/.humming/CLAUDE.md`，并创建 `~/.humming/settings.back.json`、`~/.humming/sessions.back.json` 作为可复制参考模板。官方 install 脚本会在全局命令安装完成后自动执行一次 `humming init`；手动安装或换 home 时也可以单独运行。`settings.json` / `sessions.json` 仍只在真实配置或会话产生时创建；`.back.json` 不含真实凭据。
- **Linux / WSL 上是真后台托管**：如果 `systemctl --user` 可用，`bridge start` 会用
  `systemd-run --user` 启动一个 transient service（unit 名会显示在 `bridge status` 里），bridge
  不再挂在当前 terminal 下面；关闭终端不会停。没有 systemd 的平台才回退到普通 detached
  子进程。
- **`start` 后的存活检查是安全网、不是健康检查**：它只捕获启动阶段就同步崩溃的情况
  （如 settings.json 无法解析）。凭据错误、agent 命令错误、网络问题不会让 bridge 立刻
  退出（分别会被 SDK 重试、在首条消息时才懒启动、被重试），请用 `bridge logs` / `bridge status`
  确认是否真的连上了 Lark（日志里出现 `WebSocket connected` 即为已连接）。
- **优雅停止仅限 POSIX**：Linux 上 `stop` 走 `SIGTERM` 优雅关闭；Windows 上 `process.kill`
  是硬终止。
- **崩溃自愈 / 开机自启不在此范围**：交给平台原生托管（Linux systemd unit、Windows 计划
  任务），由它们调用 `humming bridge start`（见下文「systemd 托管」）。

### 升级：`humming update`

装过一次之后，用 `humming update` 就能把本机升级到最新版，不必再跑安装脚本：

```bash
humming update
HUMMING_REF=some-branch humming update   # 同步非默认分支
```

它做这几件事：

1. **定位** managed checkout `<home>/humming-project`。若不存在则**直接报错**并以非零退出，
   提示你重跑安装脚本——`update` 不会自己 clone，也不做旧布局的自愈。
2. **硬同步 `main`**：`git fetch origin` → `git checkout -f $HUMMING_REF`（默认 `main`）
   → `git reset --hard origin/$HUMMING_REF`。checkout 是纯机器持有的产物，本地改动会被覆盖。
3. **重装 + 重建**：在 checkout 里 `npm install` 后 `npm run build`。
4. **刷新全局命令**：`npm link`（幂等，确保全局 `humming` 仍指向这个 checkout）。
5. **自动重启**：读取 `<home>/bridge.launch.json` 拿到原始启动 argv——
   - bridge 在跑 → 用**完全相同**的参数（含 `--agent` 等）`stop` 再 `start`。
   - bridge 没跑 → 跳过重启，打印 `humming bridge start` 提示。
   - bridge 在跑但 launch 文件缺失/损坏 → 报错让你手动 `humming bridge restart`，绝不瞎猜参数。

顺序上保证 git + build 成功之后才动正在跑的 bridge，所以**一次失败的 update 不会搞挂现有 bridge**。
`update` 只针对新版持久化 checkout 布局；老的临时目录安装方式没有 managed checkout，请先重跑安装脚本。

### 会话配置与实时能力

运行中的 bridge 会在 home 目录下打开本地 control socket（默认 `~/.humming/control.sock`），供本机 CLI 查询当前 ACP session 的 live capabilities，并受控写入 `sessions.json`。

Humming 会给 agent 子进程注入 `HUMMING_CHAT_ID` / `HUMMING_THREAD_ID`；CLI 会自动 fallback 到这两个 env vars。也就是说，从 Humming agent 内执行下面这些命令时，通常不需要显式传 `--chat-id` / `--thread-id`，这可以避免 Windows PowerShell/cmd 与 bash 的环境变量语法差异。只有在你要操作另一个 chat/topic 时才显式传 id。

`humming agent ...` 与 `humming session ...` 是两条不同的数据路径，互不替代：

```text
humming agent capabilities    -> 短生命周期地 probe 任意 Agent
humming session capabilities  -> 查询当前 Topic Session 的 live 状态
```

#### 绑定 topic 到已有 agent session

`humming session list` 用于列出 agent 已有 sessions。默认 cwd 解析顺序是 `--cwd` → 当前 chat binding → `runtime.cwd`；因此在普通项目 chat 里不用指定 cwd，在 host/reception chat 里也可以显式查询某个 repo：

```bash
# 当前 chat 绑定 repo 内的 Claude sessions
humming session list \
  --agent claude \
  --json

# 只查询某个 repo，不绑定
humming session list --agent codex --cwd /absolute/path/to/repo --json
```

`humming session bind` 把**当前 topic** 绑定到一个已有 session。它故意不接受 `--cwd`：只能绑定当前 chat repo 内的 session，不会修改 chat binding，也不支持 topic 跨 repo 绑定。绑定前 CLI 会用 `session/list` 验证 session 属于当前 repo；绑定后 bridge 会停止当前 topic runtime、更新 `sessions.json`，并回复一张包含 session title、Agent、Mode、Model、Permission、Config 与修改明细的「已绑定 session」通知卡片。下一条 topic 消息会 resume 这个 session。

如果目标 session 已经绑定到另一个 chat/thread，本次 bind 会被拒绝，并发送「Session 已被绑定」冲突通知；不要通过手改 `sessions.json` 绕过，应先在原 thread `/new` 重置或确认原绑定不再需要。

```bash
humming session bind \
  --agent claude \
  --session-id "<session list[].sessionId>"
```

`sessions.json` 里的记录会保留 `title`、`sessionUpdatedAt`、`createdAt`、`updatedAt` 等 metadata，方便人工检查。

#### 切换 Agent、更改 Model/Mode/Permission/Config，以及原子化的「切换 + 消息」请求

`humming session configure` 是唯一的会话配置变更命令。它接受 `--agent` / `-m, --model` / `--mode` / `-p, --permission` / `-c, --config`（可重复）中任意组合，并且要求至少提供一个；额外还可以附带一条消息（`--message` / `--message-file` / `--message-stdin`，三选一），这条消息只会在新配置完全生效之后才发送：

```bash
# 纯粹切换 Agent，不带其他配置或消息
humming session configure --agent copilot

# 只改 Model / Mode / Permission
humming session configure --model <model-id> --mode <mode-id> --permission alwaysAsk

# 切换 Agent 的同时设置其他配置并附带任务，作为一次原子操作生效
humming session configure \
  --agent copilot \
  --model <model-id> \
  --mode <mode-id> \
  --message-file /absolute/path/to/task.md
```

语义（docs/cli-command-model-SPEC.md §9 有完整定义）：

- Model/Mode/Config 永远针对这次请求的**目标 Agent**（本次 `--agent`，否则是待应用配置变更中的 Agent，再否则是当前会话的 Agent）校验，绝不会拿当前正在运行的旧 Agent 去校验新 Agent 的取值。
- 同一个 topic 最多只有一份待应用配置变更；后续 `configure` 请求会按字段合并（后写覆盖），不会维护互相独立的排队状态。
- 若合并后目标 Agent 发生变化，累积的 Model/Mode/Config 会针对新 Agent 重新校验。
- 附带的消息只有在完整的会话配置成功生效之后才会发送；探测目标 Agent 失败、或启动/恢复目标 Agent 失败，都不会发送消息，也不会影响当前仍在使用的 session。
- 切换 Agent 时会对目标 Agent 做一次短暂 probe 用于提前反馈（例如命令拼写错误），但这个 probe 结果不会被当作「当前 Agent 能力」去校验 Model/Mode/Config——完整校验始终由 Bridge 完成。
- 不会自动迁移旧 Agent 的内部对话历史；下一条消息会用新 Agent 创建全新的 ACP session。

如果只是想查看某个 Agent 支持哪些 model/mode/config，而不改变当前 topic，用短生命周期 probe：

```bash
humming agent capabilities \
  --agent copilot \
  --json
```

这个命令会启动所选 Agent、创建 throwaway ACP session 读取 capabilities，然后立即停止；不会修改 `sessions.json` 或当前 topic runtime。如果 probe 失败且提供了 chat id，Humming 会发送「目标 Agent 不可用」通知。

`humming agent models` / `humming agent modes` / `humming agent permissions` 是同一次 probe 结果的投影，不会另起一次 probe。

#### 实时能力与配置

查询当前会话可用的 ACP 原生能力：

```bash
humming session capabilities --json
```

如果当前 topic 还在 Claude session 上，这个命令返回的就是 Claude 的 live capabilities。要查 Copilot 等另一个 Agent 的能力，使用 `agent capabilities --agent <agent>` probe，不要凭记忆猜 id。

`humming session models` / `humming session modes` / `humming session permissions` 是同一次 live 查询结果的投影，与 `agent models`/`agent modes`/`agent permissions`（probe 结果的投影）共享同一套格式化逻辑，但数据源始终不同。

返回会尽量保持 ACP 原生结构：

- `models`: ACP `SessionModelState`，包含 `currentModelId` / `availableModels`。
- `modes`: ACP `SessionModeState`，包含 `currentModeId` / `availableModes`。
- `configOptions`: ACP `SessionConfigOption[]`。
- `bridgePermissionModes` / `bridgePermissionMode`: humming 自己的 permission-card 策略，不是 ACP 原生字段。

设置会话配置时用具名选项，而不是整段 JSON：

```bash
humming session configure \
  --model "<models.availableModels[].modelId>" \
  --mode "<modes.availableModes[].id>" \
  --config "<boolean-config-id>=true" \
  --config "<select-config-id>=<select-option-value>" \
  --permission alwaysAsk
```

字段含义：

- `--model` → ACP `session/set_model`（unstable）；传 `auto` 表示清除显式 model 覆盖。
- `--mode` → ACP `session/set_mode`。
- `--config <id=value>` → ACP `session/set_config_option`；取值为 `true`/`false` 会被识别成 boolean 类型，其它字符串按 select 类型的 `{ "value": "..." }` 处理。可重复传多个 `--config`。
- `--permission` → humming 本地处理 ACP `requestPermission` 的策略：`alwaysAsk` / `alwaysAllow` / `alwaysDeny`。

成功后 Humming 会发送「会话配置已更新」通知；会话正在运行时，通知会回复到当前 topic 的最近消息；会话未运行时，通知会直接发到 chat，下一条消息按已保存的配置启动或恢复。

注意：ACP 没有统一的全局 permission mode。Claude Code / Copilot 等 agent 可能把"plan / edit automatically / bypass permission"暴露成 mode，也可能暴露成 config option；以 `session capabilities` 的 live 返回为准，不要硬编码。

#### 只发消息，不改变会话配置

```bash
humming session send --message "Fix the failing test"
humming session send --message-file /absolute/path/to/task.md
humming session send --message-stdin < /absolute/path/to/task.md
```

`session send` 只在完全不需要变更会话配置时使用。如果 session 正忙，Humming 会在内部排队投递；如果已有一份校验通过的待应用配置变更，这条消息不会插队到它前面。若同一个用户请求既要改配置又要发消息，请使用上面的 `session configure --message...`，确保配置生效后再发送消息。

为了避免每轮 prompt 携带大段知识，bridge 会在 `~/.humming/AGENTS.md` 和 `~/.humming/CLAUDE.md` 写入完整操作指引；会话内只注入一句短提示，让 Agent 在需要修改 Humming 配置时先读这些文件。

### 配置文件

CLI 读取一份配置文件（默认 `~/.humming/settings.json`），里面包含凭据和运行时默认值。优先级：CLI flag > 环境变量 > 配置文件 > 内置默认。

完整字段（都可选）：

```jsonc
{
  "credentials": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  "dataDir": "./var/humming",
  "runtime": {
    "cwd": "/work/project",
    "agent": "claude",
    "idleTimeoutMinutes": 1440,
    "maxChats": 10,
    "hideThoughts": false,
    "hideTools": false,
    "hideCancelButton": false,
    "permissionMode": "alwaysAsk",
    "lifecycleNotifyChatIds": ["oc_xxx"], // 可选：start/stop/restart 生命周期通知目标会话
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

凭据可以通过 `humming setup` 扫码生成并写入文件，也可以用环境变量代替文件：`HUMMING_APP_ID` / `HUMMING_APP_SECRET`。

`humming agent list` 会列出当前配置下所有可用的预设，并标出来源（`[built-in]` / `[user]` / `[overridden]`）。

> 推荐使用 `humming setup` 一键扫码创建应用。只有在扫码流程不可用、或你需要复用已有自建应用时，才需要到飞书开放平台 [开发者后台](https://open.larksuite.com/app) 手动创建应用，从「凭证与基础信息」页拿 `App ID` / `App Secret`；在「事件与回调」里把订阅模式切到 **长连接 (WebSocket)**。具体步骤见下文「飞书开发者后台配置」。

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

把 `App ID` / `App Secret` 填到 `settings.json`（或环境变量 `HUMMING_APP_ID` / `HUMMING_APP_SECRET`），运行：

```bash
humming bridge run --agent claude
```

然后在飞书里搜到这个机器人、单聊或拉到群里直接发消息即可。

### 配置示例

#### 最小配置（仅写一个文件，其它走默认）

```bash
# 1. 准备目录（首次使用时一次性执行）
mkdir -p "$HOME/.humming"

# 2. 写入凭据
cat > "$HOME/.humming/settings.json" <<'EOF'
{
  "credentials": {
    "appId":     "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
EOF
chmod 600 "$HOME/.humming/settings.json"

# 3. 启动桥接
humming bridge run --agent claude
```

#### 完整配置（凭据 + 运行时默认值）

把常用默认值固化到文件，命令行只剩 `bridge run --agent`：

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
humming bridge run --agent claude
```

CLI flag 会临时覆盖文件里的同名项。

#### systemd 托管

想要**开机自启 + 崩溃自愈**，用 systemd 之类的进程管理器托管。注意此时应让 systemd 直接
管前台的 `bridge run`（systemd 自己就是 supervisor，用 `bridge start` 的后台模式反而会和它抢管理权）：

```ini
[Service]
Environment=HUMMING_APP_ID=cli_a1b2c3d4e5f60001
Environment=HUMMING_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ExecStart=/usr/local/bin/humming bridge run --cwd /srv/projects/main --agent claude
Restart=on-failure
```

反之，如果只是想在自己机器上**手动**方便地启停、又不想开着终端，用内置的
`humming bridge start` / `stop` / `restart`（见上文「后台运行与进程管理」）即可，无需 systemd。

### 快速示例

```bash
# 1. 接 Claude Code（最常用）
#    会话自动持久化，重启不丢上下文。
humming bridge run --agent claude

# 2. 接 OpenCode，工作目录指向具体项目
humming bridge run --agent opencode --cwd /work/project

# 3. 接 GitHub Copilot CLI，关掉思考输出
humming bridge run --agent copilot --hide-thoughts

# 4. 自研 ACP server
humming bridge run -- node ./my-acp-server.js --port 9000

# 5. 后台运行 + 管理（不占终端）
humming bridge start --agent claude
humming bridge status
humming bridge logs -f
humming bridge restart
humming bridge stop
```

## 类似的项目

1. golang 版本，实现也很齐全，https://github.com/ri-char/Lark-ACP
2. 另一个node版本，本项目由此重构而来 https://github.com/JiaqiZhang-Dev/humming

### 本实现的不同

1. 经过生产实践上的考虑，对permissionMode添加了代理层的设置
2. 多个消息合并成一个卡片，避免在群聊中消息轰炸
3. 作为库提供，方便二次开发

---

## 参考

- ACP 协议：<https://agentcommunicationprotocol.dev/core-concepts/architecture>
- 飞书开放平台：<https://open.larksuite.com/document/server-docs/getting-started/getting-started>

License: MIT
