[CmdletBinding()]
param([string]$InstallRoot)

$ErrorActionPreference = "Stop"
$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolver = Join-Path $launcherRoot "resolve-ai-aligner-install.ps1"
if (-not (Test-Path -LiteralPath $resolver)) {
    throw "The installation locator is missing."
}
. $resolver
$resolvedInstallRoot = Resolve-AiAlignerInstallRoot -LauncherRoot $launcherRoot -RequestedRoot $InstallRoot
if ([string]::IsNullOrWhiteSpace($resolvedInstallRoot)) {
    throw "No complete LRC Editor AI Aligner installation was found."
}
$locationRegistry = Get-AiAlignerLocationRegistry
$driveRoot = [System.IO.Path]::GetPathRoot($resolvedInstallRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$userProfile = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath("UserProfile")).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar
)
if (
    [string]::IsNullOrWhiteSpace($resolvedInstallRoot) -or
    $resolvedInstallRoot.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolvedInstallRoot.Equals($userProfile, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath (Join-Path $resolvedInstallRoot "install-state.json")) -or
    -not (Test-Path -LiteralPath (Join-Path $resolvedInstallRoot "engine"))
) {
    throw "This directory is not a verified LRC Editor AI Aligner installation: $resolvedInstallRoot"
}

Write-Host "LRC Editor AI Aligner will be permanently removed." -ForegroundColor Yellow
Write-Host "Directory: $resolvedInstallRoot"
Write-Host "This deletes the engine, models, private Python/CUDA runtime, settings, and task data."
Write-Host "FFmpeg and package-manager prerequisites installed outside this directory are not removed."
Write-Host ""
$firstConfirmation = Read-Host "First confirmation: type UNINSTALL"
if ($firstConfirmation -cne "UNINSTALL") {
    Write-Host "Uninstall cancelled."
    exit 0
}
$secondConfirmation = Read-Host "Second confirmation: type the complete directory shown above"
$normalizedConfirmation = $secondConfirmation.Trim().Trim('"')
if (-not $normalizedConfirmation.Equals($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "The directory did not match. Uninstall cancelled."
    exit 0
}

$stopScript = Join-Path $resolvedInstallRoot "stop-ai-aligner.ps1"
if (Test-Path -LiteralPath $stopScript) {
    & $stopScript -InstallRoot $resolvedInstallRoot -Quiet
}
Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
if (Test-Path -LiteralPath $resolvedInstallRoot) {
    throw "Some files could not be removed from $resolvedInstallRoot"
}
foreach ($locationFile in @((Join-Path $launcherRoot "install-location.txt"), $locationRegistry)) {
    if (Test-Path -LiteralPath $locationFile) {
        $recordedRoot = (Get-Content -LiteralPath $locationFile -Raw).Trim()
        if ($recordedRoot.Equals($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            [System.IO.File]::Delete($locationFile)
        }
    }
}
Write-Host "LRC Editor AI Aligner was removed." -ForegroundColor Green
