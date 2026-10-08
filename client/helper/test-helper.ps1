<#
.SYNOPSIS
  Integration smoke test for GhostHelper.exe.

.DESCRIPTION
  Launches the helper with a redirected stdin/stdout pipe, sends a set of SAFE
  commands (nothing that changes system state), checks the responses, and prints
  a pass/fail summary. Exit code is 0 when every check passed, 1 otherwise.

  Safety: this script never changes volume, never closes/kills other processes,
  never locks/sleeps the PC and never turns the display off. It only reads state.

.PARAMETER Exe
  Path to GhostHelper.exe. Defaults to bin\Release\ or ..\resources\helper\.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Exe) {
    $candidates = @(
        (Join-Path $here 'bin\Release\GhostHelper.exe'),
        (Join-Path $here '..\resources\helper\GhostHelper.exe')
    )
    $Exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Exe -or -not (Test-Path $Exe)) {
    Write-Error "GhostHelper.exe not found. Build it first (build-helper.ps1)."
    exit 2
}
$Exe = (Resolve-Path $Exe).Path
Write-Host "Using helper: $Exe" -ForegroundColor Cyan

# ---- launch with redirected pipes ----
$utf8 = New-Object System.Text.UTF8Encoding($false)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.Arguments = "--parent $PID"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = $utf8
$psi.StandardErrorEncoding = $utf8

$proc = [System.Diagnostics.Process]::Start($psi)

# Collect stdout/stderr lines asynchronously (responses may arrive out of order).
$outQueue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
$errQueue = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
$outSub = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $outQueue -Action {
    if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
}
$errSub = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $errQueue -Action {
    if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
}
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

$responses = @{}   # id -> parsed object
$noId = New-Object System.Collections.Generic.List[object]

function Pump {
    $line = $null
    while ($outQueue.TryDequeue([ref]$line)) {
        try { $obj = $line | ConvertFrom-Json } catch { continue }
        if ($null -ne $obj.id) { $responses[[int]$obj.id] = $obj }
        else { $noId.Add($obj) }
    }
}

function Send-Cmd([int]$id, [string]$cmd, $arguments) {
    $req = @{ id = $id; cmd = $cmd }
    if ($null -ne $arguments) { $req.args = $arguments }
    $json = ($req | ConvertTo-Json -Compress -Depth 6)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.BaseStream.Flush()
}

function Wait-Response([int]$id, [int]$timeoutMs = 8000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        Pump
        if ($responses.ContainsKey($id)) { return $responses[$id] }
        Start-Sleep -Milliseconds 40
    }
    Pump
    if ($responses.ContainsKey($id)) { return $responses[$id] }
    return $null
}

function Send-Raw([string]$text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text + "`n")
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.BaseStream.Flush()
}

$results = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [bool]$pass, [string]$detail) {
    $results.Add([pscustomobject]@{ Name = $name; Pass = $pass; Detail = $detail })
    $tag = if ($pass) { "[ OK ]" } else { "[FAIL]" }
    $color = if ($pass) { 'Green' } else { 'Red' }
    Write-Host ("{0} {1,-22} {2}" -f $tag, $name, $detail) -ForegroundColor $color
}

try {
    # 1) ping
    Send-Cmd 1 'ping' $null
    $r = Wait-Response 1
    Check 'ping' ($r -and $r.ok -and $r.data.version) ("version=" + $r.data.version + " pid=" + $r.data.pid)

    # 2) selftest
    Send-Cmd 2 'selftest' $null
    $r = Wait-Response 2
    Check 'selftest' ($r -and $r.ok) ("audio=" + $r.data.audio + " windows=" + $r.data.windows + " startapps=" + $r.data.startapps + " registry=" + $r.data.registry + " nic=" + $r.data.nic)

    # 3) volume.get (READ ONLY - never changed)
    Send-Cmd 3 'volume.get' $null
    $r = Wait-Response 3
    Check 'volume.get' ($r -and $r.ok -and ($null -ne $r.data.level)) ("level=" + $r.data.level + " muted=" + $r.data.muted)

    # 4) windows.list
    Send-Cmd 4 'windows.list' $null
    $r = Wait-Response 4
    $wc = if ($r -and $r.ok) { @($r.data).Count } else { 0 }
    Check 'windows.list' ($r -and $r.ok -and $wc -ge 1) ("$wc window(s)")

    # 5) startapps.list (checks Cyrillic/UTF-8 round-trips)
    Send-Cmd 5 'startapps.list' $null
    $r = Wait-Response 5
    $sc = if ($r -and $r.ok) { @($r.data).Count } else { 0 }
    $cyr = $false
    if ($r -and $r.ok) { foreach ($i in $r.data) { if ($i.name -match '[\u0400-\u04FF]') { $cyr = $true; break } } }
    Check 'startapps.list' ($r -and $r.ok -and $sc -ge 1) ("$sc app(s); cyrillic-name-seen=$cyr")

    # 6) registry.read of an existing key
    Send-Cmd 6 'registry.read' @{ hive = 'HKLM'; path = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion'; name = 'ProductName' }
    $r = Wait-Response 6
    Check 'registry.read' ($r -and $r.ok -and $r.data.value) ("ProductName=" + $r.data.value)

    # 7) nic.info
    Send-Cmd 7 'nic.info' $null
    $r = Wait-Response 7
    $nc = if ($r -and $r.ok) { @($r.data).Count } else { 0 }
    Check 'nic.info' ($r -and $r.ok -and $nc -ge 1) ("$nc adapter(s)")

    # 8) process.list under C:\Windows
    Send-Cmd 8 'process.list' @{ underDirs = @('C:\Windows'); exes = @() }
    $r = Wait-Response 8
    $pc = if ($r -and $r.ok) { @($r.data).Count } else { 0 }
    Check 'process.list' ($r -and $r.ok -and $pc -ge 1) ("$pc process(es) under C:\Windows")

    # 9) unknown command -> error, process survives
    Send-Cmd 9 'no.such.command' $null
    $r = Wait-Response 9
    Check 'unknown-command' ($r -and (-not $r.ok) -and $r.code -eq 'unknown-command') ("code=" + $r.code)

    # 10) malformed JSON -> must not crash the process
    Send-Raw 'this is not json {'
    Start-Sleep -Milliseconds 150
    Send-Cmd 11 'ping' $null
    $r = Wait-Response 11
    Check 'survives-bad-json' ($r -and $r.ok) ("helper still responding after bad input")

}
finally {
    # ---- clean shutdown: close stdin -> helper exits on EOF ----
    try { $proc.StandardInput.Close() } catch {}
    if (-not $proc.WaitForExit(3000)) {
        try { $proc.Kill() } catch {}
    }
    try { Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue } catch {}
    try { Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue } catch {}

    $errLine = $null
    $stderr = New-Object System.Text.StringBuilder
    while ($errQueue.TryDequeue([ref]$errLine)) { [void]$stderr.AppendLine($errLine) }
    if ($VerbosePreference -eq 'Continue' -and $stderr.Length -gt 0) {
        Write-Host "--- helper stderr ---" -ForegroundColor DarkGray
        Write-Host $stderr.ToString() -ForegroundColor DarkGray
    }
}

$passed = ($results | Where-Object { $_.Pass }).Count
$total = $results.Count
$summaryColor = if ($passed -eq $total) { 'Green' } else { 'Red' }
Write-Host ""
Write-Host ("Summary: {0}/{1} checks passed." -f $passed, $total) -ForegroundColor $summaryColor

if ($passed -eq $total) { exit 0 } else { exit 1 }
