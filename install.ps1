#Requires -Version 5.1
<#
.SYNOPSIS
  Install the lark-acp CLI globally straight from GitHub.
.DESCRIPTION
  Overrides via environment variables:
    LARK_ACP_REPO   GitHub owner/repo   (default: wangmingliang-ms/lark-acp)
    LARK_ACP_REF    git ref to install  (default: main)

  Why clone+build instead of `npm i -g git+https://...`:
    npm's git-dependency prepare sandbox runs this package's `prepare` build
    (tsc) against a node_modules whose .bin/tsc is not executable, so the build
    dies with "tsc: Permission denied". Cloning and building in a normal working
    directory sidesteps that sandbox entirely.
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

# Clone into a temp dir, build there, install a real copy globally, then clean up.
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lark-acp-install-" + [System.IO.Path]::GetRandomFileName())
$repoDir = Join-Path $workDir 'lark-acp'
$cloneUrl = "https://github.com/$repo.git"

try {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null

  Write-Host "lark-acp install: cloning $cloneUrl (ref: $ref) ..."
  git clone --depth 1 --branch $ref $cloneUrl $repoDir
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed for $cloneUrl (ref: $ref)." }

  Push-Location $repoDir
  try {
    Write-Host "lark-acp install: installing dependencies ..."
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

    Write-Host "lark-acp install: building ..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "build failed." }

    # --install-links forces npm to copy the package instead of symlinking it
    # into the temp dir (which the finally block removes). Without it the global
    # bin would dangle the moment this script finishes.
    Write-Host "lark-acp install: installing globally ..."
    npm install -g --install-links .
    if ($LASTEXITCODE -ne 0) { Fail "global install failed." }
  }
  finally {
    Pop-Location
  }
}
finally {
  if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir }
}

if (Get-Command lark-acp -ErrorAction SilentlyContinue) {
  Write-Host "lark-acp install: done. Run 'lark-acp --help' to get started."
}
else {
  $prefix = (npm prefix -g).Trim()
  Write-Warning "lark-acp installed, but 'lark-acp' is not on your PATH."
  Write-Warning "Add npm's global bin directory to PATH: $prefix"
}
