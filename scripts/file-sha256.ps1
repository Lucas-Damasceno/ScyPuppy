param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
  throw "Cannot calculate SHA-256 because the path is not a file: $Path"
}

$stream = $null
$sha256 = $null
try {
  $stream = [System.IO.File]::Open(
    $resolvedPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha256.ComputeHash($stream)
  [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
} finally {
  if ($null -ne $sha256) { $sha256.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
}
