# ADR 0001: Windows multi-format clipboard snapshots

- Status: Accepted
- Date: 2026-07-15
- Scope: Windows clipboard capture, persistence, search, and restore

## Context

The previous clipboard domain selected either text or image. That model discarded the other representations published by Windows applications and could not preserve files, folders, shortcuts, executables, rich text, URLs, or shell virtual files such as Outlook attachments.

Windows clipboard producers commonly publish several equivalent representations for one copy operation. A consumer should retain the richest supported representation while preserving fallbacks for applications with narrower paste support.

## Decision

ScryPuppy treats one clipboard change as an immutable `ClipboardSnapshot` containing ordered representations and format metadata. A dedicated STA thread owns OLE and native clipboard access. The `WM_CLIPBOARDUPDATE` listener remains event-driven and delegates reads to that service.

Supported representations are:

- Unicode plain text;
- HTML plus its plain-text fallback;
- RTF plus its plain-text fallback;
- URL plus its plain-text fallback;
- RGBA image restored as `CF_DIBV5`;
- physical files, folders, shortcuts, and executables from `CF_HDROP`;
- shell virtual files from `FileGroupDescriptorW` and `FileContents`.

Unknown registered formats are retained as metadata only. Private bytes are not copied without an explicit, reviewed adapter.

The database stores representations, file entries, and the advertised Windows format list separately. Physical items remain references. Virtual file content is materialized atomically in the local data boundary with sanitized names, integrity hashes, and bounded sizes. Restoring a capture republishes every available representation together and marks file drops as copy operations.

This is a breaking schema contract. There is no legacy representation reader, dual write, or backfill path.

## Security and privacy

- Executables are represented as files and are never launched.
- UNC paths are not statted during passive capture.
- Virtual filenames cannot escape their capture vault.
- File bytes, full paths, images, and unknown clipboard formats are not sent to AI providers.
- HTML is stored for restoration but never injected into the webview.
- Interrupted materialization leaves `.part` files that startup recovery removes.

## Consequences

The clipboard domain is more complex, but capture and paste behavior are now symmetric and extensible. Additional proprietary formats require a named adapter, limits, persistence rules, round-trip tests, and a UX state before they can be marked supported.

The application can report when a physical source disappeared or a virtual item exceeded safety limits instead of silently pasting a filename as text.
