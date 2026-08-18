[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolver = Join-Path $launcherRoot "resolve-ai-aligner-install.ps1"
if (-not (Test-Path -LiteralPath $resolver)) {
    throw "The installation locator is missing."
}
. $resolver
$resolvedInstallRoot = Resolve-AiAlignerInstallRoot -LauncherRoot $launcherRoot -RequestedRoot $InstallRoot
if ([string]::IsNullOrWhiteSpace($resolvedInstallRoot)) {
    Write-Host "No complete LRC Editor AI Aligner installation was found."
    exit 0
}
$pidPath = Join-Path $resolvedInstallRoot "runtime\service.pid"
$ports = @(8765) + @(8876..8895)

function Test-AlignedProcess {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }
    $commandLine = [string]$process.CommandLine
    $executablePath = [string]$process.ExecutablePath
    $trustedPrefix = $resolvedInstallRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
        [System.IO.Path]::DirectorySeparatorChar
    return $commandLine.IndexOf("lrc_editor_companion_server", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $executablePath.StartsWith($trustedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

$candidates = [System.Collections.Generic.List[int]]::new()
if (Test-Path -LiteralPath $pidPath) {
    $storedId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$storedId)) {
        $candidates.Add($storedId)
    }
}
foreach ($connection in Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue) {
    if (-not $candidates.Contains([int]$connection.OwningProcess)) {
        $candidates.Add([int]$connection.OwningProcess)
    }
}

$serviceProcessId = $null
foreach ($candidate in $candidates) {
    if (Test-AlignedProcess -ProcessId $candidate) {
        $serviceProcessId = $candidate
        break
    }
}

if ($null -eq $serviceProcessId) {
    if (Test-Path -LiteralPath $pidPath) {
        [System.IO.File]::Delete($pidPath)
    }
    if (-not $Quiet) {
        Write-Host "LRC Editor AI Aligner is not running." -ForegroundColor Yellow
    }
    return
}

Stop-Process -Id $serviceProcessId
for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    if ($null -eq (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 200
}
if ($null -ne (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $serviceProcessId -Force
}
if (Test-Path -LiteralPath $pidPath) {
    [System.IO.File]::Delete($pidPath)
}
if (-not $Quiet) {
    Write-Host "LRC Editor AI Aligner stopped." -ForegroundColor Green
}
