#Requires -Version 5.1
<#
.SYNOPSIS
  Install the humming CLI globally straight from GitHub.
.DESCRIPTION
  Overrides via environment variables:
    HUMMING_REPO   GitHub owner/repo   (default: wangmingliang-ms/humming)
    HUMMING_REF    git branch or tag   (default: main)

  Why clone+build instead of `npm i -g git+https://...`:
    npm's git-dependency prepare sandbox runs this package's `prepare` build
    (tsc) against a node_modules whose .bin/tsc is not executable, so the build
    dies with "tsc: Permission denied". Cloning and building in a normal working
    directory sidesteps that sandbox entirely.
.EXAMPLE
  irm https://raw.githubusercontent.com/wangmingliang-ms/humming/main/install.ps1 | iex
.EXAMPLE
  ./install.ps1
#>

$ErrorActionPreference = 'Stop'

$repo = if ($env:HUMMING_REPO) { $env:HUMMING_REPO } else { 'wangmingliang-ms/humming' }
$ref = if ($env:HUMMING_REF) { $env:HUMMING_REF } else { 'main' }
$minNodeMajor = 20

function Fail($msg) {
  # Write-Host (not Write-Error) so a piped `irm | iex` run prints a clean
  # one-line message and exits with code 1, instead of a red terminating-error
  # record that the interactive host may swallow.
  Write-Host "humming install: $msg"
  exit 1
}

$tools = [ordered]@{
  git  = 'Install git first: https://git-scm.com/downloads'
  node = "Install Node.js >= ${minNodeMajor}: https://nodejs.org/"
  npm  = 'npm ships with Node.js: https://nodejs.org/'
}
foreach ($cmd in $tools.Keys) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "$cmd not found. $($tools[$cmd])"
  }
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $minNodeMajor) {
  Fail "Node.js >= $minNodeMajor required, found $(node --version)."
}

# Clone into a temp dir, build there, install a real copy globally, then clean up.
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("humming-install-" + [System.IO.Path]::GetRandomFileName())
$repoDir = Join-Path $workDir 'humming'
$cloneUrl = "https://github.com/$repo.git"

try {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null

  Write-Host "humming install: cloning $cloneUrl (ref: $ref) ..."
  git clone --depth 1 --branch $ref $cloneUrl $repoDir
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed for $cloneUrl (ref: $ref)." }

  Push-Location $repoDir
  try {
    Write-Host "humming install: installing dependencies ..."
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

    Write-Host "humming install: building ..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "build failed." }

    # --install-links forces npm to copy the package instead of symlinking it
    # into the temp dir (which the finally block removes). Without it the global
    # bin would dangle the moment this script finishes.
    Write-Host "humming install: installing globally ..."
    npm install -g --install-links .
    if ($LASTEXITCODE -ne 0) { Fail "global install failed." }

    Write-Host "humming install: initializing ~/.humming templates ..."
    node dist/bin/humming.js init
    if ($LASTEXITCODE -ne 0) { Fail "humming init failed." }
  }
  finally {
    Pop-Location
  }
}
finally {
  # -ErrorAction SilentlyContinue so a delete failure (e.g. a deep node_modules
  # path exceeding MAX_PATH on Windows PowerShell 5.1) cannot mask the original
  # error or abort a successful install; a leftover temp dir is harmless.
  if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue }
}

if (Get-Command humming -ErrorAction SilentlyContinue) {
  Write-Host "humming install: done. Run 'humming --help' to get started."
}
else {
  $prefix = (npm prefix -g).Trim()
  Write-Warning "humming installed, but 'humming' is not on your PATH."
  Write-Warning "Add npm's global bin directory to PATH: $prefix"
}
