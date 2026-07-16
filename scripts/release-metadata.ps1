param(
  [switch]$GitHubOutput
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repoRoot "src-tauri"
$tauriConfig = Get-Content (Join-Path $tauriRoot "tauri.conf.json") -Raw | ConvertFrom-Json
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$packageLock = Get-Content (Join-Path $repoRoot "package-lock.json") -Raw
$cargoToml = Get-Content (Join-Path $tauriRoot "Cargo.toml") -Raw
$cargoLock = Get-Content (Join-Path $tauriRoot "Cargo.lock") -Raw

$cargoTomlMatch = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"(?<version>[^"]+)"')
$cargoLockMatch = [regex]::Match(
  $cargoLock,
  '(?ms)^\[\[package\]\]\r?\nname\s*=\s*"scrypuppy"\r?\nversion\s*=\s*"(?<version>[^"]+)"'
)
$packageLockVersionMatch = [regex]::Match(
  $packageLock,
  '(?m)^  "version":\s*"(?<version>[^"]+)"'
)
$packageLockRootMatch = [regex]::Match(
  $packageLock,
  '(?ms)^    "":\s*\{\r?\n\s*"name":\s*"scrypuppy",\r?\n\s*"version":\s*"(?<version>[^"]+)"'
)
if (
  -not $cargoTomlMatch.Success -or
  -not $cargoLockMatch.Success -or
  -not $packageLockVersionMatch.Success -or
  -not $packageLockRootMatch.Success
) {
  throw "Could not read the ScryPuppy version from package or Cargo manifests."
}

$versions = [ordered]@{
  "package.json" = [string]$packageJson.version
  "package-lock.json" = $packageLockVersionMatch.Groups["version"].Value
  "package-lock.json root package" = $packageLockRootMatch.Groups["version"].Value
  "src-tauri/Cargo.toml" = $cargoTomlMatch.Groups["version"].Value
  "src-tauri/Cargo.lock" = $cargoLockMatch.Groups["version"].Value
  "src-tauri/tauri.conf.json" = [string]$tauriConfig.version
}
$uniqueVersions = @($versions.Values | Select-Object -Unique)
if ($uniqueVersions.Count -ne 1) {
  $details = ($versions.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "; "
  throw "Release versions do not match: $details"
}

$manifestVersion = $uniqueVersions[0]
$versionMatch = [regex]::Match(
  $manifestVersion,
  '^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.0-beta\.(?<beta>0|[1-9]\d*)$'
)
if (-not $versionMatch.Success) {
  throw "Beta versions must use '<major>.<minor>.0-beta.<number>'; received '$manifestVersion'."
}

$publicVersion = "{0}.{1}.{2}" -f `
  $versionMatch.Groups["major"].Value,
  $versionMatch.Groups["minor"].Value,
  $versionMatch.Groups["beta"].Value
$installerName = "ScryPuppy_beta_installer_v$publicVersion.exe"
$bundleRoot = Join-Path $tauriRoot "target\release\bundle\nsis"
$installerPath = Join-Path $bundleRoot $installerName
$checksumName = "$installerName.sha256"
$checksumPath = Join-Path $bundleRoot $checksumName
$artifactName = "scrypuppy-windows-v$publicVersion"
$releaseTag = "v$manifestVersion"

$metadata = [ordered]@{
  manifest_version = $manifestVersion
  public_version = $publicVersion
  installer_name = $installerName
  installer_path = $installerPath
  checksum_name = $checksumName
  checksum_path = $checksumPath
  artifact_name = $artifactName
  release_tag = $releaseTag
}

if ($GitHubOutput) {
  if ([string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
    throw "GITHUB_OUTPUT is required when -GitHubOutput is used."
  }
  foreach ($entry in $metadata.GetEnumerator()) {
    "$($entry.Key)=$($entry.Value)" >> $env:GITHUB_OUTPUT
  }
} else {
  [pscustomobject]$metadata | ConvertTo-Json -Compress
}
