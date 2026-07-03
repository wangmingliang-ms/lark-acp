# GitHub Install Scripts — Design

Date: 2026-07-03

> **Revision (2026-07-03, post-implementation):** The original mechanism below —
> `npm i -g git+https://…`, relying on npm's `prepare` hook to build — was found
> during live end-to-end testing to fail on npm 11.12.1. npm runs the git
> dependency's `prepare` build inside a sandbox whose `node_modules/.bin/tsc` is
> not executable, so the build dies with `tsc: Permission denied` (exit 127).
> This reproduced 100% of the time and was independent of npm cache state, umask,
> and prepare flags; a manual `git clone` + `npm install` + `npm run build`
> always succeeded. The install scripts were therefore changed to **clone into a
> temp dir → `npm install` → `npm run build` → `npm install -g --install-links .`
> → clean up the temp dir**. `--install-links` is required so npm copies the
> package instead of symlinking it into the soon-deleted temp dir. Sections below
> describe the original design; the clone+build mechanism is the shipped one.

## Problem

Users want a one-liner to install the `lark-acp` CLI directly from the GitHub
repository, on both Unix-like systems (sh) and Windows (PowerShell).

The unscoped npm name `lark-acp` is **already taken on the public registry by an
unrelated package** (npm shows `lark-acp@1.0.1`, which is not this project). So
`npm i -g lark-acp` installs the wrong package. Installing straight from the
GitHub repo bypasses the registry and is the correct distribution path for now.

npm's `prepare` lifecycle script (already present in `package.json` as
`npm run build`) runs automatically when installing from a git URL, so the
TypeScript sources compile and the `lark-acp` bin is linked with no extra steps.

## Goals

- One-command install from GitHub, no manual clone/build required.
- Works both piped remotely (`curl … | sh`) and run locally from a checkout.
- Cross-platform: POSIX `sh` + Windows PowerShell.
- Symmetric uninstall scripts.
- Clear, actionable errors when prerequisites are missing.

## Non-goals (YAGNI)

- Auto-installing Node/npm/git (only detect and error).
- Clone + build + link fallback (npm-from-git is sufficient).
- Shell-completion setup.
- Publishing to the npm registry.

## Configuration

Defaults baked to the fork, overridable via environment variables:

| Variable        | Default                     | Meaning                        |
| --------------- | --------------------------- | ------------------------------ |
| `LARK_ACP_REPO` | `wangmingliang-ms/lark-acp` | GitHub `owner/repo` to install |
| `LARK_ACP_REF`  | `main`                      | git branch or tag to install   |

Install target URL:
`git+https://github.com/${LARK_ACP_REPO}.git#${LARK_ACP_REF}`

## Deliverables

Four files in the repository root:

- `install.sh` — POSIX sh (Linux / macOS / WSL)
- `install.ps1` — Windows PowerShell
- `uninstall.sh` — POSIX sh
- `uninstall.ps1` — Windows PowerShell

Plus a short "Install from GitHub" subsection added to `README.md`.

## `install.sh` behavior

1. `set -eu`; define a `fail()` helper that prints to stderr and exits non-zero.
2. Preflight checks (each failure explains what is missing and how to fix it):
   - `git`, `node`, `npm` present on PATH.
   - Node major version `>= 20` (matches `engines.node` in `package.json`).
3. Resolve `LARK_ACP_REPO` / `LARK_ACP_REF` from env, applying defaults.
4. Run `npm install -g "git+https://github.com/${REPO}.git#${REF}"`.
5. Post-install verification:
   - If `lark-acp` resolves on PATH, print a success line.
   - Otherwise, print the npm global bin dir (`npm bin -g` / `npm prefix -g`)
     and a hint to add it to PATH.

## `install.ps1` behavior

Mirror of `install.sh`:

- `$ErrorActionPreference = 'Stop'`.
- Reads `$env:LARK_ACP_REPO` / `$env:LARK_ACP_REF` with the same defaults.
- Same preflight checks via `Get-Command`.
- Same `npm install -g …` invocation.
- Same PATH-hint fallback using the Windows npm global bin location.

## Uninstall scripts

Both run the preflight for `npm`, print a one-line notice, then:

`npm rm -g lark-acp`

## Invocation

Remote:

```sh
curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.ps1 | iex
```

Local (from a checkout):

```sh
./install.sh
```

```powershell
./install.ps1
```

Override examples:

```sh
LARK_ACP_REF=v0.2.0 sh install.sh
LARK_ACP_REPO=4t145/lark-acp sh install.sh
```

## Error handling

- `sh`: `set -eu` + explicit preflight guards; every guard prints a remedy.
- `pwsh`: `$ErrorActionPreference = 'Stop'`; `Get-Command` guards with remedies.
- The "global bin not on PATH" case is detected and the exact fix is printed
  (an `export PATH=…` line for sh, the equivalent for PowerShell).

## Testing / verification

Manual, since these are environment scripts:

- `sh -n install.sh` / `sh -n uninstall.sh` for syntax.
- `pwsh -NoProfile -Command "..."` parse check for the `.ps1` files.
- End-to-end on this machine: run `install.sh`, confirm `lark-acp --help`
  works, then `uninstall.sh` and confirm the command is gone.
