# Windows CI and release

This guide documents the supported ScryPuppy 1.0 Beta packaging path.

## Supported release path

The Actions page exposes three workflows with distinct responsibilities:

- **Windows CI** (`.github/workflows/windows-ci.yml`) validates pull requests that
  affect the application or release pipeline. It builds and smoke-tests an unsigned
  installer without publishing anything.
- **Beta Release** (`.github/workflows/automatic-beta-release.yml`) reacts only to
  merged `feat/` and `fix/` pull requests and queues the next automatic beta.
- **Windows Release** (`.github/workflows/windows-release.yml`) performs signed
  packaging and publication for the beta orchestrator. It also provides the manual
  and tag-based recovery path.

The CI and release workflows deliberately have separate permission boundaries. CI
has read-only repository access and cannot publish releases; both paths invoke the
same checked-in validation commands and `scripts/build-windows.ps1` so the installer
construction and startup probe remain consistent.

Merging a pull request whose source branch starts with `feat/` or `fix/` queues an
automatic beta release. The workflow increments the beta number, runs the same
validation and packaging job, creates the version tag, publishes the prerelease,
and synchronizes the released version back to `main`.

Pushing a matching version tag manually remains supported. It runs the same job,
generates build provenance, and publishes a GitHub prerelease with the installer,
its SHA-256 checksum, and its Tauri updater signature.

The workflow uses only official GitHub actions pinned to immutable commit SHAs. Its
temporary Actions artifact expires after one day; the installer attached to the
GitHub Release remains the supported public download.

## Local build command

From the repository root, run:

```powershell
npm run build:windows
```

Do not substitute a plain `cargo build --release` when creating an installer.

## Version consistency

The release version must match in:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

The internal version keeps SemVer prerelease syntax. The public installer converts
the beta sequence into the final numeric component. For example,
`1.0.0-beta.5` produces:

```text
ScryPuppy_beta_installer_v1.0.5.exe
```

For example, `1.0.0-beta.6` produces
`ScryPuppy_beta_installer_v1.0.6.exe`. The package remains an NSIS `.exe`, not MSI.

`scripts/release-metadata.ps1` is the single source of truth for this mapping. It
also fails the build if any version manifest disagrees.

## What the script does

`scripts/build-windows.ps1` performs the complete release sequence:

1. Runs the Tauri build with the `custom-protocol` feature.
2. Generates the current NSIS definition.
3. Cleans only the ScryPuppy Rust package.
4. Rebuilds the locked release binary with `custom-protocol`.
5. Refuses to continue if another ScryPuppy process is running.
6. Launches the release executable and verifies that it remains alive for 12 seconds.
7. Records the binary SHA-256 before packaging.
8. Packages the multilingual NSIS installer.
9. Verifies that packaging did not mutate the release binary.
10. Moves the final installer to the supported bundle directory.
11. Signs that final installer when an updater signing key is available.

Output is written to:

```text
src-tauri/target/release/bundle/nsis/
```

## Signed in-app updates

Installed beta versions check the fixed updater channel:

```text
https://github.com/Lucas-Damasceno/ScryPuppy/releases/download/updater-beta/latest.json
```

The automatic release workflow publishes each installer and `.sig` file to its
versioned prerelease. It then updates `latest.json` in the `updater-beta` release
with the version, release notes, installer URL, publication date, and signature.
The private signing key is never stored in the repository or in an Actions
artifact.

Repository Actions secrets required for publishing are:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The matching public key is embedded in `src-tauri/tauri.conf.json`. Losing or
rotating the private key prevents already-installed versions from trusting future
updates, so the key and password must be backed up securely outside the repository.

Pull-request validation builds intentionally receive neither secret. They still
build and smoke-test the installer, but skip distributable updater artifacts.
Release and automatic post-merge builds fail early if the signing key is absent.

Unsigned builds pass this override to Tauri through a temporary JSON file. Keep it
as a file path: forwarding inline JSON through PowerShell and npm on Windows strips
the property-name quotes before Tauri parses the argument. The temporary file is
removed in a `finally` block even when the build fails.

For a signed local build, load the private key contents and password into the
environment before running the supported build command:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\ScryPuppy-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw "$HOME\.tauri\ScryPuppy-updater.key.password"
npm run build:windows
```

## Why `custom-protocol` is mandatory

Tauri uses `custom-protocol` to distinguish a packaged application from development mode. Without it, an `App` webview resolves to the configured development URL (`http://localhost:1420`). An installed application would then show a connection error because no Vite server is running.

The Rust crate maps its local `custom-protocol` feature to `tauri/custom-protocol`. Release compilation also has a `compile_error!` guard, so an invalid release command fails instead of silently producing a development-mode executable.

## Startup ordering safeguard

Configured windows are created manually after database state and required plugins are registered. A webview can call Rust commands immediately during creation, so state used by initial Settings requests must already exist.

Autostart is therefore initialized before the first webview. Settings commands also use non-panicking state access as a defensive fallback. The 12-second startup probe is long enough for the frontend to load and issue its initial commands; a simple process-launch assertion is not sufficient.

## Packaging incident retained as a regression note

An earlier alpha packaging script generated the NSIS definition correctly, then replaced the Tauri release binary with a plain Cargo release build. That second binary did not include `custom-protocol` and attempted to load `localhost` after installation.

The current safeguards exist to prevent that class of failure:

- Both release compilations explicitly enable `custom-protocol`.
- Missing `custom-protocol` fails at compile time.
- The release executable is exercised before packaging.
- The executable hash must remain stable during NSIS generation.

## Automatic public beta release

1. Create the pull request from a branch named `feat/<description>` or
   `fix/<description>`.
2. Review and merge the pull request into `main`.
3. **Beta Release** serializes the request with any other pending release.
4. **Windows Release** calculates the next unused beta number and updates
   every package manifest plus the current version shown in the README.
5. The workflow tests and packages the exact merged commit, creates an annotated
   tag associated with the pull request, publishes the `.exe`, `.sha256`, and
   provenance attestation, then synchronizes the released version to `main`.

Closed pull requests that were not merged, branches without the supported prefix,
and the workflow's own version-sync commit do not create releases. Re-running a
release for the same pull request reuses its annotated tag instead of consuming a
new beta number.

Manual version tags remain available as a recovery and maintenance path.

For a non-publishing verification run, open a pull request that changes an application
or release-pipeline file. Use the manual **Windows Release** dispatch only for release
recovery or maintenance; it is not the pull-request CI entry point.

Until the beta flag is removed, GitHub releases should remain marked as prereleases and describe privacy defaults, supported Windows versions, and known beta limitations.
