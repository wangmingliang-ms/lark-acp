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
