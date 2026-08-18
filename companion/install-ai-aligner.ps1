[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$CpuOnly,
    [switch]$SkipPrerequisiteInstall,
    [switch]$SkipModelDownload,
    [switch]$EstimateOnly
)

$ErrorActionPreference = "Stop"
$engineRepository = "https://github.com/samgum/lyrics-forced-aligner.git"
$engineRevision = "4898a3cbc569349c5db87bbc931c9d6fa124d64d"

if ($env:OS -ne "Windows_NT") {
    throw "This installer currently supports Windows only."
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is unavailable. Pass -InstallRoot explicitly."
    }
    $defaultInstallRoot = Join-Path $env:LOCALAPPDATA "LRC Editor\AI Aligner"
    if ($EstimateOnly) {
        $InstallRoot = $defaultInstallRoot
    } else {
        Write-Host "Choose one directory for the engine, models, private GPU runtime, and job cache."
        Write-Host "1. C drive default: $defaultInstallRoot"
        if (Test-Path -LiteralPath "D:\") {
            Write-Host "2. D drive: D:\LRC Editor AI"
        } else {
            Write-Host "2. D drive: unavailable on this computer"
        }
        Write-Host "3. Custom directory"
        $pathChoice = Read-Host "Choose installation location [1/2/3]"
        switch ($pathChoice.Trim()) {
            "2" {
                if (-not (Test-Path -LiteralPath "D:\")) {
                    throw "D drive is unavailable. Run the installer again and choose 1 or 3."
                }
                $InstallRoot = "D:\LRC Editor AI"
            }
            "3" {
                $selectedInstallRoot = Read-Host "Enter an absolute installation directory"
                if ([string]::IsNullOrWhiteSpace($selectedInstallRoot)) {
                    throw "A custom installation directory is required for option 3."
                }
                $InstallRoot = $selectedInstallRoot.Trim().Trim('"')
            }
            default {
                $InstallRoot = $defaultInstallRoot
            }
        }
    }
}

$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ($resolvedInstallRoot -eq [System.IO.Path]::GetPathRoot($resolvedInstallRoot)) {
    throw "InstallRoot cannot be a drive root."
}

$engineRoot = Join-Path $resolvedInstallRoot "engine"
$environmentRoot = Join-Path $resolvedInstallRoot "environment"
$modelRoot = Join-Path $resolvedInstallRoot "models"
$runtimeRoot = Join-Path $resolvedInstallRoot "runtime"
$pythonRoot = Join-Path $resolvedInstallRoot "python"
$downloadCacheRoot = Join-Path $resolvedInstallRoot "download-cache"
$venvPython = Join-Path $environmentRoot "Scripts\python.exe"
$constraintsPath = Join-Path $PSScriptRoot "ai-constraints.txt"
if (-not (Test-Path -LiteralPath $constraintsPath)) {
    throw "ai-constraints.txt is missing from the installer package."
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @Arguments
        $nativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($nativeExitCode -ne 0) {
        throw "$FailureMessage (exit code $nativeExitCode)."
    }
}

function Resolve-CommandWithPackage {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName,
        [Parameter(Mandatory = $true)][string]$PackageId
    )
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    if ($SkipPrerequisiteInstall) {
        throw "$CommandName is required. Install package $PackageId and run this installer again."
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        throw "$CommandName is required and WinGet is unavailable. Install package $PackageId first."
    }
    Write-Host "Installing prerequisite: $PackageId" -ForegroundColor Cyan
    Invoke-Checked -FilePath $winget.Source -Arguments @(
        "install",
        "--id", $PackageId,
        "--exact",
        "--source", "winget",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements"
    ) -FailureMessage "Unable to install $PackageId"
    Refresh-ProcessPath
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "$PackageId was installed, but $CommandName is not available in this terminal. Restart Windows and rerun the installer."
    }
    return $command.Source
}

function Ensure-Junction {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Target
    )
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        $linkTarget = $item.Target | Select-Object -First 1
        $isExpectedLink = ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") -and `
            -not [string]::IsNullOrWhiteSpace([string]$linkTarget) -and `
            [System.IO.Path]::GetFullPath([string]$linkTarget) -eq [System.IO.Path]::GetFullPath($Target)
        if ($isExpectedLink) {
            return
        }
        $children = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
        if ($item.PSIsContainer -and $children.Count -eq 0) {
            Remove-Item -LiteralPath $Path
        } else {
            throw "$Path already exists and is not the expected empty directory or junction."
        }
    }
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

function Add-PrivateNvidiaRuntimePath {
    $sitePackages = Join-Path $environmentRoot "Lib\site-packages\nvidia"
    $privatePaths = @(
        (Join-Path $sitePackages "cublas\bin"),
        (Join-Path $sitePackages "cudnn\bin")
    )
    foreach ($privatePath in $privatePaths) {
        if (Test-Path -LiteralPath $privatePath) {
            $env:Path = "$privatePath;$env:Path"
        }
    }
}

$useCuda = $false
$cudaDevice = $null
$gpuName = $null
$gpuMemoryMb = 0
$gpuDriver = $null
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $CpuOnly -and $null -ne $nvidiaSmi) {
    $gpuRows = @()
    $gpuProbeExitCode = 1
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $gpuRows = @(& $nvidiaSmi.Source --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits)
        $gpuProbeExitCode = $LASTEXITCODE
    } catch {
        $gpuProbeExitCode = 1
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($gpuProbeExitCode -eq 0) {
        $gpuCandidates = @($gpuRows | ForEach-Object {
            $columns = $_ -split ","
            if ($columns.Count -ge 4) {
                [pscustomobject]@{
                    Index = [int]$columns[0].Trim()
                    Name = $columns[1].Trim()
                    MemoryMb = [int]$columns[2].Trim()
                    Driver = $columns[3].Trim()
                }
            }
        })
        $selectedGpu = $gpuCandidates | Sort-Object MemoryMb -Descending | Select-Object -First 1
        if ($null -ne $selectedGpu) {
            $cudaDevice = $selectedGpu.Index
            $gpuName = $selectedGpu.Name
            $gpuMemoryMb = $selectedGpu.MemoryMb
            $gpuDriver = $selectedGpu.Driver
            if ($gpuMemoryMb -ge 4096) {
                $useCuda = $true
            }
        }
    }
}

$computeMode = "CPU compatibility mode"
$expectedDownload = "approximately 4-6 GB"
$expectedInstalled = "approximately 8-12 GB"
if ($useCuda) {
    $computeMode = "isolated NVIDIA CUDA 12.8"
    $expectedDownload = "approximately 7-10 GB"
    $expectedInstalled = "approximately 12-18 GB"
}

$physicalMemoryBytes = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).TotalPhysicalMemory
$physicalMemoryGb = if ($physicalMemoryBytes) { [Math]::Round($physicalMemoryBytes / 1GB, 1) } else { $null }

Write-Host "LRC Editor AI hardware plan" -ForegroundColor Magenta
if ($null -ne $gpuName) {
    Write-Host "Detected NVIDIA GPU: $gpuName ($([Math]::Round($gpuMemoryMb / 1024, 1)) GB VRAM, driver $gpuDriver)"
    if (-not $useCuda -and -not $CpuOnly) {
        Write-Host "This GPU has less than 4 GB VRAM; the installer will use CPU mode to avoid out-of-memory failures." -ForegroundColor Yellow
    }
} elseif (-not $CpuOnly) {
    $displayAdapters = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    if ($displayAdapters.Count -gt 0) {
        Write-Host "Detected display adapter(s): $($displayAdapters -join ', ')"
    }
    Write-Host "No supported NVIDIA CUDA device was found. AMD and Intel GPUs use CPU compatibility mode." -ForegroundColor Yellow
}
if ($CpuOnly) {
    Write-Host "CPU mode was explicitly requested."
}
if ($null -ne $physicalMemoryGb) {
    Write-Host "System memory: $physicalMemoryGb GB"
    if ($physicalMemoryGb -lt 8) {
        Write-Host "Less than 8 GB RAM may be too slow for large-v3-turbo." -ForegroundColor Yellow
    }
}
Write-Host "Selected acceleration: $computeMode"
Write-Host "Expected network download: $expectedDownload"
Write-Host "Expected installed size:    $expectedInstalled"
Write-Host "Required free space:        at least 15 GB (CPU) or 22 GB (CUDA)"
$requiredSpaceGb = if ($useCuda) { 22 } else { 15 }
$installDrive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($resolvedInstallRoot))
$availableSpaceGb = [Math]::Round($installDrive.AvailableFreeSpace / 1GB, 1)
Write-Host "Available on $($installDrive.Name)              $availableSpaceGb GB"
if ($availableSpaceGb -lt $requiredSpaceGb) {
    Write-Host "The selected drive has less than the recommended free space. Choose another directory." -ForegroundColor Red
    if (-not $EstimateOnly) {
        throw "Insufficient free space for the selected acceleration mode."
    }
}
if ($EstimateOnly) {
    Write-Host "Estimate only; no files were downloaded or changed." -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path $resolvedInstallRoot -Force | Out-Null
Write-Host "LRC Editor AI Aligner" -ForegroundColor Magenta
Write-Host "Install directory: $resolvedInstallRoot"
Write-Host "Model directory:   $modelRoot"

$git = Resolve-CommandWithPackage -CommandName "git" -PackageId "Git.Git"
$uv = Resolve-CommandWithPackage -CommandName "uv" -PackageId "astral-sh.uv"
$ffmpeg = Resolve-CommandWithPackage -CommandName "ffmpeg" -PackageId "Gyan.FFmpeg"
$ffmpegDirectory = Split-Path -Parent $ffmpeg
if (Test-Path -LiteralPath (Join-Path $ffmpegDirectory "ffprobe.exe")) {
    $env:Path = "$ffmpegDirectory;$env:Path"
}
$null = Resolve-CommandWithPackage -CommandName "ffprobe" -PackageId "Gyan.FFmpeg"

if (Test-Path -LiteralPath (Join-Path $engineRoot ".git")) {
    Write-Host "Updating the installed engine source..." -ForegroundColor Cyan
    Invoke-Checked -FilePath $git -Arguments @("-C", $engineRoot, "fetch", "--depth", "1", "origin", $engineRevision) `
        -FailureMessage "Unable to fetch the verified aligner revision"
} else {
    if (Test-Path -LiteralPath $engineRoot) {
        $engineEntries = @(Get-ChildItem -LiteralPath $engineRoot -Force)
        if ($engineEntries.Count -ne 0) {
            throw "$engineRoot exists but is not an aligner Git checkout."
        }
    }
    Write-Host "Downloading the verified alignment engine..." -ForegroundColor Cyan
    Invoke-Checked -FilePath $git -Arguments @(
        "clone", "--filter=blob:none", "--no-checkout", $engineRepository, $engineRoot
    ) -FailureMessage "Unable to download the alignment engine"
    Invoke-Checked -FilePath $git -Arguments @("-C", $engineRoot, "fetch", "--depth", "1", "origin", $engineRevision) `
        -FailureMessage "Unable to fetch the verified aligner revision"
}
Invoke-Checked -FilePath $git -Arguments @("-C", $engineRoot, "checkout", "--detach", $engineRevision) `
    -FailureMessage "Unable to select the verified aligner revision"
$installedRevision = (& $git -C $engineRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $installedRevision -ne $engineRevision) {
    throw "The installed aligner revision could not be verified."
}

Ensure-Junction -Path (Join-Path $engineRoot ".cache") -Target $modelRoot
Ensure-Junction -Path (Join-Path $engineRoot "runtime") -Target $runtimeRoot

$env:UV_PYTHON_INSTALL_DIR = $pythonRoot
$env:UV_CACHE_DIR = $downloadCacheRoot
$env:UV_NO_MODIFY_PATH = "1"
$env:UV_MANAGED_PYTHON = "1"
Write-Host "Installing private Python 3.11 inside the selected directory..." -ForegroundColor Cyan
Invoke-Checked -FilePath $uv -Arguments @(
    "python", "install", "3.11", "--install-dir", $pythonRoot,
    "--managed-python", "--no-bin", "--no-registry"
) -FailureMessage "Unable to install the private Python runtime"
$savedPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    $managedPython = (& $uv python find 3.11 --managed-python --no-project).Trim()
    $managedPythonExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $savedPreference
}
if ($managedPythonExitCode -ne 0 -or -not (Test-Path -LiteralPath $managedPython)) {
    throw "The private Python executable could not be located."
}
$resolvedManagedPython = [System.IO.Path]::GetFullPath($managedPython)
if (-not $resolvedManagedPython.StartsWith($pythonRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "uv selected a Python runtime outside the chosen installation directory."
}

$rebuildEnvironment = -not (Test-Path -LiteralPath $venvPython)
if (-not $rebuildEnvironment) {
    $existingBase = (& $venvPython -c "import sys; print(sys.base_prefix)").Trim()
    $rebuildEnvironment = -not [System.IO.Path]::GetFullPath($existingBase).StartsWith(
        $pythonRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}
if ($rebuildEnvironment) {
    Write-Host "Creating an isolated environment from the private Python runtime..." -ForegroundColor Cyan
    $venvArguments = @("venv", "--python", $resolvedManagedPython, "--managed-python")
    if (Test-Path -LiteralPath $environmentRoot) {
        $venvArguments += "--clear"
    }
    $venvArguments += $environmentRoot
    Invoke-Checked -FilePath $uv -Arguments $venvArguments -FailureMessage "Unable to create the private environment"
}

Write-Host "Installing the local engine for $computeMode..." -ForegroundColor Cyan
$reinstallCpuTorch = $false
if ($useCuda) {
    try {
        Invoke-Checked -FilePath $uv -Arguments @(
            "pip", "install", "--upgrade", "--python", $venvPython,
            "torch==2.11.0", "torchaudio==2.11.0", "--index-url", "https://download.pytorch.org/whl/cu128"
        ) -FailureMessage "Unable to install CUDA PyTorch"
        Write-Host "Installing private NVIDIA runtime libraries..." -ForegroundColor Cyan
        Write-Host "Source: NVIDIA packages on PyPI"
        Invoke-Checked -FilePath $uv -Arguments @(
            "pip", "install", "--upgrade", "--python", $venvPython,
            "nvidia-cublas-cu12==12.8.4.1", "nvidia-cudnn-cu12==9.8.0.87"
        ) -FailureMessage "Unable to install the private CUDA runtime"
        Add-PrivateNvidiaRuntimePath
        $env:CUDA_VISIBLE_DEVICES = [string]$cudaDevice
    } catch {
        Write-Host "CUDA packages could not be prepared; falling back to CPU mode." -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        $useCuda = $false
        $computeMode = "CPU compatibility mode"
        $reinstallCpuTorch = $true
    }
}
if (-not $useCuda) {
    $env:CUDA_VISIBLE_DEVICES = "-1"
    $cpuTorchArguments = @("pip", "install", "--upgrade")
    if ($reinstallCpuTorch) {
        $cpuTorchArguments += "--reinstall"
    }
    $cpuTorchArguments += @(
        "--python", $venvPython, "torch==2.11.0", "torchaudio==2.11.0",
        "--index-url", "https://download.pytorch.org/whl/cpu"
    )
    Invoke-Checked -FilePath $uv -Arguments $cpuTorchArguments -FailureMessage "Unable to install CPU PyTorch"
}
Invoke-Checked -FilePath $uv -Arguments @(
    "pip", "install", "--upgrade", "--python", $venvPython,
    "--constraints", $constraintsPath, "-e", $engineRoot
) -FailureMessage "Unable to install Lyrics Forced Aligner"

$dependencyVerification = @"
from importlib.metadata import version
import torch
assert version('demucs') == '4.0.1', version('demucs')
assert torch.__version__.startswith('2.11.0'), torch.__version__
print('Pinned dependencies verified:', 'demucs', version('demucs'), 'torch', torch.__version__)
"@
Invoke-Checked -FilePath $venvPython -Arguments @("-c", $dependencyVerification) `
    -FailureMessage "Pinned dependency verification failed"

$env:PYTHONPATH = Join-Path $engineRoot "src"
$env:TORCH_HOME = Join-Path $modelRoot "torch"
$env:HF_HOME = Join-Path $modelRoot "huggingface"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:LRC_EDITOR_MODEL_ROOT = $modelRoot

if (-not $SkipModelDownload) {
    Write-Host "Downloading the htdemucs_ft vocal model..." -ForegroundColor Cyan
    Write-Host "Source: https://dl.fbaipublicfiles.com/demucs/"
    Invoke-Checked -FilePath $venvPython -Arguments @(
        "-c",
        "from demucs.pretrained import get_model; get_model('htdemucs_ft'); print('htdemucs_ft ready')"
    ) -FailureMessage "Unable to download htdemucs_ft"

    Write-Host "Downloading the large-v3-turbo speech model..." -ForegroundColor Cyan
    Write-Host "Source: https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    $whisperDownload = @"
import os
from faster_whisper import download_model
download_model(
    'large-v3-turbo',
    cache_dir=os.path.join(os.environ['LRC_EDITOR_MODEL_ROOT'], 'faster-whisper'),
)
print('large-v3-turbo ready')
"@
    Invoke-Checked -FilePath $venvPython -Arguments @("-c", $whisperDownload) `
        -FailureMessage "Unable to download large-v3-turbo"
}

if ($useCuda) {
    $gpuVerificationCode = if ($SkipModelDownload) {
        @"
import ctranslate2
import torch
assert torch.cuda.is_available()
assert ctranslate2.get_cuda_device_count() > 0
print('CUDA libraries verified')
"@
    } else {
        @"
import os
import ctranslate2
import torch
from faster_whisper import WhisperModel
assert torch.cuda.is_available()
assert ctranslate2.get_cuda_device_count() > 0
model = WhisperModel(
    'large-v3-turbo',
    device='cuda',
    compute_type='float16',
    download_root=os.path.join(os.environ['LRC_EDITOR_MODEL_ROOT'], 'faster-whisper'),
)
print('CUDA model load verified')
"@
    }
    try {
        Invoke-Checked -FilePath $venvPython -Arguments @("-c", $gpuVerificationCode) `
            -FailureMessage "The isolated CUDA runtime failed verification"
    } catch {
        Write-Host "CUDA validation failed; this installation will use CPU mode safely." -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        $useCuda = $false
        $computeMode = "CPU compatibility mode"
        $env:CUDA_VISIBLE_DEVICES = "-1"
    }
}

$cpuModelCheck = ""
if (-not $useCuda -and -not $SkipModelDownload) {
    $cpuModelCheck = @"
from faster_whisper import WhisperModel
model = WhisperModel(
    'large-v3-turbo',
    device='cpu',
    compute_type='int8',
    download_root=os.path.join(os.environ['LRC_EDITOR_MODEL_ROOT'], 'faster-whisper'),
)
print('CPU model load verified')
"@
}
$backendName = if ($useCuda) { "cuda" } else { "cpu" }
$verificationCode = @"
import os
from lyrics_aligner.server import app
import torch
assert app.title == 'Lyrics Forced Aligner'
assert app.version == '0.2.27'
$cpuModelCheck
print('Engine API verified')
print('Selected backend: $backendName')
"@
Invoke-Checked -FilePath $venvPython -Arguments @("-c", $verificationCode) `
    -FailureMessage "The local alignment engine failed verification"

foreach ($fileName in @(
    "install-ai-aligner.cmd",
    "install-ai-aligner.ps1",
    "ai-constraints.txt",
    "lrc_editor_companion_server.py",
    "start-ai-aligner.ps1",
    "start-ai-aligner.cmd",
    "README.md",
    "README-zh.md",
    "INSTALL.txt"
)) {
    $sourcePath = Join-Path $PSScriptRoot $fileName
    $destinationPath = Join-Path $resolvedInstallRoot $fileName
    $shouldCopy = (Test-Path -LiteralPath $sourcePath) -and `
        [System.IO.Path]::GetFullPath($sourcePath) -ne [System.IO.Path]::GetFullPath($destinationPath)
    if ($shouldCopy) {
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }
}

$modelBytes = (Get-ChildItem -LiteralPath $modelRoot -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
$stateCudaDevice = if ($useCuda) { $cudaDevice } else { $null }
$state = [ordered]@{
    installedAt = [DateTimeOffset]::Now.ToString("o")
    engineRevision = $installedRevision
    engineVersion = "0.2.27"
    computeMode = $computeMode
    acceleration = $backendName
    cudaDevice = $stateCudaDevice
    gpuName = $gpuName
    gpuMemoryMb = $gpuMemoryMb
    installRoot = $resolvedInstallRoot
    modelRoot = $modelRoot
    pythonRoot = $pythonRoot
    managedPython = $resolvedManagedPython
    modelBytes = [long]$modelBytes
    modelsDownloaded = -not [bool]$SkipModelDownload
    expectedDownload = $expectedDownload
    expectedInstalledSize = $expectedInstalled
}
$state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedInstallRoot "install-state.json") -Encoding UTF8

Write-Host "Cleaning rebuildable package download cache..." -ForegroundColor Cyan
Invoke-Checked -FilePath $uv -Arguments @("cache", "clean") -FailureMessage "Unable to clean the package cache"
$cacheIsEmpty = (Test-Path -LiteralPath $downloadCacheRoot) -and `
    @(Get-ChildItem -LiteralPath $downloadCacheRoot -Force -ErrorAction SilentlyContinue).Count -eq 0
if ($cacheIsEmpty) {
    Remove-Item -LiteralPath $downloadCacheRoot
}

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Models are stored only in: $modelRoot"
Write-Host "Start on demand with:       $resolvedInstallRoot\start-ai-aligner.cmd"
Write-Host "Stop the service with Ctrl+C. Starting it again while it is already running is safely ignored."
