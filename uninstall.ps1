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
  Write-Host "lark-acp uninstall: npm not found; nothing to uninstall via npm."
  exit 1
}

Write-Host "lark-acp uninstall: removing global 'lark-acp' ..."
npm rm -g lark-acp
if ($LASTEXITCODE -ne 0) {
  Write-Host "lark-acp uninstall: npm rm failed (exit $LASTEXITCODE)."
  exit 1
}
Write-Host "lark-acp uninstall: done."
