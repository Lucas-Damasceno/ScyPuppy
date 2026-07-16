$ErrorActionPreference = "Stop"

$strawberryPerl = "C:\Strawberry\perl\bin"
$strawberryTools = "C:\Strawberry\c\bin"
if (-not (Get-Command perl -ErrorAction SilentlyContinue) -and (Test-Path $strawberryPerl)) {
  $env:PATH = "$strawberryPerl;$strawberryTools;$env:PATH"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repoRoot "src-tauri"
$targetRoot = Join-Path $tauriRoot "target\release"
$nsisScriptRoot = Join-Path $targetRoot "nsis\x64"
$nsisScript = Join-Path $nsisScriptRoot "installer.nsi"
$cleanBinary = Join-Path $targetRoot "scrypuppy.exe"
$makensis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\makensis.exe"
$metadata = (& (Join-Path $PSScriptRoot "release-metadata.ps1")) | ConvertFrom-Json
$hashScript = Join-Path $PSScriptRoot "file-sha256.ps1"
$installerName = $metadata.installer_name
$bundleRoot = Join-Path $targetRoot "bundle\nsis"
$installer = Join-Path $bundleRoot $installerName
$signature = "$installer.sig"
if (
  [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and
  -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)
) {
  if (-not (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
    throw "Updater signing key file was not found: $env:TAURI_SIGNING_PRIVATE_KEY_PATH"
  }
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH
}
$hasSigningKey = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)
$signatureRequired = $env:REQUIRE_UPDATER_SIGNATURE -eq "true"

Push-Location $repoRoot
try {
  if ($signatureRequired -and -not $hasSigningKey) {
    throw "Updater signing is required, but TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is not configured."
  }

  # Tauri generates the current NSIS definition, but its Windows bundle marker
  # patch can corrupt this PE binary. Rebuild it cleanly before packaging.
  $tauriBuildArgs = @("run", "tauri", "--", "build", "--features", "custom-protocol")
  if (-not $hasSigningKey) {
    # Pull-request and local validation builds do not need distributable updater
    # artifacts. Release builds always provide a signing key and use the checked-in
    # createUpdaterArtifacts setting.
    $tauriBuildArgs += @("--config", '{"bundle":{"createUpdaterArtifacts":false}}')
  }
  & npm @tauriBuildArgs
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }

  Push-Location $tauriRoot
  try {
    & cargo clean -p scrypuppy
    if ($LASTEXITCODE -ne 0) { throw "Cargo clean failed with exit code $LASTEXITCODE." }

    & cargo build --release --locked --features custom-protocol
    if ($LASTEXITCODE -ne 0) { throw "Cargo release build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $cleanBinary)) { throw "Clean Windows executable was not created: $cleanBinary" }
  if (-not (Test-Path $nsisScript)) { throw "NSIS definition was not created: $nsisScript" }
  if (-not (Test-Path $makensis)) { throw "Tauri NSIS compiler was not found: $makensis" }

  $runningApps = @(Get-Process -Name "scrypuppy" -ErrorAction SilentlyContinue)
  if ($runningApps.Count -gt 0) {
    throw "Close every running ScryPuppy instance before building so the release startup check can run."
  }

  $startupProbe = Start-Process -FilePath $cleanBinary -PassThru
  try {
    if ($startupProbe.WaitForExit(12000)) {
      throw "The release executable exited during the 12-second startup check (exit code $($startupProbe.ExitCode))."
    }
  } finally {
    if (-not $startupProbe.HasExited) {
      Stop-Process -Id $startupProbe.Id -Force
      $startupProbe.WaitForExit()
    }
  }

  $binaryHashBefore = & $hashScript -Path $cleanBinary
  Push-Location $nsisScriptRoot
  try {
    & $makensis -INPUTCHARSET UTF8 -OUTPUTCHARSET UTF8 -V3 $nsisScript
    if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }

  $binaryHashAfter = & $hashScript -Path $cleanBinary
  if ($binaryHashBefore -ne $binaryHashAfter) {
    throw "The Windows executable changed while the installer was being packaged."
  }

  New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null
  if (Test-Path -LiteralPath $signature) {
    Remove-Item -LiteralPath $signature -Force
  }
  Move-Item -Force (Join-Path $nsisScriptRoot "nsis-output.exe") $installer

  if ($hasSigningKey) {
    & npm run tauri -- signer sign $installer
    if ($LASTEXITCODE -ne 0) { throw "Updater signing failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $signature)) {
      throw "Updater signature was not created: $signature"
    }
    Write-Host "Updater signature created: $signature"
  }

  Write-Host "Windows installer created: $installer"
} finally {
  Pop-Location
}
