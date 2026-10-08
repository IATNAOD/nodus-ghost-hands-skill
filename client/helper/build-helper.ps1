<#
.SYNOPSIS
  Builds GhostHelper.exe and copies it into client\resources\helper\.

.DESCRIPTION
  Default path: `dotnet build -c Release` (net48 via the build-only
  Microsoft.NETFramework.ReferenceAssemblies package), then copies the produced
  GhostHelper.exe to ..\resources\helper\GhostHelper.exe.

  Returns a non-zero exit code on any failure.

.PARAMETER UseCsc
  Fallback build with the in-box C# compiler
  (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe).
  NOT SUPPORTED: that compiler is C# 5 only, and this project uses C# 7+
  features (pattern matching, out-var, expression-bodied members, etc.).
  The switch exists so the contract is explicit; it reports the limitation
  and exits non-zero. See README.md.
#>
[CmdletBinding()]
param([switch]$UseCsc)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csproj = Join-Path $here 'GhostHelper.csproj'
$builtExe = Join-Path $here 'bin\Release\GhostHelper.exe'
$resourcesDir = Join-Path $here '..\resources\helper'
$targetExe = Join-Path $resourcesDir 'GhostHelper.exe'

function Fail($msg) {
    Write-Host "BUILD FAILED: $msg" -ForegroundColor Red
    exit 1
}

if ($UseCsc) {
    Write-Host "The -UseCsc fallback is NOT supported." -ForegroundColor Yellow
    Write-Host "csc.exe (v4.0.30319) targets C# 5, but GhostHelper uses C# 7+ language" -ForegroundColor Yellow
    Write-Host "features. Build with the .NET SDK instead: run this script without -UseCsc." -ForegroundColor Yellow
    exit 1
}

Write-Host "Building GhostHelper (dotnet build -c Release)..." -ForegroundColor Cyan
& dotnet build -c Release $csproj
if ($LASTEXITCODE -ne 0) { Fail "dotnet build returned exit code $LASTEXITCODE." }

if (-not (Test-Path $builtExe)) { Fail "Expected output not found: $builtExe" }

# Ensure the resources\helper destination exists, then copy.
if (-not (Test-Path $resourcesDir)) {
    New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
}
Copy-Item -Path $builtExe -Destination $targetExe -Force
if (-not (Test-Path $targetExe)) { Fail "Copy to $targetExe failed." }

$full = (Resolve-Path $targetExe).Path
Write-Host "OK: GhostHelper.exe -> $full" -ForegroundColor Green
exit 0
