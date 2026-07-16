# Windows build and release

This guide documents the supported ScryPuppy 1.0 Beta packaging path.

## Supported release path

Public builds are produced by `.github/workflows/windows-release.yml` on a standard
GitHub-hosted Windows runner. Pull requests that affect the application or release
pipeline run the complete validation and packaging job without publishing a release.

Merging a pull request whose source branch starts with `feat/` or `fix/` queues an
automatic beta release. The workflow increments the beta number, runs the same
validation and packaging job, creates the version tag, publishes the prerelease,
and synchronizes the released version back to `main`.

Pushing a matching version tag manually remains supported. It runs the same job,
generates build provenance, and publishes a GitHub prerelease with the installer
and its SHA-256 checksum.

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

Output is written to:

```text
src-tauri/target/release/bundle/nsis/
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
3. **Automatic beta release** serializes the request with any other pending release.
4. **Windows build and release** calculates the next unused beta number and updates
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
or release-pipeline file, or manually dispatch the workflow from the Actions page after
the workflow exists on the default branch.

Until the beta flag is removed, GitHub releases should remain marked as prereleases and describe privacy defaults, supported Windows versions, and known beta limitations.
