[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repositoryRoot ".release-artifacts"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if ($resolvedOutput -eq [System.IO.Path]::GetPathRoot($resolvedOutput)) {
    throw "The release output directory cannot be a drive root."
}

$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$headPackage = (& git -C $repositoryRoot show HEAD:package.json | Out-String) | ConvertFrom-Json
if ([string]$headPackage.version -ne $version) {
    throw "Commit the version change before packaging a release."
}

Push-Location -LiteralPath $repositoryRoot
try {
    & pnpm build:extension
    if ($LASTEXITCODE -ne 0) {
        throw "The extension build failed."
    }

    New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
    $windowsName = "lrc-editor-ai-aligner-windows-v$version"
    $unixName = "lrc-editor-ai-aligner-macos-linux-v$version"
    $extensionName = "lrc-editor-media-bridge-v$version"
    $windowsArchive = Join-Path $resolvedOutput "$windowsName.zip"
    $unixArchive = Join-Path $resolvedOutput "$unixName.tar.gz"
    $extensionArchive = Join-Path $resolvedOutput "$extensionName.zip"
    $extensionStage = Join-Path $resolvedOutput $extensionName

    foreach ($path in @($windowsArchive, $unixArchive, $extensionArchive)) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    if (Test-Path -LiteralPath $extensionStage) {
        $expectedStagePrefix = $resolvedOutput.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
            [System.IO.Path]::DirectorySeparatorChar
        if (-not $extensionStage.StartsWith($expectedStagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "The extension staging directory is unsafe."
        }
        Remove-Item -LiteralPath $extensionStage -Recurse -Force
    }

    $windowsPaths = @(
        ".",
        ":(exclude,glob)*.sh",
        ":(exclude,glob)*.command",
        ":(exclude)INSTALL-Linux.txt",
        ":(exclude)INSTALL-macOS.txt"
    )
    & git -C $repositoryRoot archive --format=zip "--prefix=$windowsName/" "--output=$windowsArchive" `
        HEAD:companion -- @windowsPaths
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to create the Windows AI aligner package."
    }
    $unixPaths = @(
        ".",
        ":(exclude,glob)*.ps1",
        ":(exclude,glob)*.cmd",
        ":(exclude)INSTALL.txt"
    )
    & git -C $repositoryRoot archive --format=tar.gz "--prefix=$unixName/" "--output=$unixArchive" `
        HEAD:companion -- @unixPaths
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to create the macOS/Linux AI aligner package."
    }

    Copy-Item -LiteralPath (Join-Path $repositoryRoot "extension-dist") -Destination $extensionStage -Recurse
    Compress-Archive -LiteralPath $extensionStage -DestinationPath $extensionArchive -CompressionLevel Optimal
    Remove-Item -LiteralPath $extensionStage -Recurse -Force

    $windowsEntries = @(& tar -tf $windowsArchive)
    $unixEntries = @(& tar -tzf $unixArchive)
    foreach ($entries in @($windowsEntries, $unixEntries)) {
        if (-not ($entries -match "/engine-bundle/ENGINE_REVISION$") -or
            -not ($entries -match "/resolve-ai-aligner-install\.(?:ps1|sh)$")) {
            throw "A companion archive is missing its bundled engine or installation locator."
        }
    }
    $extensionEntries = @(& tar -tf $extensionArchive)
    if (-not ($extensionEntries -match "/manifest\.json$")) {
        throw "The extension archive is missing its manifest."
    }

    $assets = @($windowsArchive, $unixArchive, $extensionArchive)
    $checksumLines = foreach ($asset in $assets) {
        $hash = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $(Split-Path -Leaf $asset)"
    }
    [System.IO.File]::WriteAllLines((Join-Path $resolvedOutput "SHA256SUMS.txt"), $checksumLines)
    Get-Item -LiteralPath $assets | Select-Object Name, Length
} finally {
    Pop-Location
}
