# ScryPuppy architecture

This document describes the Windows-first ScryPuppy 1.0 Beta implementation. The repository is the source of truth; update this file whenever command boundaries, persistence, window behavior, packaging, or security assumptions change.

## System overview

```mermaid
flowchart LR
    User[Windows user] --> Shortcuts[Global shortcuts]
    Shortcuts --> Rust[Rust and Tauri backend]
    ClipboardListener[Native clipboard listener] --> Rust
    React[React windows] -->|typed commands and events| Rust
    Rust --> Clipboard[Windows clipboard and foreground window]
    Rust --> DB[(SQLCipher SQLite)]
    Rust --> Assets[Local assets and exports]
    Rust --> Creds[Windows Credential Manager]
    Rust --> OCR[Windows OCR]
    Rust -. explicit request .-> AI[Configured AI provider]
```

ScryPuppy runs as one Tauri process with a React frontend and Rust backend. Rust owns clipboard access, operating-system metadata, persistence, encryption, OCR, global shortcuts, native window behavior, and AI adapters. The frontend receives only the domain data required to render each surface.

## Application surfaces

Window definitions live in `src-tauri/tauri.conf.json`.

| Surface | Label | Purpose | Behavior |
| --- | --- | --- | --- |
| Main workspace | `main` | Browse captures, Contexts, documents, and Settings | Standard 1100×720 window |
| Quick Paste | `paste` | Search and paste clipboard history | Frameless, always on top, keyboard focused |
| Quick Context | `quick-context` | Associate a newly saved capture | Frameless, always on top, avoids stealing focus initially |
| Ask ScryPuppy | `magic-search` | Return a focused answer or create a cited document | Frameless, resizable, always on top |

`src/App.tsx` selects the UI by Tauri window label. Secondary windows render only their own focused React tree and do not load the complete main workspace.

Each secondary window has a minimal capability file in `src-tauri/capabilities/`. Only the main window receives autostart access.

## Source map

### Frontend

- `src/features/lite/LiteMainApp.tsx` — context-first capture and document workspace.
- `src/features/lite/LiteMagicPalette.tsx` — quick answers and cited document creation.
- `src/features/lite/LiteDocumentsWorkspace.tsx` — editable Markdown, versions, and evidence management.
- `src/features/lite/AddItemsToContextDialog.tsx` — local filtering and transactional multi-assignment.
- `src/features/lite/CaptureDetailsDialog.tsx` — source metadata, Context membership, assets, and OCR.
- `src/components/OnboardingTutorial.tsx` — six-step first-run and replayable onboarding.
- `src/components/SettingsControls.tsx` — shared controls used by Settings and onboarding.
- `src/hooks/useSettingsCoordinator.ts` — optimistic settings state and serialized persistence.
- `src/api/tauri.ts` — typed frontend command boundary.
- `src/types.ts` — frontend domain contracts.
- `src/i18n.ts` — English source strings and Brazilian Portuguese translations.
- `src/dev/docsPreview.ts` — development-only, synthetic data bridge for reproducible documentation screenshots.

### Native backend

- `src-tauri/src/lib.rs` — commands, database initialization, migrations, capture orchestration, OCR scheduling, Windows integration, and window lifecycle.
- `src-tauri/src/clipboard_monitor.rs` — Windows message-only listener, sequence handling, queue, and persistence worker.
- `src-tauri/src/ai.rs` — provider catalog and AI adapters.
- `src-tauri/src/crypto.rs` — export encryption and hashing helpers.
- `src-tauri/src/main.rs` — process entry point.

The frontend deliberately uses React state and hooks rather than a second global state framework.

## Capture pipeline

### Explicit capture

```mermaid
sequenceDiagram
    participant U as User
    participant R as Rust backend
    participant W as Foreground app
    participant C as Clipboard
    participant D as SQLCipher database
    participant Q as Quick Context

    U->>R: Ctrl+Shift+C or Ctrl+Shift+S
    R->>W: Simulate Copy
    W->>C: Publish selected content
    R->>C: Read text or image
    R->>R: Collect foreground metadata
    R->>R: Detect recent duplicate
    R->>D: Persist capture, entities, and assets
    opt Supported image
        R->>D: Queue local OCR job
    end
    R-->>Q: Emit final capture ID after commit
```

Important guarantees:

- The capture exists before Quick Context is opened.
- Closing Quick Context never discards a capture.
- Duplicate or failed captures do not open Quick Context.
- Internal clipboard writes and Quick Paste restoration do not create captures.
- A capture ID and generation guard prevent delayed overlay events from mutating the wrong record.

### Optional clipboard monitor

`WM_CLIPBOARDUPDATE` is handled on a dedicated Windows message-only thread. The listener starts from the current clipboard sequence number, reads text before images, collects active-window metadata, and sends payloads to a serialized persistence worker. It never simulates a keyboard copy.

Explicit hotkeys and automatic copies share the same persistence path. Automatic copies always use the regular capture kind, enter the unassigned collection, and record their origin in metadata.

| Origin | Screenshot policy | Quick Context policy |
| --- | --- | --- |
| Explicit regular capture | `capture_screenshots` | `quick_context_enabled` |
| Explicit reference | Reference behavior | Global toggle plus `quick_context_after_reference` |
| Clipboard monitor | `clipboard_monitor_capture_screenshots` | Global toggle plus `clipboard_monitor_quick_context_enabled` |
| File import | No clipboard screenshot | Never opens Quick Context |

Automatic monitoring and both automatic side effects default to off.

## Persistence model

The encrypted SQLite schema is created and evolved in `migrate()`.

| Table | Responsibility |
| --- | --- |
| `captures` | Content, hashes, timestamps, source metadata, platform, and capture kind |
| `capture_assets` | Clipboard images, imported images, screenshots, status, and local paths |
| `contexts` | User-managed normalized Contexts |
| `capture_contexts` | Many-to-many Context assignments with origin and confidence |
| `capture_tags` | Deterministic content descriptors |
| `capture_entities` | URLs, paths, applications, hashes, UUIDs, and other anchors |
| `capture_ocr` | Latest OCR result for each capture |
| `ocr_jobs` | Recoverable background OCR queue |
| `settings` | Local preferences and onboarding completion |
| `magic_search_documents` | Versioned generated Markdown and saved filters |
| `magic_search_evidence` | Durable ranked evidence snapshots |

`capture_contexts` uses `(capture_id, context_id)` as its primary key, so repeated assignments are idempotent. Deleting a Context removes associations but not capture records.

The Lite workspace exposes **Everything**, user-created Contexts, and Documents. Backend compatibility still distinguishes ordinary unassigned captures and durable references for migrations and command behavior.

## Context organization

Users can create a Context, assign it from capture details, or add several existing captures through a local-only picker. Bulk assignment is validated and committed in one Rust transaction.

The backend retains deterministic and optional AI-assisted organization for compatibility. Local analysis considers URLs, repositories, applications, window titles, paths, commands, hashes, UUIDs, tags, entities, existing Contexts, and temporal proximity. Suggestions are reviewable and never remove manual associations.

Optional AI receives bounded text and metadata only. Images and screenshots are excluded, and local results remain available if a provider fails.

## Search and documents

- Local Search filters stored captures without an external request.
- Ask ScryPuppy ranks local evidence before invoking an explicitly configured provider.
- Quick-answer mode returns a focused result with its evidence.
- Document mode creates editable, versioned Markdown with numbered sources.
- Evidence snapshots remain durable so a document keeps its source trail.
- Export is performed locally by Rust commands.

The Ask ScryPuppy webview remains alive while hidden. Contexts are refreshed on every `magic-search-opened` event, not only at React mount. Removed Context selections are reset before preview or generation.

## Settings and onboarding

Settings use a typed `Settings`/`SettingsDto` contract backed by the encrypted database. Sensitive AI key material is not returned in ordinary frontend state; only a configured flag is exposed.

`onboarding_completed` is paired with `onboarding_completed_version`. The welcome opens when the installed version differs from the last completed version. Replaying it from Settings does not reset data, defaults, credentials, or completion state.

All plugins and managed state required by startup commands are registered before the first webview is created. Settings commands use non-panicking state access as a defensive fallback.

## Security boundaries

- SQLite records are encrypted with bundled SQLCipher.
- Database and AI credentials use Windows Credential Manager.
- Encrypted Context exports use AES-256-GCM.
- Clipboard content is not sent externally by default.
- AI requires an explicit user action.
- Images and screenshots are excluded from AI requests.
- Clipboard content and credentials must never be written to logs.
- No analytics or telemetry are included.

## Build and packaging

The supported Windows build is:

```powershell
npm run build:windows
```

The script compiles the Vite frontend, builds Tauri with `custom-protocol`, recompiles a clean locked Rust release, performs a 12-second startup check, and packages one multilingual NSIS installer.

Artifacts are written under `src-tauri/target/release/bundle/`. See [docs/windows-build.md](docs/windows-build.md) for the release guardrails.

## Change checklist

When changing a command, setting, or domain contract:

1. Update Rust DTOs and persistence.
2. Update `src/types.ts`.
3. Keep calls behind `src/api/tauri.ts`.
4. Add English and Brazilian Portuguese UI strings.
5. Review window-specific capabilities.
6. Review privacy defaults and migration behavior.
7. Run frontend compilation, Rust checks, and the production Windows build when applicable.
