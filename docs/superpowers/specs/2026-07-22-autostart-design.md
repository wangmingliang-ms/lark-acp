# Humming 开机自启动模块（autostart）

## 目标

让 Humming 在其**所在操作系统开机时自动启动**。支持两类 OS，各自独立、由 `process.platform` 分派，一次只装当前 OS 的机制：

| OS | 机制 | 触发时机 |
|---|---|---|
| Linux（含 WSL，视为普通 Linux） | systemd user service（持久化 unit + `enable` + `enable-linger`） | 本机启动 |
| Windows | Task Scheduler 任务 | 开机（BootTrigger） |

不做任何跨 OS 联动。WSL 一律当作普通 Linux 处理。

## 模块形态

新增独立模块 `bin/autostart/`（与 `process-control.ts` 平级），导出幂等入口：

```ts
ensureAutostart(homeDir: string): AutostartReport
```

- **幂等**：目标已存在且内容一致 → no-op（report `already-current`）；不同 → 重写并重新加载；不支持的平台 → 跳过并说明原因。
- **调用点**：
  - `humming init` 末尾调用一次。
  - `humming update` 末尾调用一次。
  - 新增 CLI 子命令 `humming autostart` 手动调用（内部即 `ensureAutostart`）。

结果用 discriminated union：
```ts
type AutostartReport =
  | { kind: "installed"; mechanism: "systemd" | "windows-task"; path: string }
  | { kind: "already-current"; mechanism: "systemd" | "windows-task"; path: string }
  | { kind: "skipped"; reason: string };
```

## 环境探测 → 分派

```ts
detectAutostartTarget(): "systemd" | "windows-task" | { unsupported: string }
```

- `process.platform === "win32"` → `windows-task`。
- `process.platform === "linux"` 且 `isUserSystemdAvailable()` → `systemd`。
- 其它（macOS、Linux 无 user-systemd）→ unsupported，附原因。

复用 `process-control.ts` 已有的 `isUserSystemdAvailable()` 与 `gatewayUnitName(homeDir)`。

## 安装器 A：Linux — systemd user service（持久化）

写 `~/.config/systemd/user/<gatewayUnitName>.service`：

```ini
[Unit]
Description=Humming gateway
After=network-online.target

[Service]
Type=simple
ExecStart=<abs humming> gateway run [--agent <default>]
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

步骤：
1. 解析 humming 绝对路径（`process.execPath` + 入口脚本，或 `readlink -f $(which humming)`）。
2. `--agent` 默认值取 `settings.json` 的 `runtime.agent`；缺省则不写 `--agent`。
3. 写 unit 文件（内容变化才写）。
4. `systemctl --user daemon-reload`
5. `systemctl --user enable <unit>`
6. `loginctl enable-linger $USER`（无交互登录也随本机启动）

> 现有 `startGatewayWithSystemd` 是 transient（`systemd-run --collect`，一次性），与此处"持久化 unit + enable"不同，仅共用 unit 名 `gatewayUnitName(homeDir)`。

## 安装器 B：Windows — Task Scheduler（开机触发）

参照本机已验证可用的 "Copilot API Watchdog" 任务，用 `schtasks.exe`（或 `Register-ScheduledTask`）注册：

- **触发器**：`BootTrigger`（开机）。
- **动作**：`pwsh.exe -NoExit -File "<home>\autostart\humming-autostart.ps1"`，`.ps1` 主体为 `humming gateway start`。
- **Principal**：当前用户身份 + `StartWhenAvailable`。
- 任务名固定，如 `Humming Gateway Autostart`。

> 注：BootTrigger 任务在无人登录时以非交互会话运行；Humming gateway 为后台进程，无桌面依赖，可接受。

幂等：`schtasks /query /tn <name>` 判断存在；已存在但定义不同 → `/delete` 后 `/create`。

## 卸载

本轮只做 `ensure`（安装/更新）。卸载（`--remove`）YAGNI，暂缓。

## 测试

白箱单测 `bin/autostart/*.test.ts`：
- `detectAutostartTarget` 在各 `platform`/systemd 组合下的分派。
- unit 文件 / ps1 / 任务 XML 的**内容生成函数**为 pure function，断言渲染文本。
- 幂等：已存在且一致 → `already-current`，不触发写。
- systemctl / schtasks / fs 副作用通过注入可替换执行器打桩，不真跑。

## 验收

1. `tsc --noEmit` / `vitest run` 全绿。
2. Linux 上 `humming autostart` → 生成 unit，`systemctl --user is-enabled <unit>` 为 enabled，`loginctl show-user $USER` 显示 `Linger=yes`。
3. 幂等：连续两次 `humming autostart`，第二次 report 为 `already-current`。
4. `humming init` / `humming update` 末尾能触发同样安装。
