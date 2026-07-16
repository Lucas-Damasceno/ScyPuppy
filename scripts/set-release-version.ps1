param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$versionMatch = [regex]::Match(
  $Version,
  '^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.0-beta\.(?<beta>0|[1-9]\d*)$'
)
if (-not $versionMatch.Success) {
  throw "Beta versions must use '<major>.<minor>.0-beta.<number>'; received '$Version'."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$publicVersion = "{0}.{1}.{2}" -f `
  $versionMatch.Groups["major"].Value,
  $versionMatch.Groups["minor"].Value,
  $versionMatch.Groups["beta"].Value
$installerName = "ScryPuppy_beta_installer_v$publicVersion.exe"

function Replace-VersionOnce {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Content,
    [Parameter(Mandatory = $true)]
    [string]$Pattern,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$ReplacementValue
  )

  $regex = New-Object System.Text.RegularExpressions.Regex($Pattern)
  $matches = $regex.Matches($Content)
  if ($matches.Count -ne 1) {
    throw "Expected exactly one version field in $Label; found $($matches.Count)."
  }
  $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
    param($match)
    $match.Groups["prefix"].Value + $ReplacementValue + $match.Groups["suffix"].Value
  }
  $regex.Replace($Content, $evaluator, 1)
}

function Update-VersionFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath,
    [Parameter(Mandatory = $true)]
    [array]$Replacements
  )

  $path = Join-Path $repoRoot $RelativePath
  $original = [System.IO.File]::ReadAllText($path)
  $updated = $original
  foreach ($replacement in $Replacements) {
    $replacementValue = if ($replacement.ContainsKey("Value")) {
      [string]$replacement.Value
    } else {
      $Version
    }
    $updated = Replace-VersionOnce `
      -Content $updated `
      -Pattern $replacement.Pattern `
      -Label "$RelativePath ($($replacement.Label))" `
      -ReplacementValue $replacementValue
  }
  if ($updated -ne $original) {
    [System.IO.File]::WriteAllText($path, $updated, $utf8NoBom)
  }
}

Update-VersionFile "package.json" @(
  @{
    Label = "package version"
    Pattern = '(?m)^(?<prefix>  "version":\s*")[^"]+(?<suffix>",)(?=\r?$)'
  }
)
Update-VersionFile "package-lock.json" @(
  @{
    Label = "lockfile version"
    Pattern = '(?m)^(?<prefix>  "version":\s*")[^"]+(?<suffix>",)(?=\r?$)'
  },
  @{
    Label = "root package version"
    Pattern = '(?ms)(?<prefix>^    "":\s*\{\r?\n\s*"name":\s*"scrypuppy",\r?\n\s*"version":\s*")[^"]+(?<suffix>")'
  }
)
Update-VersionFile "src-tauri/Cargo.toml" @(
  @{
    Label = "package version"
    Pattern = '(?m)^(?<prefix>version\s*=\s*")[^"]+(?<suffix>")(?=\r?$)'
  }
)
Update-VersionFile "src-tauri/Cargo.lock" @(
  @{
    Label = "scrypuppy package version"
    Pattern = '(?ms)(?<prefix>^\[\[package\]\]\r?\nname\s*=\s*"scrypuppy"\r?\nversion\s*=\s*")[^"]+(?<suffix>")'
  }
)
Update-VersionFile "src-tauri/tauri.conf.json" @(
  @{
    Label = "application version"
    Pattern = '(?m)^(?<prefix>  "version":\s*")[^"]+(?<suffix>",)(?=\r?$)'
  }
)
Update-VersionFile "README.md" @(
  @{
    Label = "current package version"
    Pattern = '(?m)^(?<prefix>> ScryPuppy 1\.0 is in beta\. The current package version is `)[^`]+(?<suffix>`\.)(?=\r?$)'
  },
  @{
    Label = "current installer name"
    Pattern = '(?m)^(?<prefix>> `)ScryPuppy_beta_installer_v[^`]+(?<suffix>`\.)(?=\r?$)'
    Value = $installerName
  }
)

$metadata = (& (Join-Path $PSScriptRoot "release-metadata.ps1")) | ConvertFrom-Json
if ($metadata.manifest_version -ne $Version) {
  throw "Release version validation returned '$($metadata.manifest_version)' instead of '$Version'."
}

Write-Host "ScryPuppy release version set to $Version."
