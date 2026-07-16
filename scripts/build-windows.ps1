$ErrorActionPreference = "Stop"

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

Push-Location $repoRoot
try {
  # Tauri generates the current NSIS definition, but its Windows bundle marker
  # patch can corrupt this PE binary. Rebuild it cleanly before packaging.
  & npm run tauri -- build --features custom-protocol
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
  Move-Item -Force (Join-Path $nsisScriptRoot "nsis-output.exe") $installer
  Write-Host "Windows installer created: $installer"
} finally {
  Pop-Location
}
