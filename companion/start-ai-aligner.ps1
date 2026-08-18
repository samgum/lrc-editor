[CmdletBinding()]
param(
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$engineRoot = Join-Path $resolvedInstallRoot "engine"
$environmentRoot = Join-Path $resolvedInstallRoot "environment"
$modelRoot = Join-Path $resolvedInstallRoot "models"
$venvPython = Join-Path $environmentRoot "Scripts\python.exe"
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
    throw "The AI aligner is not installed. Run install-ai-aligner.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $engineRoot "src\lyrics_aligner\server.py"))) {
    throw "The installed alignment engine is incomplete. Run install-ai-aligner.ps1 again."
}
if ($null -eq (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or
    $null -eq (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    throw "FFmpeg is not available. Run install-ai-aligner.ps1 again."
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

$env:PYTHONPATH = Join-Path $engineRoot "src"
$env:TORCH_HOME = Join-Path $modelRoot "torch"
$env:HF_HOME = Join-Path $modelRoot "huggingface"
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
Write-Host "Keep this window open while AI alignment is in use. Press Ctrl+C to stop."

Push-Location -LiteralPath $engineRoot
try {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $venvPython -m lyrics_aligner.server
    $serverExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
} finally {
    Pop-Location
}
$expectedExitCodes = @(0, 130, -1073741510, 3221225786)
if ([long]$serverExitCode -notin $expectedExitCodes) {
    throw "Lyrics Forced Aligner exited unexpectedly with code $serverExitCode."
}
