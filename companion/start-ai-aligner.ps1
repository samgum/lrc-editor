[CmdletBinding()]
param(
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolver = Join-Path $launcherRoot "resolve-ai-aligner-install.ps1"
if (-not (Test-Path -LiteralPath $resolver)) {
    throw "The installation locator is missing. Download the complete companion package again."
}
. $resolver
$resolvedInstallRoot = Resolve-AiAlignerInstallRoot -LauncherRoot $launcherRoot -RequestedRoot $InstallRoot
if ([string]::IsNullOrWhiteSpace($resolvedInstallRoot)) {
    $installer = Join-Path $launcherRoot "install-ai-aligner.ps1"
    if (-not (Test-Path -LiteralPath $installer)) {
        throw "No complete LRC Editor AI Aligner installation was found. Download the complete release package first."
    }
    Write-Host "No complete LRC Editor AI Aligner installation was found." -ForegroundColor Yellow
    $installNow = Read-Host "Install it now, then start the service? [Y/n]"
    if ($installNow -match "^[Nn]$") {
        Write-Host "Start cancelled."
        exit 0
    }
    & $installer
    $resolvedInstallRoot = Resolve-AiAlignerInstallRoot -LauncherRoot $launcherRoot
    if ([string]::IsNullOrWhiteSpace($resolvedInstallRoot)) {
        throw "Installation completed without a usable location record."
    }
}
$engineRoot = Join-Path $resolvedInstallRoot "engine"
$environmentRoot = Join-Path $resolvedInstallRoot "environment"
$modelRoot = Join-Path $resolvedInstallRoot "models"
$venvPython = Join-Path $environmentRoot "Scripts\python.exe"
$companionServer = Join-Path $resolvedInstallRoot "lrc_editor_companion_server.py"
$ports = @(8765) + @(8876..8895)

function Add-PrivateNvidiaRuntimePath {
    $sitePackages = Join-Path $environmentRoot "Lib\site-packages\nvidia"
    foreach ($privatePath in @(
        (Join-Path $sitePackages "cublas\bin"),
        (Join-Path $sitePackages "cudnn\bin")
    )) {
        if (Test-Path -LiteralPath $privatePath) {
            $env:Path = "$privatePath;$env:Path"
        }
    }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "The AI aligner is not installed at $resolvedInstallRoot. Run install-ai-aligner.cmd first."
}
if (-not (Test-Path -LiteralPath (Join-Path $engineRoot "src\lyrics_aligner\server.py"))) {
    throw "The installed alignment engine is incomplete. Run install-ai-aligner.cmd again."
}
if (-not (Test-Path -LiteralPath $companionServer)) {
    throw "The LRC Editor companion service is missing. Run install-ai-aligner.cmd again."
}
if ($null -eq (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or
    $null -eq (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    throw "FFmpeg is not available. Run install-ai-aligner.cmd again."
}

function Get-RunningAlignerUrl {
    foreach ($port in $ports) {
        $url = "http://127.0.0.1:$port"
        try {
            $openApi = Invoke-RestMethod -Uri "$url/openapi.json" -TimeoutSec 1
            if ($openApi.info.title -eq "Lyrics Forced Aligner") {
                return $url
            }
        } catch {
        }
    }
    return $null
}

function Test-LoopbackPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

$runningUrl = Get-RunningAlignerUrl
if (-not [string]::IsNullOrWhiteSpace($runningUrl)) {
    Write-Host "Lyrics Forced Aligner is already running at $runningUrl" -ForegroundColor Green
    exit 0
}

$selectedPort = $null
foreach ($port in $ports) {
    if (Test-LoopbackPortAvailable -Port $port) {
        $selectedPort = $port
        break
    }
}
if ($null -eq $selectedPort) {
    throw "No supported local port is available. Checked 8765 and 8876-8895."
}

$statePath = Join-Path $resolvedInstallRoot "install-state.json"
$installState = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} else {
    $null
}
if ($installState.acceleration -eq "cuda") {
    Add-PrivateNvidiaRuntimePath
    $env:CUDA_VISIBLE_DEVICES = [string]$installState.cudaDevice
    Write-Host "Acceleration: isolated NVIDIA CUDA ($($installState.gpuName))" -ForegroundColor Cyan
} else {
    $env:CUDA_VISIBLE_DEVICES = "-1"
    Write-Host "Acceleration: CPU compatibility mode" -ForegroundColor Cyan
}
$modelEndpoint = [string]$installState.modelEndpoint
if ($modelEndpoint -notin @("https://huggingface.co", "https://hf-mirror.com")) {
    $modelEndpoint = "https://huggingface.co"
}

$env:PYTHONPATH = "$resolvedInstallRoot;$((Join-Path $engineRoot 'src'))"
$env:TORCH_HOME = Join-Path $modelRoot "torch"
$env:HF_HOME = Join-Path $modelRoot "huggingface"
$env:HF_ENDPOINT = $modelEndpoint
$env:HF_HUB_DISABLE_XET = if ($modelEndpoint -eq "https://hf-mirror.com") { "1" } else { "0" }
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:LYRICS_ALIGNER_PORT = [string]$selectedPort
$warningFilter = "ignore:pkg_resources is deprecated as an API:UserWarning"
if ([string]::IsNullOrWhiteSpace($env:PYTHONWARNINGS)) {
    $env:PYTHONWARNINGS = $warningFilter
} elseif ($env:PYTHONWARNINGS -notmatch "pkg_resources is deprecated as an API") {
    $env:PYTHONWARNINGS = "$warningFilter,$($env:PYTHONWARNINGS)"
}

$url = "http://127.0.0.1:$selectedPort"
Write-Host "Lyrics Forced Aligner is starting at $url" -ForegroundColor Green
Write-Host "Keep this window open while AI alignment is in use. Press Ctrl+C or run stop-ai-aligner.cmd to stop."

Push-Location -LiteralPath $engineRoot
try {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $venvPython -m lrc_editor_companion_server
    $serverExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
} finally {
    Pop-Location
}
$expectedExitCodes = @(0, -1, 130, -1073741510, 3221225786)
if ([long]$serverExitCode -notin $expectedExitCodes) {
    throw "Lyrics Forced Aligner exited unexpectedly with code $serverExitCode."
}
