function Get-AiAlignerDefaultInstallRoot {
    return Join-Path $env:LOCALAPPDATA "LRC Editor\AI Aligner"
}

function Get-AiAlignerLocationRegistry {
    return Join-Path $env:LOCALAPPDATA "LRC Editor\ai-aligner-location.txt"
}

function Test-AiAlignerInstallation {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $false
    }
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    return (Test-Path -LiteralPath (Join-Path $resolved "install-state.json")) -and
        (Test-Path -LiteralPath (Join-Path $resolved "engine")) -and
        (Test-Path -LiteralPath (Join-Path $resolved "environment"))
}

function Read-AiAlignerLocation {
    param([string]$LocationFile)
    if (-not (Test-Path -LiteralPath $LocationFile)) {
        return $null
    }
    $candidate = (Get-Content -LiteralPath $LocationFile -Raw).Trim()
    if (Test-AiAlignerInstallation -Candidate $candidate) {
        return [System.IO.Path]::GetFullPath($candidate).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    return $null
}

function Resolve-AiAlignerInstallRoot {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherRoot,
        [string]$RequestedRoot
    )
    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        return [System.IO.Path]::GetFullPath($RequestedRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    if (Test-AiAlignerInstallation -Candidate $LauncherRoot) {
        return [System.IO.Path]::GetFullPath($LauncherRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    foreach ($locationFile in @(
        (Join-Path $LauncherRoot "install-location.txt"),
        (Get-AiAlignerLocationRegistry)
    )) {
        $candidate = Read-AiAlignerLocation -LocationFile $locationFile
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            return $candidate
        }
    }
    $defaultRoot = Get-AiAlignerDefaultInstallRoot
    if (Test-AiAlignerInstallation -Candidate $defaultRoot) {
        return [System.IO.Path]::GetFullPath($defaultRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    Write-Host "The installed AI aligner directory could not be found automatically." -ForegroundColor Yellow
    $enteredRoot = Read-Host "Install directory"
    if (-not [string]::IsNullOrWhiteSpace($enteredRoot)) {
        return [System.IO.Path]::GetFullPath($enteredRoot.Trim().Trim('"')).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar
        )
    }
    return [System.IO.Path]::GetFullPath($LauncherRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}
