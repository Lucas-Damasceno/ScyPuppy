param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$PullRequestNumber,
  [switch]$GitHubOutput
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseMetadataScript = Join-Path $PSScriptRoot "release-metadata.ps1"
$setVersionScript = Join-Path $PSScriptRoot "set-release-version.ps1"
$releaseMarker = "ScryPuppy-PR:$PullRequestNumber"

Push-Location $repoRoot
try {
  & git fetch --force --tags origin
  if ($LASTEXITCODE -ne 0) {
    throw "Could not fetch release tags from origin."
  }

  $matchingTags = @()
  $tagRecords = @(
    & git for-each-ref `
      '--format=%(refname:short)%09%(contents:subject)' `
      'refs/tags/v*.*.0-beta.*'
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect existing release tags."
  }
  foreach ($record in $tagRecords) {
    $parts = $record -split "`t", 2
    if ($parts.Count -eq 2 -and $parts[1] -eq $releaseMarker) {
      $matchingTags += $parts[0]
    }
  }
  if ($matchingTags.Count -gt 1) {
    throw "More than one automatic release tag exists for PR #$PullRequestNumber."
  }

  $existingReleaseTag = $matchingTags.Count -eq 1
  if ($existingReleaseTag) {
    & git checkout --detach $matchingTags[0]
    if ($LASTEXITCODE -ne 0) {
      throw "Could not check out existing release tag '$($matchingTags[0])'."
    }
  } else {
    $currentMetadata = (& $releaseMetadataScript) | ConvertFrom-Json
    $currentMatch = [regex]::Match(
      $currentMetadata.manifest_version,
      '^(?<major>\d+)\.(?<minor>\d+)\.0-beta\.(?<beta>\d+)$'
    )
    if (-not $currentMatch.Success) {
      throw "Current release version is not a supported beta version."
    }

    $major = [int]$currentMatch.Groups["major"].Value
    $minor = [int]$currentMatch.Groups["minor"].Value
    $highestBeta = [int]$currentMatch.Groups["beta"].Value
    foreach ($tag in @(& git tag --list "v$major.$minor.0-beta.*")) {
      $tagMatch = [regex]::Match(
        $tag,
        "^v$major\.$minor\.0-beta\.(?<beta>\d+)$"
      )
      if ($tagMatch.Success) {
        $highestBeta = [Math]::Max(
          $highestBeta,
          [int]$tagMatch.Groups["beta"].Value
        )
      }
    }

    $nextVersion = "$major.$minor.0-beta.$($highestBeta + 1)"
    & $setVersionScript -Version $nextVersion
  }

  $metadata = (& $releaseMetadataScript) | ConvertFrom-Json
  if (
    $existingReleaseTag -and
    $metadata.release_tag -ne $matchingTags[0]
  ) {
    throw "Existing PR release tag '$($matchingTags[0])' contains manifest version '$($metadata.manifest_version)'."
  }
  $result = [ordered]@{}
  foreach ($property in $metadata.PSObject.Properties) {
    $result[$property.Name] = $property.Value
  }
  $result["automatic_release"] = "true"
  $result["existing_release_tag"] = $existingReleaseTag.ToString().ToLowerInvariant()
  $result["pull_request_number"] = $PullRequestNumber

  if ($GitHubOutput) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
      throw "GITHUB_OUTPUT is required when -GitHubOutput is used."
    }
    foreach ($entry in $result.GetEnumerator()) {
      "$($entry.Key)=$($entry.Value)" >> $env:GITHUB_OUTPUT
    }
  } else {
    [pscustomobject]$result | ConvertTo-Json -Compress
  }
} finally {
  Pop-Location
}
