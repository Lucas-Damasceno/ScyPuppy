# Windows release build

This guide documents the supported ScryPuppy 1.0 Beta packaging path.

## Build command

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

The current beta version is `1.0.0-beta.4`, which produces:

```text
ScryPuppy_1.0.0-beta.4_x64-setup.exe
```

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

## Public beta checklist

1. Confirm that all version files agree.
2. Run `npm run build` and the relevant Rust checks.
3. Review the main workspace, Context picker, Documents, Ask ScryPuppy, and Settings in English.
4. Close every running ScryPuppy instance.
5. Run `npm run build:windows`.
6. Record the installer size and SHA-256 checksum.
7. Commit and push the exact source used for the build.
8. Create a version tag.
9. Publish a GitHub prerelease with English notes and attach the NSIS installer.

Until the beta flag is removed, GitHub releases should remain marked as prereleases and describe privacy defaults, supported Windows versions, and known beta limitations.
