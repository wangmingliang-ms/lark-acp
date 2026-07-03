# GitHub Install Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `install.sh` / `install.ps1` (+ matching uninstall scripts) that install the `lark-acp` CLI globally straight from the GitHub fork, plus a README subsection documenting them.

**Architecture:** Each script preflight-checks `git`/`node`/`npm` and Node ≥ 20, then runs `npm install -g "git+https://github.com/<repo>.git#<ref>"`. npm's existing `prepare` hook auto-compiles TypeScript on git installs, so no separate build step is needed. Repo and ref are overridable via `LARK_ACP_REPO` / `LARK_ACP_REF`, defaulting to `wangmingliang-ms/lark-acp` + `main`. Scripts are self-contained so they work identically piped remotely (`curl … | sh`, `irm … | iex`) or run from a local checkout.

**Tech Stack:** POSIX sh, Windows PowerShell 5.1+, npm git-install, Node ≥ 20.

---

## File Structure

- Create: `install.sh` — POSIX installer (Linux/macOS/WSL)
- Create: `uninstall.sh` — POSIX uninstaller
- Create: `install.ps1` — PowerShell installer (Windows)
- Create: `uninstall.ps1` — PowerShell uninstaller
- Modify: `README.md` — add "从 GitHub 安装" subsection after the existing `### 安装与运行` block (around line 42), and add a warning note to the now-broken `npm i -g lark-acp` line.

Notes for the implementer:
- The unscoped npm name `lark-acp` is taken by an **unrelated** package on the public registry, so `npm i -g lark-acp` installs the wrong thing. These scripts are the correct install path.
- `shellcheck` and `pwsh` are **not** installed on the dev machine. POSIX scripts are verified with `sh -n`. The PowerShell parse-check step is optional — skip with a note if `pwsh` is unavailable.
- Prettier does not format `.sh` / `.ps1` files, so no formatting conflict. Only `README.md` must stay prettier-clean (`printWidth: 100`).

---

## Task 1: `install.sh`

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Write the script**

Create `install.sh` with exactly this content:

```sh
#!/bin/sh
# install.sh — install the lark-acp CLI globally straight from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.sh | sh
#   ./install.sh
#
# Overrides (environment variables):
#   LARK_ACP_REPO   GitHub owner/repo   (default: wangmingliang-ms/lark-acp)
#   LARK_ACP_REF    git ref to install  (default: main)
#
# Example:
#   LARK_ACP_REF=v0.2.0 sh install.sh

set -eu

REPO="${LARK_ACP_REPO:-wangmingliang-ms/lark-acp}"
REF="${LARK_ACP_REF:-main}"
MIN_NODE_MAJOR=20

fail() {
  echo "lark-acp install: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git not found. Install git first: https://git-scm.com/downloads"
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= ${MIN_NODE_MAJOR}: https://nodejs.org/"
command -v npm >/dev/null 2>&1 || fail "npm not found. It ships with Node.js: https://nodejs.org/"

node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js >= ${MIN_NODE_MAJOR} required, found $(node --version)."
fi

target="git+https://github.com/${REPO}.git#${REF}"
echo "lark-acp install: installing from ${target} ..."
npm install -g "$target"

if command -v lark-acp >/dev/null 2>&1; then
  echo "lark-acp install: done. Run 'lark-acp --help' to get started."
else
  bin_dir="$(npm prefix -g)/bin"
  echo "lark-acp install: installed, but 'lark-acp' is not on your PATH." >&2
  echo "Add npm's global bin directory to PATH, e.g.:" >&2
  echo "  export PATH=\"${bin_dir}:\$PATH\"" >&2
fi
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x install.sh`

- [ ] **Step 3: Syntax-check**

Run: `sh -n install.sh`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify default-resolution logic without installing**

Run: `sh -c 'REPO="${LARK_ACP_REPO:-wangmingliang-ms/lark-acp}"; REF="${LARK_ACP_REF:-main}"; echo "git+https://github.com/${REPO}.git#${REF}"'`
Expected: `git+https://github.com/wangmingliang-ms/lark-acp.git#main`

Run: `LARK_ACP_REF=v0.2.0 sh -c 'REPO="${LARK_ACP_REPO:-wangmingliang-ms/lark-acp}"; REF="${LARK_ACP_REF:-main}"; echo "git+https://github.com/${REPO}.git#${REF}"'`
Expected: `git+https://github.com/wangmingliang-ms/lark-acp.git#v0.2.0`

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat: add install.sh for GitHub-based global install"
```

---

## Task 2: `uninstall.sh`

**Files:**
- Create: `uninstall.sh`

- [ ] **Step 1: Write the script**

Create `uninstall.sh` with exactly this content:

```sh
#!/bin/sh
# uninstall.sh — remove the globally installed lark-acp CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/uninstall.sh | sh
#   ./uninstall.sh

set -eu

fail() {
  echo "lark-acp uninstall: $1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "npm not found; nothing to uninstall via npm."

echo "lark-acp uninstall: removing global 'lark-acp' ..."
npm rm -g lark-acp
echo "lark-acp uninstall: done."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x uninstall.sh`

- [ ] **Step 3: Syntax-check**

Run: `sh -n uninstall.sh`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add uninstall.sh
git commit -m "feat: add uninstall.sh"
```

---

## Task 3: `install.ps1`

**Files:**
- Create: `install.ps1`

- [ ] **Step 1: Write the script**

Create `install.ps1` with exactly this content:

```powershell
#Requires -Version 5.1
<#
.SYNOPSIS
  Install the lark-acp CLI globally straight from GitHub.
.DESCRIPTION
  Overrides via environment variables:
    LARK_ACP_REPO   GitHub owner/repo   (default: wangmingliang-ms/lark-acp)
    LARK_ACP_REF    git ref to install  (default: main)
.EXAMPLE
  irm https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.ps1 | iex
.EXAMPLE
  ./install.ps1
#>

$ErrorActionPreference = 'Stop'

$repo = if ($env:LARK_ACP_REPO) { $env:LARK_ACP_REPO } else { 'wangmingliang-ms/lark-acp' }
$ref = if ($env:LARK_ACP_REF) { $env:LARK_ACP_REF } else { 'main' }
$minNodeMajor = 20

function Fail($msg) {
  Write-Error "lark-acp install: $msg"
  exit 1
}

foreach ($cmd in 'git', 'node', 'npm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "$cmd not found. Install it first (Node.js >= $minNodeMajor: https://nodejs.org/)."
  }
}

$nodeMajor = [int](node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if ($nodeMajor -lt $minNodeMajor) {
  Fail "Node.js >= $minNodeMajor required, found $(node --version)."
}

$target = "git+https://github.com/$repo.git#$ref"
Write-Host "lark-acp install: installing from $target ..."
npm install -g $target
if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }

if (Get-Command lark-acp -ErrorAction SilentlyContinue) {
  Write-Host "lark-acp install: done. Run 'lark-acp --help' to get started."
}
else {
  $prefix = (npm prefix -g).Trim()
  Write-Warning "lark-acp installed, but 'lark-acp' is not on your PATH."
  Write-Warning "Add npm's global bin directory to PATH: $prefix"
}
```

- [ ] **Step 2: Parse-check (optional — only if pwsh available)**

Run: `command -v pwsh >/dev/null 2>&1 && pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('install.ps1', [ref]\$null, [ref]\$null); Write-Host 'parse ok'" || echo "pwsh not available — skip parse-check (verify on Windows/CI)"`
Expected: `parse ok`, or the skip message.

- [ ] **Step 3: Commit**

```bash
git add install.ps1
git commit -m "feat: add install.ps1 for GitHub-based global install on Windows"
```

---

## Task 4: `uninstall.ps1`

**Files:**
- Create: `uninstall.ps1`

- [ ] **Step 1: Write the script**

Create `uninstall.ps1` with exactly this content:

```powershell
#Requires -Version 5.1
<#
.SYNOPSIS
  Remove the globally installed lark-acp CLI.
.EXAMPLE
  irm https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/uninstall.ps1 | iex
.EXAMPLE
  ./uninstall.ps1
#>

$ErrorActionPreference = 'Stop'

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "lark-acp uninstall: npm not found; nothing to uninstall via npm."
  exit 1
}

Write-Host "lark-acp uninstall: removing global 'lark-acp' ..."
npm rm -g lark-acp
Write-Host "lark-acp uninstall: done."
```

- [ ] **Step 2: Parse-check (optional — only if pwsh available)**

Run: `command -v pwsh >/dev/null 2>&1 && pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('uninstall.ps1', [ref]\$null, [ref]\$null); Write-Host 'parse ok'" || echo "pwsh not available — skip parse-check (verify on Windows/CI)"`
Expected: `parse ok`, or the skip message.

- [ ] **Step 3: Commit**

```bash
git add uninstall.ps1
git commit -m "feat: add uninstall.ps1"
```

---

## Task 5: README "从 GitHub 安装" subsection + broken-npm warning

**Files:**
- Modify: `README.md` (insert new subsection between the `### 安装与运行` block's closing note at line 42 and `### 命令格式` at line 44; annotate the `npm i -g lark-acp` line at ~31)

- [ ] **Step 1: Add a warning note under the existing npm method**

In the `### 安装与运行` fenced `bash` block, change the "方式二" lines from:

```bash
# 方式二：全局安装，得到 `lark-acp` 命令
npm i -g lark-acp
lark-acp --help
```

to:

```bash
# 方式二：从 GitHub 安装（推荐，见下方「从 GitHub 安装」）
#   注意：npm 上的 lark-acp 名称已被无关的包占用，`npm i -g lark-acp` 会装错东西。
lark-acp --help
```

Also change the "方式一" line from:

```bash
# 方式一：npx，免安装直接跑（每次拉取最新发布版）
npx -y lark-acp --help
```

to:

```bash
# 方式一：npx，从 GitHub 免安装直接跑
npx -y "github:wangmingliang-ms/lark-acp" --help
```

- [ ] **Step 2: Insert the new subsection**

Immediately after the blockquote line ending `撤销：\`npm rm -g lark-acp\`。` (line 42) and its following blank line, before `### 命令格式`, insert:

````markdown
### 从 GitHub 安装

npm 官方仓库上的 `lark-acp` 名称已被无关的包占用，直接 `npm i -g lark-acp` 会装错东西。
推荐用下面的脚本直接从本仓库安装（内部走 `npm i -g git+…`，借助 `prepare` 钩子自动编译）：

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
````

- [ ] **Step 3: Verify prettier is happy**

Run: `npx prettier --check README.md`
Expected: `All matched files use Prettier code style!` (or `README.md` listed as already-formatted).

If it reports formatting issues, run `npx prettier --write README.md` and re-check.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document GitHub install scripts, warn about taken npm name"
```

---

## Task 6: Final end-to-end verification (optional, network + global install)

This actually installs `lark-acp` globally from GitHub. Run it only if you want a live smoke test; it requires network access and that `main` on the fork is pushed/reachable.

- [ ] **Step 1: Run the installer from the local checkout**

Run: `./install.sh`
Expected: ends with `lark-acp install: done. Run 'lark-acp --help' to get started.`

- [ ] **Step 2: Confirm the CLI works**

Run: `lark-acp version`
Expected: prints the version (e.g. `0.2.0`) with no error.

- [ ] **Step 3: Uninstall**

Run: `./uninstall.sh`
Expected: ends with `lark-acp uninstall: done.`

- [ ] **Step 4: Confirm removal**

Run: `command -v lark-acp || echo "removed"`
Expected: `removed`

---

## Self-Review Notes

- **Spec coverage:** install.sh (Task 1), install.ps1 (Task 3), uninstall.sh (Task 2), uninstall.ps1 (Task 4), env overrides (baked into Tasks 1 & 3), preflight + Node ≥ 20 (Tasks 1 & 3), dual invocation (usage headers + README Task 5), PATH-hint fallback (Tasks 1 & 3), README subsection (Task 5). All design goals mapped.
- **Beyond-spec addition:** Task 5 Step 1 annotates the existing broken `npm i -g lark-acp` / `npx -y lark-acp` lines — the approved design only mentioned adding a subsection. This corrects a real correctness trap in the file being edited. Flagged to the user at handoff.
- **Consistency:** every script uses the same `git+https://github.com/${REPO}.git#${REF}` target shape, the same `LARK_ACP_REPO` / `LARK_ACP_REF` names and defaults, and the same `MIN_NODE_MAJOR = 20`.
- **No placeholders:** every file's full content is inline.
