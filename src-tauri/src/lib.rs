#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!(
    "ScryPuppy release builds require the `custom-protocol` feature; use `npm run build:windows`"
);

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    thread,
    time::Duration,
};

use active_win_pos_rs::get_active_window;
use arboard::ImageData;
use chrono::{DateTime, Local, Utc};
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings as EnigoSettings,
};
use image::{ImageBuffer, Rgba};
use keyring::{Entry as CredentialEntry, Error as CredentialError};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use uuid::Uuid;

mod ai;
mod app_error;
mod clipboard;
mod clipboard_monitor;
mod crypto;
use ai::ProviderOption as AiProviderOption;
use app_error::{command_result, AppError, AppNotice, CommandResult};
use clipboard::{
    ClipboardFile, ClipboardFileAvailability, ClipboardFileKind, ClipboardImage,
    ClipboardRepresentation, ClipboardRepresentationKind, ClipboardService, ClipboardSnapshot,
};
use clipboard_monitor::ClipboardMonitorHandle;
use crypto::{encrypt_context_file, sha256_hex};

#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const INBOX_CONTEXT_ID: &str = "inbox";
const CONTENT_BASE_CONTEXT_ID: &str = "content-base";
const HOTKEY: &str = "CommandOrControl+Shift+C";
const REFERENCE_HOTKEY: &str = "CommandOrControl+Shift+S";
const PASTE_HOTKEY: &str = "CommandOrControl+Shift+V";
const MAGIC_HOTKEY: &str = "CommandOrControl+Shift+F";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const DUPLICATE_CAPTURE_IGNORED: &str = "DUPLICATE_CAPTURE_IGNORED";
const CREDENTIAL_SERVICE: &str = "Scryppy";
const DATABASE_KEY_CREDENTIAL: &str = "database-key-v1";
const CONTEXT_KEY_CREDENTIAL: &str = "context-key-v1";
const AI_KEY_CREDENTIAL: &str = "ai-api-key-v1";

fn default_quick_context_enabled() -> bool {
    true
}
fn default_quick_context_after_reference() -> bool {
    false
}
fn default_quick_context_timeout_seconds() -> i64 {
    8
}
fn default_quick_context_show_preview() -> bool {
    true
}
fn default_quick_context_show_recent() -> bool {
    true
}
fn default_clipboard_monitor_enabled() -> bool {
    false
}
fn default_clipboard_monitor_capture_screenshots() -> bool {
    false
}
fn default_clipboard_monitor_quick_context_enabled() -> bool {
    false
}

#[derive(Clone)]
struct AppState {
    app_dir: PathBuf,
    database_key: String,
    context_key: String,
    capture_gate: Arc<Mutex<CaptureGate>>,
    ignored_clipboard_sequences: Arc<Mutex<SequenceSuppression>>,
    clipboard: Arc<ClipboardService>,
    clipboard_monitor: Arc<ClipboardMonitorHandle>,
    ocr_worker_running: Arc<Mutex<bool>>,
    paste_target_window: Arc<Mutex<Option<isize>>>,
}

struct CaptureGate {
    in_progress: bool,
}

#[derive(Default)]
struct SequenceSuppression {
    values: VecDeque<u32>,
}

impl SequenceSuppression {
    const MAX_VALUES: usize = 64;

    fn record(&mut self, sequence: u32) {
        self.values.retain(|value| *value != sequence);
        self.values.push_back(sequence);
        while self.values.len() > Self::MAX_VALUES {
            self.values.pop_front();
        }
    }

    fn consume(&mut self, sequence: u32) -> bool {
        let Some(index) = self.values.iter().position(|value| *value == sequence) else {
            return false;
        };
        self.values.remove(index);
        true
    }
}

impl AppState {
    fn ignore_clipboard_sequence(&self, sequence: u32) {
        if let Ok(mut values) = self.ignored_clipboard_sequences.lock() {
            values.record(sequence);
        }
    }

    fn consume_ignored_clipboard_sequence(&self, sequence: u32) -> bool {
        self.ignored_clipboard_sequences
            .lock()
            .map(|mut values| values.consume(sequence))
            .unwrap_or(false)
    }
}

struct CaptureSession {
    gate: Arc<Mutex<CaptureGate>>,
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.in_progress = false;
        }
    }
}

impl AppState {
    fn db_path(&self) -> PathBuf {
        self.app_dir.join("scryppy.sqlite")
    }

    fn markdown_dir(&self) -> PathBuf {
        self.app_dir.join("markdown").join("contexts")
    }

    fn screenshots_dir(&self) -> PathBuf {
        self.app_dir.join("assets").join("screenshots")
    }

    fn clipboard_images_dir(&self) -> PathBuf {
        self.app_dir.join("assets").join("clipboard-images")
    }

    fn clipboard_files_dir(&self) -> PathBuf {
        self.app_dir.join("assets").join("clipboard-files")
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ContextDto {
    id: String,
    name: String,
    normalized_name: String,
    slug: String,
    created_at: String,
    updated_at: String,
    capture_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ContextAssignmentDto {
    id: String,
    name: String,
    normalized_name: String,
    slug: String,
    created_at: String,
    updated_at: String,
    capture_count: i64,
    assignment_origin: String,
    confidence: Option<f64>,
    assigned_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CategoryDto {
    tag: String,
    capture_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureAssetDto {
    id: String,
    kind: String,
    path: Option<String>,
    status: String,
    error: Option<String>,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureRepresentationDto {
    id: String,
    kind: String,
    format_name: String,
    mime_type: Option<String>,
    text_content: Option<String>,
    asset_path: Option<String>,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    restorable: bool,
    metadata: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureFileDto {
    id: String,
    representation_id: String,
    ordinal: i64,
    display_name: String,
    original_path: Option<String>,
    local_path: Option<String>,
    entry_kind: String,
    extension: Option<String>,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    availability: String,
    metadata: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureClipboardFormatDto {
    id: i64,
    name: String,
    supported: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureDto {
    id: String,
    content_text: String,
    captured_at: String,
    source_app_name: Option<String>,
    source_app_id: Option<String>,
    source_process_id: Option<i64>,
    source_process_path: Option<String>,
    window_title: Option<String>,
    window_id: Option<String>,
    platform: String,
    kind: String,
    content_kind: String,
    metadata: Value,
    assets: Vec<CaptureAssetDto>,
    representations: Vec<CaptureRepresentationDto>,
    files: Vec<CaptureFileDto>,
    clipboard_formats: Vec<CaptureClipboardFormatDto>,
    tags: Vec<String>,
    entities: Vec<CaptureEntityDto>,
    ocr: Option<CaptureOcrDto>,
    contexts: Vec<ContextAssignmentDto>,
}

#[derive(Debug, Serialize)]
struct CapturePageDto {
    items: Vec<CaptureDto>,
    total: usize,
}

#[derive(Debug, Deserialize)]
struct CaptureFilter {
    context_id: Option<String>,
    search: Option<String>,
    tag: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SettingsDto {
    capture_screenshots: bool,
    launch_at_startup: bool,
    language: String,
    hotkey: String,
    reference_hotkey: String,
    paste_hotkey: String,
    data_dir: String,
    ai_provider: String,
    ai_model: String,
    ai_api_key: String,
    ai_api_key_configured: bool,
    #[serde(default = "default_quick_context_enabled")]
    quick_context_enabled: bool,
    #[serde(default = "default_quick_context_after_reference")]
    quick_context_after_reference: bool,
    #[serde(default = "default_quick_context_timeout_seconds")]
    quick_context_timeout_seconds: i64,
    #[serde(default = "default_quick_context_show_preview")]
    quick_context_show_preview: bool,
    #[serde(default = "default_quick_context_show_recent")]
    quick_context_show_recent: bool,
    #[serde(default)]
    onboarding_completed: bool,
    #[serde(default = "default_clipboard_monitor_enabled")]
    clipboard_monitor_enabled: bool,
    #[serde(default = "default_clipboard_monitor_capture_screenshots")]
    clipboard_monitor_capture_screenshots: bool,
    #[serde(default = "default_clipboard_monitor_quick_context_enabled")]
    clipboard_monitor_quick_context_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    query: String,
    context_id: Option<String>,
    app: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ChatAnswer {
    answer: String,
    confidence: String,
    evidence: Vec<EvidenceItem>,
    suggested_actions: Vec<SuggestedAction>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct MagicSearchRequest {
    query: String,
    context_id: Option<String>,
    tag: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    limit: Option<usize>,
    previous_document_id: Option<String>,
    #[serde(default)]
    response_mode: Option<String>,
}

#[derive(Debug, Serialize)]
struct MagicSearchDocumentDto {
    id: String,
    root_id: String,
    previous_document_id: Option<String>,
    version: i64,
    title: String,
    query: String,
    markdown: String,
    provider: String,
    model: String,
    filters: MagicSearchRequest,
    generation_warning: Option<AppNotice>,
    evidence_count: i64,
    created_at: String,
    evidence: Vec<EvidenceItem>,
    response_mode: String,
    sensitive_value: Option<String>,
    answer_value: Option<String>,
}

#[derive(Debug, Serialize)]
struct MagicSearchListItemDto {
    id: String,
    root_id: String,
    version: i64,
    title: String,
    query: String,
    provider: String,
    model: String,
    evidence_count: i64,
    created_at: String,
    response_mode: String,
}

#[derive(Debug, Serialize)]
struct MagicSearchPreviewDto {
    evidence_count: usize,
    available_count: usize,
}

#[derive(Clone, Debug, Serialize)]
struct MagicSearchOpenPayload<'a> {
    query: Option<&'a str>,
    response_mode: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct TagDocumentDto {
    tag: String,
    markdown: String,
    capture_count: usize,
    app_count: usize,
    context_count: usize,
    period_start: Option<String>,
    period_end: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct EvidenceItem {
    capture_id: String,
    captured_at: String,
    context_names: Vec<String>,
    app_name: Option<String>,
    application_id: Option<String>,
    window_title: Option<String>,
    excerpt: String,
    matched_fields: Vec<String>,
    asset_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SuggestedAction {
    label: String,
    action: String,
    payload: Value,
}

struct ScoredCapture {
    capture: CaptureDto,
    score: i32,
    matched_fields: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ActiveWindowMetadata {
    title: Option<String>,
    process_path: Option<String>,
    app_name: Option<String>,
    window_id: Option<String>,
    process_id: Option<u64>,
    position: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CaptureOrigin {
    ExplicitHotkey,
    ClipboardMonitor,
    FileImport,
}

#[derive(Debug, Serialize, Clone)]
struct CaptureCreatedEvent {
    capture: CaptureDto,
    origin: CaptureOrigin,
}

#[derive(Debug, Serialize, Clone)]
struct CaptureUpdatedEvent {
    capture: CaptureDto,
}

#[derive(Debug, Serialize, Clone)]
struct CaptureErrorEvent {
    error: AppError,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureEntityDto {
    id: String,
    kind: String,
    value: String,
    source: String,
    confidence: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CaptureOcrDto {
    status: String,
    text: Option<String>,
    error: Option<String>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct CategorizeRequest {
    days: Option<i64>,
    include_ai: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ContextAnalysisResult {
    scanned_count: usize,
    contextualized_count: usize,
    suggestions: Vec<ContextSuggestion>,
    unmatched_capture_ids: Vec<String>,
    ai_message: Option<AppNotice>,
}

#[derive(Debug, Serialize, Clone)]
struct ContextSuggestion {
    id: String,
    name: String,
    existing_context_id: Option<String>,
    capture_ids: Vec<String>,
    reason: String,
    confidence: f64,
    source: String,
}

#[derive(Debug, Deserialize)]
struct ApplyContextSuggestion {
    suggestion_id: String,
    name: String,
    existing_context_id: Option<String>,
    capture_ids: Vec<String>,
    confidence: f64,
}

#[derive(Debug, Serialize)]
struct ApplyContextSuggestionsResult {
    contexts_created: usize,
    associations_added: usize,
}

#[derive(Debug, Serialize)]
struct LibraryCounts {
    all: i64,
    inbox: i64,
    content_base: i64,
}

struct LocalAnalysis {
    tags: Vec<String>,
    entities: Vec<LocalEntity>,
    ocr: CaptureOcrDto,
}

struct LocalEntity {
    kind: String,
    value: String,
    source: String,
    confidence: f64,
}

type ClipboardPayload = ClipboardSnapshot;

#[tauri::command]
async fn run_capture(app: AppHandle, state: State<'_, AppState>) -> CommandResult<CaptureDto> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || {
            run_capture_core(&app, state, "capture", INBOX_CONTEXT_ID)
        })
        .await
        .map_err(err)?,
    )
}

#[tauri::command]
async fn save_reference(app: AppHandle, state: State<'_, AppState>) -> CommandResult<CaptureDto> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || {
            run_capture_core(&app, state, "reference", CONTENT_BASE_CONTEXT_ID)
        })
        .await
        .map_err(err)?,
    )
}

#[tauri::command]
fn copy_text_to_clipboard(state: State<AppState>, text: String) -> CommandResult<()> {
    command_result(write_clipboard_text(state.inner(), &text).map_err(err))
}

#[tauri::command]
async fn copy_capture_to_clipboard(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || copy_capture_to_clipboard_core(&state, &id))
            .await
            .map_err(err)?,
    )
}

fn default_capture_filter() -> CaptureFilter {
    CaptureFilter {
        context_id: None,
        search: None,
        tag: None,
        limit: None,
        offset: None,
    }
}

struct CaptureQueryParts {
    where_clause: String,
    args: Vec<String>,
    search_pattern: Option<String>,
}

fn capture_query_parts(filter: &CaptureFilter) -> CaptureQueryParts {
    let mut args = Vec::new();
    let mut where_parts = Vec::new();

    if let Some(context_id) = filter
        .context_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        if context_id == INBOX_CONTEXT_ID {
            where_parts.push("c.capture_kind <> 'reference' AND NOT EXISTS (SELECT 1 FROM capture_contexts icc WHERE icc.capture_id = c.id)".to_string());
        } else if context_id == CONTENT_BASE_CONTEXT_ID {
            where_parts.push("c.capture_kind = 'reference'".to_string());
        } else {
            where_parts.push("EXISTS (SELECT 1 FROM capture_contexts fcc WHERE fcc.capture_id = c.id AND fcc.context_id = ?)".to_string());
            args.push(context_id.clone());
        }
    }

    let mut search_pattern = None;
    if let Some(search) = filter
        .search
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        where_parts.push(
            "(c.content_text LIKE ?
              OR EXISTS (SELECT 1 FROM capture_representations sr WHERE sr.capture_id = c.id AND sr.text_content LIKE ?)
              OR EXISTS (SELECT 1 FROM capture_file_entries sf WHERE sf.capture_id = c.id AND (sf.display_name LIKE ? OR sf.extension LIKE ?))
              OR o.text LIKE ?
              OR c.source_app_name LIKE ?
              OR c.window_title LIKE ?
              OR EXISTS (SELECT 1 FROM capture_tags st WHERE st.capture_id = c.id AND st.tag LIKE ?)
              OR EXISTS (SELECT 1 FROM capture_entities se WHERE se.capture_id = c.id AND se.value LIKE ?)
              OR EXISTS (SELECT 1 FROM capture_contexts scc
                         JOIN contexts sco ON sco.id = scc.context_id
                         WHERE scc.capture_id = c.id AND sco.name LIKE ?))"
                .to_string(),
        );
        let pattern = format!("%{}%", search.trim());
        for _ in 0..10 {
            args.push(pattern.clone());
        }
        search_pattern = Some(pattern);
    }

    if let Some(tag) = filter.tag.as_ref().filter(|value| !value.trim().is_empty()) {
        where_parts.push(
            "EXISTS (SELECT 1 FROM capture_tags ct WHERE ct.capture_id = c.id AND ct.tag = ?)"
                .to_string(),
        );
        args.push(tag.clone());
    }

    CaptureQueryParts {
        where_clause: if where_parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_parts.join(" AND "))
        },
        args,
        search_pattern,
    }
}

fn list_captures_from_conn(
    conn: &Connection,
    filter: &CaptureFilter,
) -> Result<Vec<CaptureDto>, String> {
    let limit = filter.limit.unwrap_or(200).clamp(1, 500);
    let offset = filter.offset.unwrap_or(0);

    let mut sql = String::from(
        "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         LEFT JOIN capture_ocr o ON o.capture_id = c.id",
    );
    let parts = capture_query_parts(filter);
    sql.push_str(&parts.where_clause);
    let mut args = parts.args;

    if let Some(pattern) = parts.search_pattern {
        sql.push_str(
            " ORDER BY CASE
                WHEN lower(c.content_text) LIKE lower(?)
                  OR EXISTS (SELECT 1 FROM capture_representations rr WHERE rr.capture_id = c.id AND lower(rr.text_content) LIKE lower(?))
                  OR EXISTS (SELECT 1 FROM capture_file_entries rf WHERE rf.capture_id = c.id AND (lower(rf.display_name) LIKE lower(?) OR lower(rf.extension) LIKE lower(?))) THEN 5
                WHEN lower(o.text) LIKE lower(?) THEN 4
                WHEN lower(c.source_app_name) LIKE lower(?) OR lower(c.window_title) LIKE lower(?) THEN 3
                WHEN EXISTS (SELECT 1 FROM capture_tags ot WHERE ot.capture_id = c.id AND lower(ot.tag) LIKE lower(?))
                  OR EXISTS (SELECT 1 FROM capture_entities oe WHERE oe.capture_id = c.id AND lower(oe.value) LIKE lower(?)) THEN 2
                WHEN EXISTS (SELECT 1 FROM capture_contexts occ
                             JOIN contexts oco ON oco.id = occ.context_id
                             WHERE occ.capture_id = c.id AND lower(oco.name) LIKE lower(?)) THEN 1
                ELSE 0 END DESC, c.captured_at DESC",
        );
        for _ in 0..10 {
            args.push(pattern.clone());
        }
    } else {
        sql.push_str(" ORDER BY c.captured_at DESC");
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let arg_refs: Vec<&dyn rusqlite::ToSql> = args
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut captures = stmt
        .query_map(&arg_refs[..], capture_base_from_row)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;

    Ok(captures)
}

fn count_captures_from_conn(conn: &Connection, filter: &CaptureFilter) -> Result<usize, String> {
    let parts = capture_query_parts(filter);
    let sql = format!(
        "SELECT COUNT(DISTINCT c.id)
         FROM captures c
         LEFT JOIN capture_ocr o ON o.capture_id = c.id{}",
        parts.where_clause
    );
    let arg_refs: Vec<&dyn rusqlite::ToSql> = parts
        .args
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let count = conn
        .query_row(&sql, &arg_refs[..], |row| row.get::<_, i64>(0))
        .map_err(err)?;
    Ok(count.max(0) as usize)
}

#[tauri::command]
fn list_captures(
    state: State<AppState>,
    filter: Option<CaptureFilter>,
) -> CommandResult<Vec<CaptureDto>> {
    let conn = open_conn(&state)?;
    command_result(list_captures_from_conn(
        &conn,
        &filter.unwrap_or_else(default_capture_filter),
    ))
}

#[tauri::command]
fn list_capture_page(
    state: State<AppState>,
    filter: Option<CaptureFilter>,
) -> CommandResult<CapturePageDto> {
    let conn = open_conn(&state)?;
    let filter = filter.unwrap_or_else(default_capture_filter);
    let total = count_captures_from_conn(&conn, &filter)?;
    let items = list_captures_from_conn(&conn, &filter)?;
    Ok(CapturePageDto { items, total })
}

#[tauri::command]
fn get_capture(state: State<AppState>, id: String) -> CommandResult<Option<CaptureDto>> {
    let conn = open_conn(&state)?;
    let capture = conn
        .query_row(
            "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         WHERE c.id = ?",
            [id],
            capture_base_from_row,
        )
        .optional()
        .map_err(err)?;
    let Some(capture) = capture else {
        return Ok(None);
    };
    let mut captures = vec![capture];
    hydrate_captures(&conn, &mut captures)?;
    Ok(captures.pop())
}

#[tauri::command]
fn delete_capture(state: State<AppState>, id: String) -> CommandResult<()> {
    let mut conn = open_conn(&state)?;
    let assets = assets_for_capture(&conn, &id)?;
    let context_ids = context_ids_for_capture(&conn, &id)?;
    let transaction = conn.transaction().map_err(err)?;
    transaction
        .execute("DELETE FROM captures WHERE id = ?", [&id])
        .map_err(err)?;
    transaction.commit().map_err(err)?;
    for asset in assets {
        if let Some(path) = asset.path {
            let _ = secure_remove_file(Path::new(&path));
        }
    }
    let _ = secure_remove_dir(&state.clipboard_files_dir().join(&id));
    sync_contexts_best_effort(&state, &context_ids);
    Ok(())
}

#[tauri::command]
fn list_contexts(state: State<AppState>) -> CommandResult<Vec<ContextDto>> {
    let conn = open_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT co.id, co.name, co.normalized_name, co.slug, co.created_at, co.updated_at,
                    COUNT(cc.capture_id) AS capture_count
             FROM contexts co
             LEFT JOIN capture_contexts cc ON cc.context_id = co.id
             WHERE co.id NOT IN ('inbox', 'content-base')
             GROUP BY co.id
             ORDER BY lower(co.name)",
        )
        .map_err(err)?;

    let contexts = stmt
        .query_map([], |row| {
            Ok(ContextDto {
                id: row.get(0)?,
                name: row.get(1)?,
                normalized_name: row.get(2)?,
                slug: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                capture_count: row.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(contexts)
}

#[tauri::command]
fn get_library_counts(state: State<AppState>) -> CommandResult<LibraryCounts> {
    let conn = open_conn(&state)?;
    command_result(conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE WHEN capture_kind <> 'reference' AND NOT EXISTS
                    (SELECT 1 FROM capture_contexts cc WHERE cc.capture_id = captures.id) THEN 1 ELSE 0 END),
                SUM(CASE WHEN capture_kind = 'reference' THEN 1 ELSE 0 END)
         FROM captures",
        [],
        |row| Ok(LibraryCounts {
            all: row.get(0)?,
            inbox: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            content_base: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
        }),
    ).map_err(err))
}

#[tauri::command]
fn list_categories(state: State<AppState>) -> CommandResult<Vec<CategoryDto>> {
    let conn = open_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT tag, COUNT(DISTINCT capture_id) AS capture_count
             FROM capture_tags
             GROUP BY tag
             ORDER BY capture_count DESC, tag
             LIMIT 100",
        )
        .map_err(err)?;

    let categories = stmt
        .query_map([], |row| {
            Ok(CategoryDto {
                tag: row.get(0)?,
                capture_count: row.get(1)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(categories)
}

#[tauri::command]
fn delete_all_data(app: AppHandle, state: State<AppState>) -> CommandResult<()> {
    delete_all_data_from_state(&state)?;
    let _ = app.emit("data-reset", Value::Null);
    Ok(())
}

#[tauri::command]
async fn analyze_contexts(
    state: State<'_, AppState>,
    request: CategorizeRequest,
) -> CommandResult<ContextAnalysisResult> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_conn(&state)?;
            analyze_context_suggestions(&conn, &state, request)
        })
        .await
        .map_err(err)?,
    )
}

#[tauri::command]
fn create_context(state: State<AppState>, name: String) -> CommandResult<ContextDto> {
    let name = normalized_context_name(&name)?;
    let normalized_name = normalize_text(&name);
    let mut conn = open_conn(&state)?;
    let now = now();
    let context = ContextDto {
        id: Uuid::new_v4().to_string(),
        slug: unique_slug(&conn, &slugify(&name), None)?,
        name,
        normalized_name,
        created_at: now.clone(),
        updated_at: now,
        capture_count: 0,
    };

    let transaction = conn.transaction().map_err(err)?;
    transaction
        .execute(
            "INSERT INTO contexts (id, name, normalized_name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
            params![
                context.id,
                context.name,
                context.normalized_name,
                context.slug,
                context.created_at,
                context.updated_at
            ],
        )
        .map_err(err)?;
    transaction.commit().map_err(err)?;
    sync_contexts_best_effort(&state, std::slice::from_ref(&context.id));
    Ok(context)
}

#[tauri::command]
fn rename_context(state: State<AppState>, id: String, name: String) -> CommandResult<ContextDto> {
    if id == INBOX_CONTEXT_ID || id == CONTENT_BASE_CONTEXT_ID {
        return Err(AppError::new("context.protected_rename"));
    }

    let name = normalized_context_name(&name)?;
    let normalized_name = normalize_text(&name);
    let mut conn = open_conn(&state)?;
    let old_slug: String = conn
        .query_row("SELECT slug FROM contexts WHERE id = ?", [&id], |row| {
            row.get(0)
        })
        .map_err(err)?;
    let now = now();
    let slug = unique_slug(&conn, &slugify(&name), Some(&id))?;

    let transaction = conn.transaction().map_err(err)?;
    transaction
        .execute(
            "UPDATE contexts SET name = ?, normalized_name = ?, slug = ?, updated_at = ? WHERE id = ?",
            params![name, normalized_name, slug, now, &id],
        )
        .map_err(err)?;
    transaction.commit().map_err(err)?;
    remove_context_export_best_effort(&state, &old_slug);
    sync_contexts_best_effort(&state, std::slice::from_ref(&id));

    list_contexts(state)?
        .into_iter()
        .find(|context| context.id == id)
        .ok_or_else(|| AppError::new("context.not_found"))
}

#[tauri::command]
fn delete_context(state: State<AppState>, id: String) -> CommandResult<()> {
    if id == INBOX_CONTEXT_ID || id == CONTENT_BASE_CONTEXT_ID {
        return Err(AppError::new("context.protected_delete"));
    }

    let mut conn = open_conn(&state)?;
    let old_slug: String = conn
        .query_row("SELECT slug FROM contexts WHERE id = ?", [&id], |row| {
            row.get(0)
        })
        .map_err(err)?;
    let transaction = conn.transaction().map_err(err)?;
    transaction
        .execute("DELETE FROM contexts WHERE id = ?", [&id])
        .map_err(err)?;
    transaction.commit().map_err(err)?;
    remove_context_export_best_effort(&state, &old_slug);
    Ok(())
}

#[tauri::command]
fn add_capture_contexts(
    app: AppHandle,
    state: State<AppState>,
    capture_id: String,
    context_ids: Vec<String>,
) -> CommandResult<()> {
    let mut conn = open_conn(&state)?;
    let transaction = conn.transaction().map_err(err)?;
    validate_capture_exists(&transaction, &capture_id)?;
    for context_id in &context_ids {
        validate_user_context_exists(&transaction, context_id)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO capture_contexts
             (capture_id, context_id, assignment_origin, confidence, created_at)
             VALUES (?, ?, 'manual', NULL, ?)",
                params![&capture_id, context_id, now()],
            )
            .map_err(err)?;
    }
    transaction.commit().map_err(err)?;
    sync_contexts_best_effort(&state, &context_ids);
    app.emit("capture-contexts-updated", &capture_id)
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn add_captures_to_context(
    app: AppHandle,
    state: State<AppState>,
    capture_ids: Vec<String>,
    context_id: String,
) -> CommandResult<usize> {
    if capture_ids.is_empty() {
        return Ok(0);
    }

    let mut conn = open_conn(&state)?;
    let transaction = conn.transaction().map_err(err)?;
    validate_user_context_exists(&transaction, &context_id)?;
    let assigned_at = now();
    let mut added_count = 0;

    for capture_id in &capture_ids {
        validate_capture_exists(&transaction, capture_id)?;
        added_count += transaction
            .execute(
                "INSERT OR IGNORE INTO capture_contexts
                 (capture_id, context_id, assignment_origin, confidence, created_at)
                 VALUES (?, ?, 'manual', NULL, ?)",
                params![capture_id, &context_id, &assigned_at],
            )
            .map_err(err)?;
    }

    transaction.commit().map_err(err)?;
    sync_contexts_best_effort(&state, std::slice::from_ref(&context_id));
    app.emit("capture-contexts-updated", &context_id)
        .map_err(err)?;
    Ok(added_count)
}

#[tauri::command]
fn remove_capture_context(
    app: AppHandle,
    state: State<AppState>,
    capture_id: String,
    context_id: String,
) -> CommandResult<()> {
    let conn = open_conn(&state)?;
    validate_capture_exists(&conn, &capture_id)?;
    conn.execute(
        "DELETE FROM capture_contexts WHERE capture_id = ? AND context_id = ?",
        params![capture_id, context_id],
    )
    .map_err(err)?;
    sync_contexts_best_effort(&state, &[context_id]);
    app.emit("capture-contexts-updated", &capture_id)
        .map_err(err)?;
    Ok(())
}

fn validate_capture_exists(conn: &Connection, capture_id: &str) -> CommandResult<()> {
    let exists = conn
        .query_row("SELECT 1 FROM captures WHERE id = ?", [capture_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(err)?;
    exists.ok_or_else(|| AppError::new("capture.not_found"))
}

fn validate_user_context_exists(conn: &Connection, context_id: &str) -> CommandResult<()> {
    if context_id == INBOX_CONTEXT_ID || context_id == CONTENT_BASE_CONTEXT_ID {
        return Err(AppError::new("context.reserved_collection"));
    }
    let exists = conn
        .query_row("SELECT 1 FROM contexts WHERE id = ?", [context_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(err)?;
    exists.ok_or_else(|| AppError::new("context.not_found"))
}

#[tauri::command]
fn list_recent_contexts(state: State<AppState>) -> CommandResult<Vec<ContextDto>> {
    let conn = open_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT co.id, co.name, co.normalized_name, co.slug, co.created_at, co.updated_at,
                COUNT(DISTINCT all_cc.capture_id) AS capture_count
         FROM contexts co
         JOIN capture_contexts recent_cc ON recent_cc.context_id = co.id
         LEFT JOIN capture_contexts all_cc ON all_cc.context_id = co.id
         WHERE co.id NOT IN ('inbox', 'content-base')
         GROUP BY co.id
         ORDER BY MAX(recent_cc.created_at) DESC,
                  SUM(CASE WHEN recent_cc.assignment_origin = 'manual' THEN 2 ELSE 1 END) DESC
         LIMIT 5",
        )
        .map_err(err)?;
    let contexts = stmt
        .query_map([], |row| {
            Ok(ContextDto {
                id: row.get(0)?,
                name: row.get(1)?,
                normalized_name: row.get(2)?,
                slug: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                capture_count: row.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(contexts)
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<AppState>) -> CommandResult<SettingsDto> {
    let conn = open_conn(&state)?;
    let mut settings = settings_from_conn(&conn, &state)?;
    #[cfg(target_os = "windows")]
    {
        if let Some(autolaunch) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
            if let Ok(enabled) = autolaunch.is_enabled() {
                settings.launch_at_startup = enabled;
            }
        }
    }
    Ok(settings)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: SettingsDto,
) -> CommandResult<SettingsDto> {
    #[cfg(target_os = "windows")]
    {
        if let Some(autolaunch) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
            if let Ok(is_enabled) = autolaunch.is_enabled() {
                if settings.launch_at_startup != is_enabled {
                    if settings.launch_at_startup {
                        let _ = autolaunch.enable();
                    } else {
                        let _ = autolaunch.disable();
                    }
                }
            }
        }
    }
    let conn = open_conn(&state)?;
    set_setting(
        &conn,
        "capture_screenshots",
        if settings.capture_screenshots {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "launch_at_startup",
        if settings.launch_at_startup {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "language",
        if settings.language == "pt-BR" {
            "pt-BR"
        } else {
            "en"
        },
    )?;
    set_setting(&conn, "ai_provider", &settings.ai_provider)?;
    set_setting(&conn, "ai_model", &settings.ai_model)?;
    set_setting(
        &conn,
        "quick_context_enabled",
        if settings.quick_context_enabled {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "quick_context_after_reference",
        if settings.quick_context_after_reference {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "quick_context_timeout_seconds",
        &settings.quick_context_timeout_seconds.to_string(),
    )?;
    set_setting(
        &conn,
        "quick_context_show_preview",
        if settings.quick_context_show_preview {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "quick_context_show_recent",
        if settings.quick_context_show_recent {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "onboarding_completed",
        if settings.onboarding_completed {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting(
        &conn,
        "onboarding_completed_version",
        if settings.onboarding_completed {
            APP_VERSION
        } else {
            ""
        },
    )?;
    persist_clipboard_monitor_settings(&conn, &settings)?;
    if !settings.ai_api_key.trim().is_empty() {
        set_credential(AI_KEY_CREDENTIAL, settings.ai_api_key.trim())?;
    }
    conn.execute("DELETE FROM settings WHERE key = 'ai_api_key'", [])
        .map_err(err)?;
    command_result(settings_from_conn(&conn, &state))
}

fn persist_clipboard_monitor_settings(
    conn: &Connection,
    settings: &SettingsDto,
) -> Result<(), String> {
    for (key, value) in [
        (
            "clipboard_monitor_enabled",
            settings.clipboard_monitor_enabled,
        ),
        (
            "clipboard_monitor_capture_screenshots",
            settings.clipboard_monitor_capture_screenshots,
        ),
        (
            "clipboard_monitor_quick_context_enabled",
            settings.clipboard_monitor_quick_context_enabled,
        ),
    ] {
        set_setting(conn, key, if value { "true" } else { "false" })?;
    }
    Ok(())
}

#[tauri::command]
fn clear_ai_api_key(state: State<AppState>) -> CommandResult<SettingsDto> {
    delete_credential(AI_KEY_CREDENTIAL)?;
    let conn = open_conn(&state)?;
    command_result(settings_from_conn(&conn, &state))
}

#[tauri::command]
fn get_ai_provider_options() -> Vec<AiProviderOption> {
    ai_provider_options()
}

#[tauri::command]
async fn ask_chat(state: State<'_, AppState>, request: ChatRequest) -> CommandResult<ChatAnswer> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_conn(&state)?;
            answer_chat_locally(&conn, &state, request)
        })
        .await
        .map_err(err)?,
    )
}

#[tauri::command]
fn get_tag_document(state: State<AppState>, tag: String) -> CommandResult<TagDocumentDto> {
    let conn = open_conn(&state)?;
    build_tag_document(&conn, &tag)
}

#[tauri::command]
fn export_tag_document(state: State<AppState>, tag: String) -> CommandResult<String> {
    let conn = open_conn(&state)?;
    let document = build_tag_document(&conn, &tag)?;
    command_result(export_markdown(
        &state,
        "tags",
        &document.tag,
        &document.markdown,
    ))
}

#[tauri::command]
async fn generate_magic_search(
    state: State<'_, AppState>,
    request: MagicSearchRequest,
) -> CommandResult<MagicSearchDocumentDto> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_conn(&state)?;
        generate_magic_search_document(&mut conn, &state, request)
    })
    .await
    .map_err(|error| AppError::from(err(error)))?
}

#[tauri::command]
async fn preview_magic_search(
    state: State<'_, AppState>,
    request: MagicSearchRequest,
) -> CommandResult<MagicSearchPreviewDto> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_conn(&state)?;
            preview_magic_search_document(&conn, request)
        })
        .await
        .map_err(err)?,
    )
}

#[tauri::command]
fn list_magic_searches(state: State<AppState>) -> CommandResult<Vec<MagicSearchListItemDto>> {
    let conn = open_conn(&state)?;
    command_result(list_magic_search_documents(&conn))
}

#[tauri::command]
fn get_magic_search(state: State<AppState>, id: String) -> CommandResult<MagicSearchDocumentDto> {
    let conn = open_conn(&state)?;
    command_result(get_magic_search_document(&conn, &id))
}

#[tauri::command]
fn export_magic_search(
    state: State<AppState>,
    id: String,
    path: Option<String>,
) -> CommandResult<String> {
    let conn = open_conn(&state)?;
    let document = get_magic_search_document(&conn, &id)?;
    if let Some(path) = path {
        export_markdown_to_path(&path, &document.markdown)
    } else {
        command_result(export_markdown(
            &state,
            "magic-search",
            &document.title,
            &document.markdown,
        ))
    }
}

#[tauri::command]
fn update_magic_search_markdown(
    state: State<AppState>,
    id: String,
    markdown: String,
) -> CommandResult<MagicSearchDocumentDto> {
    if markdown.trim().is_empty() {
        return Err(AppError::new("document.content_required"));
    }
    let conn = open_conn(&state)?;
    let changed = conn
        .execute(
            "UPDATE magic_search_documents SET markdown = ? WHERE id = ?",
            params![markdown, id],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err(AppError::new("document.not_found"));
    }
    command_result(get_magic_search_document(&conn, &id))
}

#[tauri::command]
fn rename_magic_search(
    state: State<AppState>,
    id: String,
    title: String,
) -> CommandResult<MagicSearchDocumentDto> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(AppError::new("document.title_required"));
    }
    let conn = open_conn(&state)?;
    let root_id = conn
        .query_row(
            "SELECT root_id FROM magic_search_documents WHERE id = ?",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .map_err(err)?;
    conn.execute(
        "UPDATE magic_search_documents SET title = ? WHERE root_id = ?",
        params![shorten(&title, 120), root_id],
    )
    .map_err(err)?;
    command_result(get_magic_search_document(&conn, &id))
}

#[tauri::command]
fn delete_magic_search(state: State<AppState>, root_id: String) -> CommandResult<()> {
    let conn = open_conn(&state)?;
    conn.execute(
        "DELETE FROM magic_search_documents WHERE root_id = ?",
        [root_id],
    )
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn delete_old_magic_search_versions(
    state: State<AppState>,
    keep_id: String,
) -> CommandResult<MagicSearchDocumentDto> {
    let conn = open_conn(&state)?;
    let root_id = conn
        .query_row(
            "SELECT root_id FROM magic_search_documents WHERE id = ?",
            [&keep_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(err)?;
    conn.execute(
        "DELETE FROM magic_search_documents WHERE root_id = ? AND id <> ?",
        params![root_id, keep_id],
    )
    .map_err(err)?;
    conn.execute(
        "UPDATE magic_search_documents SET previous_document_id = NULL, version = 1 WHERE id = ?",
        [&keep_id],
    )
    .map_err(err)?;
    command_result(get_magic_search_document(&conn, &keep_id))
}

#[tauri::command]
fn add_magic_search_evidence(
    state: State<AppState>,
    id: String,
    capture_id: String,
) -> CommandResult<MagicSearchDocumentDto> {
    let conn = open_conn(&state)?;
    add_magic_search_evidence_to_document(&conn, &id, &capture_id)?;
    command_result(get_magic_search_document(&conn, &id))
}

#[tauri::command]
fn remove_magic_search_evidence(
    state: State<AppState>,
    id: String,
    capture_id: String,
) -> CommandResult<MagicSearchDocumentDto> {
    let conn = open_conn(&state)?;
    remove_magic_search_evidence_from_document(&conn, &id, &capture_id)?;
    command_result(get_magic_search_document(&conn, &id))
}

#[tauri::command]
fn resync_markdown(state: State<AppState>) -> CommandResult<()> {
    command_result(sync_markdown(&state).map_err(err))
}

#[tauri::command]
async fn paste_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CommandResult<()> {
    let state = state.inner().clone();
    command_result(
        tauri::async_runtime::spawn_blocking(move || paste_capture_core(&app, &state, &id))
            .await
            .map_err(err)?,
    )
}

#[tauri::command]
fn close_paste_palette(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("paste") {
        window.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn close_quick_context(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("quick-context") {
        window.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn open_magic_search(
    app: AppHandle,
    query: Option<String>,
    response_mode: Option<String>,
) -> CommandResult<()> {
    command_result(show_magic_search(
        &app,
        query.as_deref(),
        response_mode.as_deref(),
    ))
}

#[tauri::command]
fn close_magic_search(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("magic-search") {
        window.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn open_magic_document(app: AppHandle, id: String) -> CommandResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new("window.main_unavailable"))?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    window.emit("magic-document-opened", id).map_err(err)?;
    if let Some(magic_window) = app.get_webview_window("magic-search") {
        magic_window.hide().map_err(err)?;
    }
    Ok(())
}

fn paste_capture_core(app: &AppHandle, state: &AppState, id: &str) -> Result<(), String> {
    let conn = open_conn(state)?;
    let capture = get_capture_by_id(&conn, id)?;
    write_capture_to_clipboard(state, &capture)?;

    if let Some(window) = app.get_webview_window("paste") {
        window.hide().map_err(err)?;
    }
    restore_paste_target(state);
    simulate_paste()
}

fn copy_capture_to_clipboard_core(state: &AppState, id: &str) -> Result<(), String> {
    let conn = open_conn(state)?;
    let capture = get_capture_by_id(&conn, id)?;
    write_capture_to_clipboard(state, &capture)
}

fn write_capture_to_clipboard(state: &AppState, capture: &CaptureDto) -> Result<(), String> {
    let mut representations = Vec::new();
    for representation in capture
        .representations
        .iter()
        .filter(|representation| representation.restorable)
    {
        match representation.kind.as_str() {
            "plain_text" => {
                if let Some(value) = &representation.text_content {
                    representations.push(ClipboardRepresentation::PlainText(value.clone()));
                }
            }
            "html" => {
                if let Some(value) = &representation.text_content {
                    representations.push(ClipboardRepresentation::Html(value.clone()));
                }
            }
            "rich_text" => {
                if let Some(value) = &representation.text_content {
                    representations.push(ClipboardRepresentation::RichText(value.clone()));
                }
            }
            "url" => {
                if let Some(value) = &representation.text_content {
                    representations.push(ClipboardRepresentation::Url(value.clone()));
                }
            }
            "image" => {
                if let Some(path) = &representation.asset_path {
                    let image = image::open(path).map_err(err)?.to_rgba8();
                    let (width, height) = image.dimensions();
                    representations.push(ClipboardRepresentation::Image(ClipboardImage {
                        width: width as usize,
                        height: height as usize,
                        rgba: image.into_raw(),
                    }));
                }
            }
            "files" => {
                let files = capture
                    .files
                    .iter()
                    .filter(|file| file.representation_id == representation.id)
                    .filter_map(clipboard_file_from_dto)
                    .collect::<Vec<_>>();
                if !files.is_empty() {
                    representations.push(ClipboardRepresentation::Files(files));
                }
            }
            _ => {}
        }
    }
    if representations.is_empty() {
        return Err("This capture has no restorable clipboard representation.".into());
    }
    write_clipboard_payload(
        state,
        &ClipboardSnapshot {
            representations,
            formats: Vec::new(),
        },
    )
}

fn clipboard_file_from_dto(file: &CaptureFileDto) -> Option<ClipboardFile> {
    let path = file
        .local_path
        .as_deref()
        .or(file.original_path.as_deref())
        .map(PathBuf::from)?;
    let kind = match file.entry_kind.as_str() {
        "directory" => ClipboardFileKind::Directory,
        "application" => ClipboardFileKind::Application,
        "shortcut" => ClipboardFileKind::Shortcut,
        "virtual_file" => ClipboardFileKind::VirtualFile,
        _ => ClipboardFileKind::File,
    };
    let availability = if clipboard::is_network_path(&path) {
        ClipboardFileAvailability::Unverified
    } else if path.exists() {
        ClipboardFileAvailability::Available
    } else {
        return None;
    };
    Some(ClipboardFile {
        display_name: file.display_name.clone(),
        original_path: Some(path),
        kind,
        size_bytes: file.size_bytes.map(|value| value.max(0) as u64),
        bytes: None,
        availability,
    })
}

fn show_paste_palette(app: &AppHandle, state: &AppState) -> Result<(), String> {
    remember_paste_target(state);
    let window = app
        .get_webview_window("paste")
        .ok_or_else(|| "Janela de colagem indisponivel.".to_string())?;
    if let Ok(cursor) = app.cursor_position() {
        let mut x = cursor.x.round() as i32;
        let mut y = cursor.y.round() as i32 + 12;
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            let window_size = window.outer_size().map_err(err)?;
            let max_x = monitor_position.x + monitor_size.width as i32 - window_size.width as i32;
            let max_y = monitor_position.y + monitor_size.height as i32 - window_size.height as i32;
            x = x.clamp(monitor_position.x, max_x.max(monitor_position.x));
            y = y.clamp(monitor_position.y, max_y.max(monitor_position.y));
        }
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(err)?;
    }
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    window.emit("paste-palette-opened", ()).map_err(err)
}

fn show_magic_search(
    app: &AppHandle,
    query: Option<&str>,
    response_mode: Option<&str>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("magic-search")
        .ok_or_else(|| "A janela de busca do ScryPuppy não está disponível.".to_string())?;
    window.center().map_err(err)?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    window
        .emit(
            "magic-search-opened",
            MagicSearchOpenPayload {
                query,
                response_mode,
            },
        )
        .map_err(err)
}

fn show_quick_context(
    app: &AppHandle,
    _state: &AppState,
    capture: &CaptureDto,
    settings: &SettingsDto,
) -> Result<(), String> {
    let window = app
        .get_webview_window("quick-context")
        .ok_or_else(|| "Quick context window is unavailable.".to_string())?;
    window
        .set_size(tauri::LogicalSize::new(
            384.0,
            quick_context_window_height(settings),
        ))
        .map_err(err)?;
    let window_size = window.outer_size().map_err(err)?;
    let margin = 18;
    #[cfg(target_os = "windows")]
    let work_area = windows_foreground_work_area();
    #[cfg(not(target_os = "windows"))]
    let work_area: Option<(i32, i32, i32, i32)> = None;

    let position = if let Some((left, top, right, bottom)) = work_area {
        tauri::PhysicalPosition::new(
            (right - window_size.width as i32 - margin).max(left),
            (bottom - window_size.height as i32 - margin).max(top),
        )
    } else if let Ok(cursor) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
            let origin = monitor.position();
            let size = monitor.size();
            tauri::PhysicalPosition::new(
                origin.x + size.width as i32 - window_size.width as i32 - margin,
                origin.y + size.height as i32 - window_size.height as i32 - margin,
            )
        } else {
            tauri::PhysicalPosition::new(cursor.x as i32, cursor.y as i32)
        }
    } else {
        tauri::PhysicalPosition::new(0, 0)
    };
    window.set_position(position).map_err(err)?;
    window
        .emit(
            "quick-context-capture",
            CaptureUpdatedEvent {
                capture: capture.clone(),
            },
        )
        .map_err(err)?;
    window.show().map_err(err)
}

fn quick_context_window_height(settings: &SettingsDto) -> f64 {
    if settings.quick_context_show_preview || settings.quick_context_show_recent {
        320.0
    } else {
        256.0
    }
}

fn should_show_quick_context(
    settings: &SettingsDto,
    origin: CaptureOrigin,
    capture_kind: &str,
) -> bool {
    match origin {
        CaptureOrigin::ExplicitHotkey => {
            settings.quick_context_enabled
                && (capture_kind != "reference" || settings.quick_context_after_reference)
        }
        CaptureOrigin::ClipboardMonitor => {
            settings.quick_context_enabled && settings.clipboard_monitor_quick_context_enabled
        }
        CaptureOrigin::FileImport => false,
    }
}

#[cfg(target_os = "windows")]
fn windows_foreground_work_area() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO,
            MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
        },
        UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow},
    };
    unsafe {
        let foreground = GetForegroundWindow();
        let mut monitor = if foreground.0.is_null() {
            Default::default()
        } else {
            MonitorFromWindow(foreground, MONITOR_DEFAULTTONULL)
        };
        if monitor.0.is_null() {
            let mut cursor = POINT::default();
            if GetCursorPos(&mut cursor).is_ok() {
                monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
            }
        }
        if monitor.0.is_null() {
            monitor = MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTONEAREST);
        }
        if monitor.0.is_null() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        Some((
            info.rcWork.left,
            info.rcWork.top,
            info.rcWork.right,
            info.rcWork.bottom,
        ))
    }
}

fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn setup_windows_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let open_item = MenuItem::with_id(app, "tray-open", "Open ScryPuppy", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit ScryPuppy", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("scrypuppy-tray")
        .tooltip("ScryPuppy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => restore_main_window(app),
            "tray-quit" => {
                let state = app.state::<AppState>();
                state.clipboard_monitor.shutdown();
                state.clipboard.shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn remember_paste_target(state: &AppState) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let handle = unsafe { GetForegroundWindow() };
    if !handle.0.is_null() {
        if let Ok(mut target) = state.paste_target_window.lock() {
            *target = Some(handle.0 as isize);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn remember_paste_target(_state: &AppState) {}

#[cfg(target_os = "windows")]
fn restore_paste_target(state: &AppState) {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow},
    };

    let target = state
        .paste_target_window
        .lock()
        .ok()
        .and_then(|target| *target);
    let Some(target) = target else {
        thread::sleep(Duration::from_millis(140));
        return;
    };
    let target = HWND(target as *mut std::ffi::c_void);
    for _ in 0..20 {
        unsafe {
            let _ = SetForegroundWindow(target);
            if GetForegroundWindow() == target {
                return;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(target_os = "windows"))]
fn restore_paste_target(_state: &AppState) {
    thread::sleep(Duration::from_millis(140));
}

fn run_capture_core(
    app: &AppHandle,
    state: AppState,
    capture_kind: &str,
    context_id: &str,
) -> Result<CaptureDto, String> {
    let active_window = collect_active_window();
    let previous_clipboard = read_clipboard_payload(&state).ok().flatten();
    let clipboard_marker = format!("__CLIPSCRY_COPY_MARKER_{}__", Uuid::new_v4());
    write_clipboard_text(&state, &clipboard_marker)
        .map_err(|error| format!("Nao foi possivel preparar o clipboard: {error}"))?;
    if let Err(error) = simulate_copy() {
        if let Some(previous_clipboard) = previous_clipboard {
            let _ = write_clipboard_payload(&state, &previous_clipboard);
        }
        return Err(format!("Falha ao acionar copia nativa: {error}"));
    }

    let payload = match read_clipboard_after_copy(&state, &clipboard_marker) {
        Ok(payload) => payload,
        Err(error) => {
            if let Some(previous_clipboard) = previous_clipboard {
                let _ = write_clipboard_payload(&state, &previous_clipboard);
            }
            return Err(error);
        }
    };
    mark_current_clipboard_sequence(&state);

    if capture_kind == "reference"
        && matches!(
            payload.primary_kind(),
            ClipboardRepresentationKind::Files | ClipboardRepresentationKind::Image
        )
    {
        return Err(
            "A Base de conteúdo aceita texto selecionado. Selecione texto antes de usar o atalho."
                .into(),
        );
    }

    persist_clipboard_payload(
        app,
        state,
        payload,
        active_window,
        CaptureOrigin::ExplicitHotkey,
        capture_kind,
        context_id,
    )
}

fn persist_clipboard_payload(
    app: &AppHandle,
    state: AppState,
    payload: ClipboardPayload,
    active_window: ActiveWindowMetadata,
    origin: CaptureOrigin,
    capture_kind: &str,
    context_id: &str,
) -> Result<CaptureDto, String> {
    let _session = begin_capture(&state)?;
    let content_text = payload.content_text();
    if payload.is_empty()
        || (payload.content_text().trim().is_empty()
            && payload.image().is_none()
            && payload.files().is_none())
    {
        return Err("O clipboard nao retornou conteudo para salvar.".into());
    }

    let mut conn = open_conn(&state)?;
    let capture_id = Uuid::new_v4().to_string();
    let captured_at = now();
    let platform = std::env::consts::OS.to_string();
    let metadata = metadata_json(
        &content_text,
        &active_window,
        payload.image_dimensions(),
        origin,
    );
    let app_id = active_window.process_path.clone();
    let hash = payload.content_hash();

    if recent_duplicate_capture(
        &conn,
        &hash,
        &active_window,
        &content_text,
        context_id,
        capture_kind,
        origin,
    )?
    .is_some()
    {
        return Err(DUPLICATE_CAPTURE_IGNORED.into());
    }

    let transaction = conn.transaction().map_err(err)?;
    transaction
        .execute(
            "INSERT INTO captures (
            id, context_id, content_text, content_hash, captured_at,
            source_app_name, source_app_id, source_process_id, source_process_path,
            window_title, window_id, platform, metadata_json, capture_kind, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                capture_id,
                context_id,
                content_text,
                hash,
                captured_at,
                active_window.app_name,
                app_id,
                active_window.process_id.map(|pid| pid as i64),
                active_window.process_path,
                active_window.title,
                active_window.window_id,
                platform,
                metadata.to_string(),
                capture_kind,
                captured_at,
            ],
        )
        .map_err(err)?;

    if let Some(image) = payload.image() {
        insert_clipboard_image_asset(
            &transaction,
            &state,
            &capture_id,
            &ImageData {
                width: image.width,
                height: image.height,
                bytes: std::borrow::Cow::Owned(image.rgba.clone()),
            },
        )?;
    }
    if let Err(error) =
        persist_clipboard_representations(&transaction, &state, &capture_id, &payload, &captured_at)
    {
        let _ = secure_remove_dir(&state.clipboard_files_dir().join(&capture_id));
        return Err(error);
    }

    let settings = settings_from_conn(&transaction, &state)?;
    transaction.commit().map_err(err)?;

    // The quick panel only needs the committed capture and its initial context.
    // Display it before screenshot capture, local analysis, OCR queueing, and
    // Markdown synchronization, which can be noticeably slower on Windows.
    let mut capture = get_capture_by_id(&conn, &capture_id)?;
    let _ = app.emit(
        "capture-created",
        CaptureCreatedEvent {
            capture: capture.clone(),
            origin,
        },
    );
    if should_show_quick_context(&settings, origin, capture_kind) {
        if let Err(error) = show_quick_context(app, &state, &capture, &settings) {
            eprintln!("Quick context panel could not be displayed: {error}");
        }
    }

    let postprocess_result = (|| -> Result<(), String> {
        let transaction = conn.transaction().map_err(err)?;
        if screenshot_enabled(&settings, origin, capture_kind) {
            insert_screenshot_asset(&transaction, &state, &capture_id, &active_window)?;
        }
        process_local_analysis(&transaction, &capture_id)?;
        enqueue_ocr_job(&transaction, &capture_id)?;
        transaction.commit().map_err(err)
    })();

    if let Err(error) = postprocess_result {
        eprintln!("Capture {capture_id} was saved, but background enrichment failed: {error}");
    } else {
        kick_ocr_worker(app.clone(), state.clone());
        if let Ok(updated) = get_capture_by_id(&conn, &capture_id) {
            capture = updated;
            let _ = app.emit(
                "capture-analysis-updated",
                CaptureUpdatedEvent {
                    capture: capture.clone(),
                },
            );
        }
    }

    sync_contexts_best_effort(&state, &[context_id.to_string()]);

    Ok(capture)
}

fn screenshot_enabled(settings: &SettingsDto, origin: CaptureOrigin, capture_kind: &str) -> bool {
    if capture_kind != "capture" {
        return false;
    }
    match origin {
        CaptureOrigin::ExplicitHotkey | CaptureOrigin::FileImport => settings.capture_screenshots,
        CaptureOrigin::ClipboardMonitor => settings.clipboard_monitor_capture_screenshots,
    }
}

fn begin_capture(state: &AppState) -> Result<CaptureSession, String> {
    loop {
        let mut gate = state
            .capture_gate
            .lock()
            .map_err(|_| "Nao foi possivel controlar o estado da captura.".to_string())?;
        if !gate.in_progress {
            gate.in_progress = true;
            return Ok(CaptureSession {
                gate: state.capture_gate.clone(),
            });
        }
        drop(gate);
        thread::sleep(Duration::from_millis(10));
    }
}

fn recent_duplicate_capture(
    conn: &Connection,
    hash: &str,
    active_window: &ActiveWindowMetadata,
    text: &str,
    context_id: &str,
    capture_kind: &str,
    origin: CaptureOrigin,
) -> Result<Option<CaptureDto>, String> {
    let threshold = (Utc::now() - chrono::TimeDelta::seconds(2)).to_rfc3339();
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM captures
             WHERE content_hash = ?
               AND content_text = ?
               AND captured_at >= ?
               AND IFNULL(source_app_name, '') = IFNULL(?, '')
               AND IFNULL(window_title, '') = IFNULL(?, '')
               AND context_id = ?
               AND capture_kind = ?
               AND COALESCE(json_extract(metadata_json, '$.capture_origin'), 'explicit_hotkey') = ?
             ORDER BY captured_at DESC
             LIMIT 1",
            params![
                hash,
                text,
                threshold,
                active_window.app_name,
                active_window.title,
                context_id,
                capture_kind,
                serde_json::to_string(&origin)
                    .map_err(err)?
                    .trim_matches('"')
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;

    existing_id
        .map(|id| get_capture_by_id(conn, &id))
        .transpose()
}

fn process_local_analysis(conn: &Connection, capture_id: &str) -> Result<(), String> {
    let capture = get_capture_by_id(conn, capture_id)?;
    let analysis = analyze_capture_locally(&capture);
    let now = now();

    conn.execute(
        "DELETE FROM capture_tags WHERE capture_id = ?",
        [capture_id],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM capture_entities WHERE capture_id = ?",
        [capture_id],
    )
    .map_err(err)?;
    conn.execute("DELETE FROM capture_ocr WHERE capture_id = ?", [capture_id])
        .map_err(err)?;

    for tag in analysis.tags {
        conn.execute(
            "INSERT OR IGNORE INTO capture_tags (capture_id, tag, source, created_at)
             VALUES (?, ?, 'local-rule', ?)",
            params![capture_id, tag, now],
        )
        .map_err(err)?;
    }

    for entity in analysis.entities {
        conn.execute(
            "INSERT INTO capture_entities (id, capture_id, kind, value, source, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                Uuid::new_v4().to_string(),
                capture_id,
                entity.kind,
                entity.value,
                entity.source,
                entity.confidence,
                now
            ],
        )
        .map_err(err)?;
    }

    conn.execute(
        "INSERT INTO capture_ocr (capture_id, status, text, error, updated_at)
         VALUES (?, ?, ?, ?, ?)",
        params![
            capture_id,
            analysis.ocr.status,
            analysis.ocr.text,
            analysis.ocr.error,
            analysis.ocr.updated_at
        ],
    )
    .map_err(err)?;

    Ok(())
}

fn backfill_local_analysis(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id
             FROM captures c
             LEFT JOIN capture_ocr o ON o.capture_id = c.id
             WHERE o.capture_id IS NULL",
        )
        .map_err(err)?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;

    for id in ids {
        process_local_analysis(conn, &id)?;
    }

    Ok(())
}

fn analyze_capture_locally(capture: &CaptureDto) -> LocalAnalysis {
    let mut tags = Vec::new();
    let mut entities = Vec::new();
    let mut seen_entities = std::collections::HashSet::new();

    push_tag(
        &mut tags,
        if capture.kind == "reference" {
            "referencia"
        } else {
            "captura"
        },
    );
    push_tag(
        &mut tags,
        &format!(
            "app:{}",
            slugify(capture.source_app_name.as_deref().unwrap_or("desconhecido"))
        ),
    );
    push_tag(&mut tags, &format!("platform:{}", capture.platform));

    for asset in &capture.assets {
        push_tag(&mut tags, &asset.kind);
        if asset.kind == "screenshot" {
            push_tag(&mut tags, "screenshot");
        }
        if asset.kind == "clipboard_image" {
            push_tag(&mut tags, "imagem");
        }
    }

    if capture
        .source_app_name
        .as_deref()
        .map(is_browser_app)
        .unwrap_or(false)
    {
        push_tag(&mut tags, "navegador");
    }
    if capture
        .source_app_name
        .as_deref()
        .map(is_terminal_app)
        .unwrap_or(false)
        || capture
            .window_title
            .as_deref()
            .map(is_terminal_app)
            .unwrap_or(false)
    {
        push_tag(&mut tags, "terminal");
    }

    if looks_like_code(&capture.content_text) {
        push_tag(&mut tags, "codigo");
    }
    if looks_like_error(&capture.content_text) {
        push_tag(&mut tags, "erro");
    }
    if capture.content_text.contains("http://") || capture.content_text.contains("https://") {
        push_tag(&mut tags, "url");
        push_tag(&mut tags, "documentacao");
    }

    add_entity(
        &mut entities,
        &mut seen_entities,
        "application",
        capture.source_app_name.as_deref(),
        "metadata",
        1.0,
    );
    add_entity(
        &mut entities,
        &mut seen_entities,
        "application_id",
        capture.source_app_id.as_deref(),
        "metadata",
        1.0,
    );
    add_entity(
        &mut entities,
        &mut seen_entities,
        "process_path",
        capture.source_process_path.as_deref(),
        "metadata",
        1.0,
    );
    add_entity(
        &mut entities,
        &mut seen_entities,
        "window_title",
        capture.window_title.as_deref(),
        "metadata",
        0.95,
    );

    extract_regex_entities(
        &capture.content_text,
        &mut tags,
        &mut entities,
        &mut seen_entities,
    );

    tags.sort();
    tags.dedup();

    let has_image_asset = capture
        .assets
        .iter()
        .any(|asset| asset.kind == "screenshot" || asset.kind == "clipboard_image");
    let ocr = CaptureOcrDto {
        status: if has_image_asset {
            "queued".into()
        } else {
            "not_applicable".into()
        },
        text: None,
        error: None,
        updated_at: now(),
    };

    LocalAnalysis {
        tags,
        entities,
        ocr,
    }
}

fn extract_regex_entities(
    text: &str,
    tags: &mut Vec<String>,
    entities: &mut Vec<LocalEntity>,
    seen: &mut std::collections::HashSet<String>,
) {
    static RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
        vec![
            ("url", r#"https?://[^\s<>)\]"']+"#),
            ("email", r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
            (
                "uuid",
                r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
            ),
            ("ip", r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
            (
                "port",
                r"(?i)\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b",
            ),
            ("hash", r"\b[0-9a-fA-F]{32,64}\b"),
            ("windows_path", r"[A-Za-z]:\\[^\r\n\t<>|?*]+"),
            ("unix_path", r"(?:/[\w.\-]+){2,}"),
        ]
        .into_iter()
        .map(|(kind, pattern)| (kind, Regex::new(pattern).expect("valid entity regex")))
        .collect()
    });

    for (kind, regex) in RULES.iter() {
        for mat in regex.find_iter(text).take(20) {
            let value = mat.as_str().trim_matches(&['.', ',', ';', ':'][..]);
            add_entity(entities, seen, kind, Some(value), "content-regex", 0.9);
            match *kind {
                "url" => {
                    push_tag(tags, "url");
                    if let Some(domain) = domain_from_url(value) {
                        add_entity(
                            entities,
                            seen,
                            "domain",
                            Some(&domain),
                            "content-regex",
                            0.9,
                        );
                    }
                }
                "windows_path" | "unix_path" => push_tag(tags, "arquivo"),
                _ => {}
            }
        }
    }

    for line in text.lines().take(50) {
        let trimmed = line.trim();
        if looks_like_command(trimmed) {
            add_entity(
                entities,
                seen,
                "command",
                Some(trimmed),
                "content-heuristic",
                0.75,
            );
            push_tag(tags, "comando");
        }
    }
}

fn add_entity(
    entities: &mut Vec<LocalEntity>,
    seen: &mut std::collections::HashSet<String>,
    kind: &str,
    value: Option<&str>,
    source: &str,
    confidence: f64,
) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let key = format!("{kind}:{value}");
    if seen.insert(key) {
        entities.push(LocalEntity {
            kind: kind.into(),
            value: value.into(),
            source: source.into(),
            confidence,
        });
    }
}

fn push_tag(tags: &mut Vec<String>, tag: &str) {
    let tag = tag.trim().to_lowercase();
    if !tag.is_empty() && !tags.contains(&tag) {
        tags.push(tag);
    }
}

fn is_browser_app(value: &str) -> bool {
    let value = value.to_lowercase();
    ["chrome", "edge", "firefox", "safari", "brave", "opera"]
        .iter()
        .any(|needle| value.contains(needle))
}

fn is_terminal_app(value: &str) -> bool {
    let value = value.to_lowercase();
    [
        "terminal",
        "powershell",
        "cmd",
        "bash",
        "zsh",
        "windows terminal",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn looks_like_code(text: &str) -> bool {
    let needles = [
        "fn ",
        "function ",
        "const ",
        "let ",
        "class ",
        "=>",
        "use ",
        "import ",
        "{",
        "};",
    ];
    needles
        .iter()
        .filter(|needle| text.contains(*needle))
        .count()
        >= 2
}

fn looks_like_error(text: &str) -> bool {
    let value = text.to_lowercase();
    [
        "error",
        "exception",
        "failed",
        "panic",
        "stack trace",
        "traceback",
        "erro",
        "falha",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn looks_like_command(line: &str) -> bool {
    let prefixes = [
        "git ", "npm ", "pnpm ", "yarn ", "cargo ", "rustc ", "node ", "python ", "pip ",
        "docker ", "kubectl ", "cd ", "ls ", "dir ", "Get-", "Set-",
    ];
    prefixes.iter().any(|prefix| line.starts_with(prefix))
}

fn domain_from_url(url: &str) -> Option<String> {
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    without_scheme
        .split('/')
        .next()
        .map(|domain| domain.trim().to_lowercase())
        .filter(|domain| !domain.is_empty())
}

fn answer_chat_locally(
    conn: &Connection,
    state: &AppState,
    request: ChatRequest,
) -> Result<ChatAnswer, String> {
    let settings = settings_with_ai_secret(conn, state)?;
    let portuguese = settings.language == "pt-BR";
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(ChatAnswer {
            answer: if portuguese {
                "Digite uma pergunta para eu buscar nas capturas."
            } else {
                "Enter a question so I can search your captures."
            }
            .into(),
            confidence: "low".into(),
            evidence: Vec::new(),
            suggested_actions: Vec::new(),
        });
    }

    let intent = detect_chat_intent(query);
    let captures = load_chat_captures(conn, &request)?;
    let mut scored = score_captures_for_query(query, captures, &intent);
    scored.sort_by_key(|capture| std::cmp::Reverse(capture.score));

    let limit = request.limit.unwrap_or(6).clamp(1, 12);
    let relevant: Vec<ScoredCapture> = scored
        .into_iter()
        .filter(|item| {
            item.score > 0
                || matches!(
                    intent,
                    ChatIntent::OrganizeToday | ChatIntent::SummarizeContext
                )
        })
        .take(limit)
        .collect();

    let mut answer = match intent {
        ChatIntent::ApplicationId => answer_application_id(query, relevant, portuguese),
        ChatIntent::WhereError => answer_where_error(relevant, portuguese),
        ChatIntent::OrganizeToday => answer_organize_today(relevant, portuguese),
        ChatIntent::SummarizeContext => answer_summary(query, relevant, portuguese),
        ChatIntent::Related => answer_related(query, relevant, portuguese),
    };

    if !settings.ai_api_key.trim().is_empty() && !answer.evidence.is_empty() {
        match call_ai_provider(&settings, query, &answer) {
            Ok(ai_text) => {
                answer.answer = ai_text;
                answer.confidence = "high".into();
            }
            Err(error) => {
                answer.answer = if portuguese {
                    format!(
                        "{}\n\nFalha ao chamar provider IA `{}`: {}",
                        answer.answer, settings.ai_provider, error
                    )
                } else {
                    format!(
                        "{}\n\nThe AI provider `{}` failed: {}",
                        answer.answer, settings.ai_provider, error
                    )
                };
            }
        }
    }

    Ok(answer)
}

enum ChatIntent {
    ApplicationId,
    WhereError,
    Related,
    OrganizeToday,
    SummarizeContext,
}

fn detect_chat_intent(query: &str) -> ChatIntent {
    let normalized = normalize_text(query);
    if normalized.contains("applicationid")
        || normalized.contains("application id")
        || normalized.contains("app id")
    {
        ChatIntent::ApplicationId
    } else if (normalized.contains("onde") || normalized.contains("where"))
        && (normalized.contains("erro") || normalized.contains("error"))
    {
        ChatIntent::WhereError
    } else if normalized.contains("organize") || normalized.contains("organizar") {
        ChatIntent::OrganizeToday
    } else if normalized.contains("resumo")
        || normalized.contains("resuma")
        || normalized.contains("summary")
        || normalized.contains("summarize")
    {
        ChatIntent::SummarizeContext
    } else {
        ChatIntent::Related
    }
}

fn load_chat_captures(conn: &Connection, request: &ChatRequest) -> Result<Vec<CaptureDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content_text, c.captured_at,
                    c.source_app_name, c.source_app_id, c.source_process_id,
                    c.source_process_path, c.window_title, c.window_id, c.platform,
                    c.metadata_json, c.capture_kind
             FROM captures c
             WHERE (?1 IS NULL
                OR (?1 = 'inbox' AND c.capture_kind <> 'reference' AND NOT EXISTS (SELECT 1 FROM capture_contexts cc WHERE cc.capture_id = c.id))
                OR (?1 = 'content-base' AND c.capture_kind = 'reference')
                OR EXISTS (SELECT 1 FROM capture_contexts cc WHERE cc.capture_id = c.id AND cc.context_id = ?1))
               AND (?2 IS NULL OR lower(coalesce(c.source_app_name, '')) LIKE '%' || lower(?2) || '%')
               AND (?3 IS NULL OR c.captured_at >= ?3)
               AND (?4 IS NULL OR c.captured_at <= ?4)
             ORDER BY c.captured_at DESC
             LIMIT 500",
        )
        .map_err(err)?;
    let mut captures = stmt
        .query_map(
            params![
                request.context_id.as_deref(),
                request.app.as_deref(),
                request.date_from.as_deref(),
                request.date_to.as_deref(),
            ],
            capture_base_from_row,
        )
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;

    Ok(captures)
}

fn score_captures_for_query(
    query: &str,
    captures: Vec<CaptureDto>,
    intent: &ChatIntent,
) -> Vec<ScoredCapture> {
    let terms = query_terms(query);
    let today = Local::now().date_naive();

    captures
        .into_iter()
        .map(|capture| {
            let mut score = 0;
            let mut matched_fields = Vec::new();

            let content = normalize_text(&capture.content_text);
            let app = normalize_text(capture.source_app_name.as_deref().unwrap_or_default());
            let app_id = normalize_text(capture.source_app_id.as_deref().unwrap_or_default());
            let window = normalize_text(capture.window_title.as_deref().unwrap_or_default());
            let contexts = normalize_text(&context_names(&capture).join(" "));
            let tags = normalize_text(&capture.tags.join(" "));
            let entities = normalize_text(
                &capture
                    .entities
                    .iter()
                    .map(|entity| format!("{} {}", entity.kind, entity.value))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            let ocr = normalize_text(
                capture
                    .ocr
                    .as_ref()
                    .and_then(|ocr| ocr.text.as_deref())
                    .unwrap_or_default(),
            );

            for term in &terms {
                if content.contains(term) {
                    score += 3;
                    push_field(&mut matched_fields, "texto");
                }
                if app.contains(term) {
                    score += 5;
                    push_field(&mut matched_fields, "app");
                }
                if app_id.contains(term) {
                    score += 4;
                    push_field(&mut matched_fields, "application_id");
                }
                if window.contains(term) {
                    score += 3;
                    push_field(&mut matched_fields, "janela");
                }
                if contexts.contains(term) {
                    score += 3;
                    push_field(&mut matched_fields, "contexto");
                }
                if tags.contains(term) {
                    score += 2;
                    push_field(&mut matched_fields, "tags");
                }
                if entities.contains(term) {
                    score += 4;
                    push_field(&mut matched_fields, "entidades");
                }
                if ocr.contains(term) {
                    score += 4;
                    push_field(&mut matched_fields, "ocr");
                }
            }

            match intent {
                ChatIntent::ApplicationId => {
                    if capture.source_app_id.is_some() {
                        score += 2;
                        push_field(&mut matched_fields, "application_id");
                    }
                }
                ChatIntent::WhereError => {
                    if capture.tags.iter().any(|tag| tag == "erro") {
                        score += 5;
                        push_field(&mut matched_fields, "tags");
                    }
                }
                ChatIntent::OrganizeToday => {
                    if capture_date_is(&capture.captured_at, today) {
                        score += 5;
                        push_field(&mut matched_fields, "data");
                    }
                }
                ChatIntent::SummarizeContext | ChatIntent::Related => {}
            }

            ScoredCapture {
                capture,
                score,
                matched_fields,
            }
        })
        .collect()
}

fn answer_application_id(
    query: &str,
    relevant: Vec<ScoredCapture>,
    portuguese: bool,
) -> ChatAnswer {
    let mut counts: HashMap<String, Vec<&ScoredCapture>> = HashMap::new();
    for item in &relevant {
        if let Some(app_id) = item
            .capture
            .source_app_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            counts.entry(app_id.to_string()).or_default().push(item);
        }
    }

    if let Some((app_id, items)) = counts.into_iter().max_by_key(|(_, items)| items.len()) {
        let evidence = items
            .into_iter()
            .take(5)
            .map(evidence_from_scored)
            .collect::<Vec<_>>();
        ChatAnswer {
            answer: if portuguese {
                format!(
                    "Application ID mais provável: `{}`. Encontrei esse valor em {} captura(s).",
                    app_id,
                    evidence.len()
                )
            } else {
                format!(
                    "Most likely Application ID: `{}`. This value appears in {} capture(s).",
                    app_id,
                    evidence.len()
                )
            },
            confidence: if evidence.len() >= 2 {
                "high".into()
            } else {
                "medium".into()
            },
            evidence,
            suggested_actions: Vec::new(),
        }
    } else {
        no_evidence_answer(query, portuguese)
    }
}

fn answer_where_error(relevant: Vec<ScoredCapture>, portuguese: bool) -> ChatAnswer {
    let evidence = relevant
        .iter()
        .take(6)
        .map(evidence_from_scored)
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return ChatAnswer {
            answer: if portuguese {
                "Não encontrei evidências suficientes desse erro nas capturas."
            } else {
                "I could not find enough evidence of this error in your captures."
            }
            .into(),
            confidence: "low".into(),
            evidence,
            suggested_actions: Vec::new(),
        };
    }

    ChatAnswer {
        answer: if portuguese {
            format!("Encontrei {} captura(s) possivelmente relacionadas a esse erro. Abra as evidências para conferir o contexto original.", evidence.len())
        } else {
            format!("I found {} capture(s) that may be related to this error. Open the evidence to inspect the original context.", evidence.len())
        },
        confidence: if evidence.len() >= 3 {
            "high".into()
        } else {
            "medium".into()
        },
        evidence,
        suggested_actions: Vec::new(),
    }
}

fn answer_related(query: &str, relevant: Vec<ScoredCapture>, portuguese: bool) -> ChatAnswer {
    let evidence = relevant
        .iter()
        .take(8)
        .map(evidence_from_scored)
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return no_evidence_answer(query, portuguese);
    }

    ChatAnswer {
        answer: if portuguese {
            format!(
                "Encontrei {} captura(s) relacionadas a \"{}\".",
                evidence.len(),
                query.trim()
            )
        } else {
            format!(
                "I found {} capture(s) related to \"{}\".",
                evidence.len(),
                query.trim()
            )
        },
        confidence: if evidence.len() >= 4 {
            "high".into()
        } else {
            "medium".into()
        },
        evidence,
        suggested_actions: Vec::new(),
    }
}

fn answer_organize_today(relevant: Vec<ScoredCapture>, portuguese: bool) -> ChatAnswer {
    let today_items = relevant
        .iter()
        .filter(|item| capture_date_is(&item.capture.captured_at, Local::now().date_naive()))
        .collect::<Vec<_>>();
    if today_items.is_empty() {
        return ChatAnswer {
            answer: if portuguese {
                "Não encontrei capturas de hoje para organizar."
            } else {
                "I could not find any captures from today to organize."
            }
            .into(),
            confidence: "low".into(),
            evidence: Vec::new(),
            suggested_actions: Vec::new(),
        };
    }

    let mut by_app: HashMap<String, usize> = HashMap::new();
    let mut by_context: HashMap<String, usize> = HashMap::new();
    for item in &today_items {
        *by_app
            .entry(item.capture.source_app_name.clone().unwrap_or_else(|| {
                if portuguese {
                    "Desconhecido"
                } else {
                    "Unknown"
                }
                .into()
            }))
            .or_insert(0) += 1;
        let names = context_names(&item.capture);
        if names.is_empty() {
            *by_context.entry("Inbox".into()).or_insert(0) += 1;
        } else {
            for name in names {
                *by_context.entry(name).or_insert(0) += 1;
            }
        }
    }

    let app_summary = top_counts(by_app, 4);
    let context_summary = top_counts(by_context, 4);
    let evidence = today_items
        .into_iter()
        .take(8)
        .map(evidence_from_scored)
        .collect::<Vec<_>>();

    ChatAnswer {
        answer: if portuguese {
            format!(
                "Hoje encontrei {} captura(s). Principais apps: {}. Contextos mais usados: {}.",
                evidence.len(),
                app_summary,
                context_summary
            )
        } else {
            format!(
                "I found {} capture(s) from today. Top applications: {}. Most used contexts: {}.",
                evidence.len(),
                app_summary,
                context_summary
            )
        },
        confidence: "medium".into(),
        evidence,
        suggested_actions: vec![SuggestedAction {
            label: if portuguese {
                "Revisar capturas de hoje"
            } else {
                "Review today's captures"
            }
            .into(),
            action: "filter_today".into(),
            payload: json!({ "date": Local::now().date_naive().to_string() }),
        }],
    }
}

fn answer_summary(query: &str, relevant: Vec<ScoredCapture>, portuguese: bool) -> ChatAnswer {
    let evidence = relevant
        .iter()
        .take(10)
        .map(evidence_from_scored)
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return no_evidence_answer(query, portuguese);
    }

    let mut tags: HashMap<String, usize> = HashMap::new();
    let mut apps: HashMap<String, usize> = HashMap::new();
    for item in &relevant {
        for tag in &item.capture.tags {
            *tags.entry(tag.clone()).or_insert(0) += 1;
        }
        *apps
            .entry(item.capture.source_app_name.clone().unwrap_or_else(|| {
                if portuguese {
                    "Desconhecido"
                } else {
                    "Unknown"
                }
                .into()
            }))
            .or_insert(0) += 1;
    }

    ChatAnswer {
        answer: if portuguese {
            format!("Resumo local baseado em {} evidência(s): apps principais: {}; tags principais: {}. A versão com IA poderá transformar isso em um resumo narrativo.", evidence.len(), top_counts(apps, 4), top_counts(tags, 6))
        } else {
            format!("Local summary based on {} evidence item(s): top applications: {}; top tags: {}. The AI version can turn this into a narrative summary.", evidence.len(), top_counts(apps, 4), top_counts(tags, 6))
        },
        confidence: "medium".into(),
        evidence,
        suggested_actions: Vec::new(),
    }
}

fn no_evidence_answer(query: &str, portuguese: bool) -> ChatAnswer {
    ChatAnswer {
        answer: if portuguese {
            format!(
                "Não encontrei evidência suficiente para responder \"{}\" nas capturas atuais.",
                query.trim()
            )
        } else {
            format!(
                "I could not find enough evidence to answer \"{}\" in the current captures.",
                query.trim()
            )
        },
        confidence: "low".into(),
        evidence: Vec::new(),
        suggested_actions: Vec::new(),
    }
}

fn evidence_from_scored(item: &ScoredCapture) -> EvidenceItem {
    EvidenceItem {
        capture_id: item.capture.id.clone(),
        captured_at: item.capture.captured_at.clone(),
        context_names: context_names(&item.capture),
        app_name: item.capture.source_app_name.clone(),
        application_id: item.capture.source_app_id.clone(),
        window_title: item.capture.window_title.clone(),
        excerpt: excerpt_for_query(&redact_sensitive_values(&item.capture.content_text)),
        matched_fields: item.matched_fields.clone(),
        asset_paths: item
            .capture
            .assets
            .iter()
            .filter_map(|asset| asset.path.clone())
            .collect(),
    }
}

fn excerpt_for_query(text: &str) -> String {
    let clean = text.replace('\n', " ");
    let chars = clean.chars().collect::<Vec<_>>();
    if chars.len() <= 220 {
        clean
    } else {
        chars.into_iter().take(220).collect::<String>() + "..."
    }
}

fn query_terms(query: &str) -> Vec<String> {
    normalize_text(query)
        .split_whitespace()
        .filter(|term| term.len() > 2)
        .filter(|term| !CHAT_STOP_WORDS.contains(term))
        .map(ToString::to_string)
        .collect()
}

fn is_broad_collection_query(query: &str) -> bool {
    const SCOPE_TERMS: &str = "all everything entire whole tudo todo todos todas inteiro inteira";
    const NON_SUBJECT_TERMS: &str = concat!(
        "a an and about capture captures clipboard condense context contexts copied create data ",
        "document documents file files find from get i in include information items library list ",
        "make memory me my notes of on organise organize our search show summarise summarize the to use ",
        "arquivo arquivos as biblioteca buscar busque captura capturas condensar contexto contextos ",
        "copiado copiada copiados copiadas copiei criar crie da das dados de do documento documentos ",
        "dos e em encontrar encontre eu gerar gere informacao informação informacoes informações incluir ",
        "inclua itens listar liste memoria memória meu meus minha minhas mostrar mostre na nas no nos nota ",
        "notas o organizar os para procurar procure que resumir resuma sobre um uma usar"
    );

    let normalized = normalize_text(query);
    let terms = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    let contains_term =
        |terms: &str, candidate: &str| terms.split_ascii_whitespace().any(|term| term == candidate);
    let has_scope_term = terms.iter().any(|term| contains_term(SCOPE_TERMS, term));

    has_scope_term
        && terms
            .iter()
            .all(|term| contains_term(SCOPE_TERMS, term) || contains_term(NON_SUBJECT_TERMS, term))
}

const CHAT_STOP_WORDS: &[&str] = &[
    "qual",
    "onde",
    "me",
    "mostre",
    "minhas",
    "meus",
    "das",
    "dos",
    "uma",
    "por",
    "para",
    "com",
    "que",
    "foi",
    "esse",
    "essa",
    "aplicacao",
    "aplicação",
    "app",
    "contexto",
    "capturas",
    "captura",
    "hoje",
    "resumo",
    "crie",
    "organize",
];

fn normalize_text(value: &str) -> String {
    value.to_lowercase()
}

fn context_names(capture: &CaptureDto) -> Vec<String> {
    capture
        .contexts
        .iter()
        .map(|context| context.name.clone())
        .collect()
}

fn context_label(capture: &CaptureDto) -> String {
    let names = context_names(capture);
    if names.is_empty() {
        if capture.kind == "reference" {
            "Content Base".into()
        } else {
            "Inbox".into()
        }
    } else {
        names.join(", ")
    }
}

fn push_field(fields: &mut Vec<String>, field: &str) {
    if !fields.iter().any(|existing| existing == field) {
        fields.push(field.into());
    }
}

fn capture_date_is(captured_at: &str, date: chrono::NaiveDate) -> bool {
    DateTime::parse_from_rfc3339(captured_at)
        .map(|dt| dt.with_timezone(&Local).date_naive() == date)
        .unwrap_or(false)
}

fn top_counts(mut counts: HashMap<String, usize>, limit: usize) -> String {
    let mut items = counts.drain().collect::<Vec<_>>();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let summary = items
        .into_iter()
        .take(limit)
        .map(|(name, count)| format!("{name} ({count})"))
        .collect::<Vec<_>>()
        .join(", ");
    if summary.is_empty() {
        "nenhum".into()
    } else {
        summary
    }
}

fn captures_for_tag(conn: &Connection, tag: &str) -> Result<Vec<CaptureDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         JOIN capture_tags ct ON ct.capture_id = c.id
         WHERE ct.tag = ?
         ORDER BY c.captured_at DESC
         LIMIT 500",
        )
        .map_err(err)?;
    let mut captures = stmt
        .query_map([tag], capture_base_from_row)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;
    Ok(captures)
}

fn build_tag_document(conn: &Connection, tag: &str) -> CommandResult<TagDocumentDto> {
    let portuguese = get_setting(conn, "language")?.as_deref() == Some("pt-BR");
    let tag = tag.trim();
    if tag.is_empty() {
        return Err(AppError::new("tag.name_required"));
    }
    let captures = captures_for_tag(conn, tag)?;
    let apps = captures
        .iter()
        .filter_map(|capture| capture.source_app_name.clone())
        .collect::<std::collections::HashSet<_>>();
    let contexts = captures
        .iter()
        .flat_map(context_names)
        .collect::<std::collections::HashSet<_>>();
    let period_end = captures.first().map(|capture| capture.captured_at.clone());
    let period_start = captures.last().map(|capture| capture.captured_at.clone());
    let markdown = render_tag_document_markdown(tag, &captures, &apps, &contexts, portuguese);
    Ok(TagDocumentDto {
        tag: tag.into(),
        markdown,
        capture_count: captures.len(),
        app_count: apps.len(),
        context_count: contexts.len(),
        period_start,
        period_end,
    })
}

fn render_tag_document_markdown(
    tag: &str,
    captures: &[CaptureDto],
    apps: &std::collections::HashSet<String>,
    contexts: &std::collections::HashSet<String>,
    portuguese: bool,
) -> String {
    let mut markdown = if portuguese {
        format!(
            "# #{}\n\n- Capturas: {}\n- Aplicativos: {}\n- Contextos: {}\n- Gerado em: {}\n\n",
            tag,
            captures.len(),
            apps.len(),
            contexts.len(),
            now()
        )
    } else {
        format!(
            "# #{}\n\n- Captures: {}\n- Applications: {}\n- Contexts: {}\n- Generated at: {}\n\n",
            tag,
            captures.len(),
            apps.len(),
            contexts.len(),
            now()
        )
    };
    let mut current_date = String::new();
    for capture in captures {
        let date = capture
            .captured_at
            .get(..10)
            .unwrap_or(&capture.captured_at);
        if current_date != date {
            current_date = date.to_string();
            markdown.push_str(&format!("## {date}\n\n"));
        }
        let app = capture.source_app_name.as_deref().unwrap_or(if portuguese {
            "Aplicativo desconhecido"
        } else {
            "Unknown application"
        });
        let time = capture.captured_at.get(11..16).unwrap_or("--:--");
        markdown.push_str(&if portuguese {
            format!(
                "### {time} — {}\n\n**Contexto:** {}  \n**Captura:** `{}`\n\n",
                escape_ticks(app),
                escape_ticks(&context_label(capture)),
                capture.id
            )
        } else {
            format!(
                "### {time} — {}\n\n**Context:** {}  \n**Capture:** `{}`\n\n",
                escape_ticks(app),
                escape_ticks(&context_label(capture)),
                capture.id
            )
        });
        markdown.push_str(&markdown_fenced_block(&capture.content_text));
        markdown.push('\n');
        if !capture.contexts.is_empty() {
            markdown.push_str(&format!(
                "**{}:** {}\n\n",
                if portuguese { "Contextos" } else { "Contexts" },
                capture
                    .contexts
                    .iter()
                    .map(|context| context.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        markdown.push_str("---\n\n");
    }
    markdown
}

fn load_magic_search_captures(
    conn: &Connection,
    request: &MagicSearchRequest,
) -> Result<Vec<CaptureDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         WHERE (?1 IS NULL
            OR (?1 = 'inbox' AND c.capture_kind <> 'reference' AND NOT EXISTS (SELECT 1 FROM capture_contexts cc WHERE cc.capture_id = c.id))
            OR (?1 = 'content-base' AND c.capture_kind = 'reference')
            OR EXISTS (SELECT 1 FROM capture_contexts cc WHERE cc.capture_id = c.id AND cc.context_id = ?1))
           AND (?2 IS NULL OR c.captured_at >= ?2)
           AND (?3 IS NULL OR c.captured_at <= ?3)
           AND (?4 IS NULL OR EXISTS (
                SELECT 1 FROM capture_tags ct WHERE ct.capture_id = c.id AND ct.tag = ?4
           ))
         ORDER BY c.captured_at DESC
         LIMIT 500",
        )
        .map_err(err)?;
    let mut captures = stmt
        .query_map(
            params![
                request.context_id.as_deref(),
                request.date_from.as_deref(),
                request.date_to.as_deref(),
                request.tag.as_deref(),
            ],
            capture_base_from_row,
        )
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;
    Ok(captures)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MagicResponseMode {
    Direct,
    Brief,
    Document,
}

impl MagicResponseMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Brief => "brief",
            Self::Document => "document",
        }
    }

    fn evidence_limit(self) -> usize {
        match self {
            Self::Direct => 5,
            Self::Brief => 10,
            Self::Document => 24,
        }
    }
}

fn classify_magic_response(query: &str, requested: Option<&str>) -> MagicResponseMode {
    match requested {
        Some("direct") => return MagicResponseMode::Direct,
        Some("brief") => return MagicResponseMode::Brief,
        Some("document") => return MagicResponseMode::Document,
        _ => {}
    }
    let normalized = normalize_text(query);
    let document_terms = [
        "consolide",
        "consolidate",
        "documento",
        "document",
        "relatorio",
        "report",
        "linha do tempo",
        "timeline",
        "compare",
        "comparacao",
        "mapeie",
        "map everything",
        "tudo sobre",
        "everything about",
        "todos os",
        "all related",
    ];
    if document_terms.iter().any(|term| normalized.contains(term)) {
        return MagicResponseMode::Document;
    }
    let brief_terms = [
        "resuma",
        "resumo",
        "summarize",
        "summary",
        "principais pontos",
        "key points",
    ];
    if brief_terms.iter().any(|term| normalized.contains(term)) {
        MagicResponseMode::Brief
    } else {
        MagicResponseMode::Direct
    }
}

fn is_sensitive_lookup(query: &str) -> bool {
    let normalized = normalize_text(query);
    [
        "chave",
        "api key",
        "key",
        "token",
        "segredo",
        "secret",
        "credential",
    ]
    .iter()
    .any(|term| normalized.contains(term))
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,})\b")
            .expect("valid secret pattern")
    });
    &PATTERN
}

fn extract_sensitive_value(text: &str) -> Option<String> {
    secret_pattern()
        .find(text)
        .map(|value| value.as_str().to_string())
}

fn capture_sensitive_value(capture: &CaptureDto) -> Option<String> {
    extract_sensitive_value(&capture.content_text).or_else(|| {
        capture
            .ocr
            .as_ref()
            .and_then(|ocr| ocr.text.as_deref())
            .and_then(extract_sensitive_value)
    })
}

fn mask_secret(value: &str) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= 8 {
        return "********".to_string();
    }
    let prefix = characters.iter().take(7).collect::<String>();
    let suffix = characters
        .iter()
        .skip(characters.len() - 4)
        .collect::<String>();
    format!("{prefix}********{suffix}")
}

fn redact_sensitive_values(text: &str) -> String {
    secret_pattern()
        .replace_all(text, |captures: &regex::Captures<'_>| {
            mask_secret(&captures[0])
        })
        .into_owned()
}

#[derive(Debug, Default)]
struct SecretRedactionMap {
    // This map exists only for the current request. It is never serialized or sent.
    values: Vec<String>,
}

impl SecretRedactionMap {
    fn from_texts<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut map = Self::default();
        for text in texts {
            map.add_text(text);
        }
        map.values
            .sort_by_key(|value| std::cmp::Reverse(value.len()));
        map
    }

    fn for_magic_search(query: &str, relevant: &[ScoredCapture]) -> Self {
        let mut texts = vec![query];
        for item in relevant {
            texts.push(item.capture.content_text.as_str());
            if let Some(app_name) = item.capture.source_app_name.as_deref() {
                texts.push(app_name);
            }
            if let Some(window_title) = item.capture.window_title.as_deref() {
                texts.push(window_title);
            }
            for context in &item.capture.contexts {
                texts.push(context.name.as_str());
            }
            for tag in &item.capture.tags {
                texts.push(tag.as_str());
            }
            if let Some(ocr_text) = item
                .capture
                .ocr
                .as_ref()
                .and_then(|ocr| ocr.text.as_deref())
            {
                texts.push(ocr_text);
            }
        }
        Self::from_texts(texts)
    }

    fn add_text(&mut self, text: &str) {
        for matched in secret_pattern().find_iter(text) {
            let value = matched.as_str();
            if !self.values.iter().any(|existing| existing == value) {
                self.values.push(value.to_string());
            }
        }
    }

    fn placeholder(index: usize) -> String {
        format!("[SCRYPUPPY_SECRET_{}]", index + 1)
    }

    fn redact(&self, text: &str) -> String {
        self.values
            .iter()
            .enumerate()
            .fold(text.to_string(), |redacted, (index, value)| {
                redacted.replace(value, &Self::placeholder(index))
            })
    }

    fn restore_document(&self, text: &str) -> String {
        let mut restored = text.to_string();
        for (index, value) in self.values.iter().enumerate() {
            restored = restored.replace(&Self::placeholder(index), value);
            let masked = mask_secret(value);
            let mask_is_unique = self
                .values
                .iter()
                .filter(|candidate| mask_secret(candidate) == masked)
                .count()
                == 1;
            if mask_is_unique {
                restored = restored.replace(&masked, value);
            }
        }
        restored
    }
}

fn response_uses_expected_language(text: &str, portuguese: bool) -> bool {
    let normalized = format!(" {} ", normalize_text(text));
    let pt_score = [
        " que ",
        " de ",
        " para ",
        " com ",
        " nao ",
        " uma ",
        " evidencias ",
    ]
    .iter()
    .filter(|term| normalized.contains(*term))
    .count();
    let en_score = [
        " the ",
        " is ",
        " for ",
        " with ",
        " not ",
        " a ",
        " evidence ",
    ]
    .iter()
    .filter(|term| normalized.contains(*term))
    .count();
    if portuguese {
        en_score < 2 || pt_score >= en_score
    } else {
        pt_score < 2 || en_score >= pt_score
    }
}

fn constrain_magic_response(text: &str, mode: MagicResponseMode) -> String {
    match mode {
        MagicResponseMode::Direct => {
            let compact = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .take(3)
                .collect::<Vec<_>>()
                .join(" ");
            shorten(compact.trim_start_matches('#').trim(), 600)
        }
        MagicResponseMode::Brief => shorten(text, 1800),
        MagicResponseMode::Document => text.to_string(),
    }
}

fn preview_magic_search_document(
    conn: &Connection,
    mut request: MagicSearchRequest,
) -> Result<MagicSearchPreviewDto, String> {
    let query = request.query.trim().to_string();
    let mode = classify_magic_response(&query, request.response_mode.as_deref());
    request.response_mode = Some(mode.as_str().to_string());
    let captures = load_magic_search_captures(conn, &request)?;
    let available_count = captures.len();
    if query.is_empty() {
        return Ok(MagicSearchPreviewDto {
            evidence_count: available_count.min(mode.evidence_limit()),
            available_count,
        });
    }

    let sensitive_lookup = is_sensitive_lookup(&query);
    let intent = detect_chat_intent(&query);
    let mut scored = score_captures_for_query(&query, captures, &intent);
    if sensitive_lookup {
        for item in &mut scored {
            if capture_sensitive_value(&item.capture).is_some() {
                item.score += 100;
            }
        }
    }
    let use_full_scope =
        request.tag.is_some() || request.context_id.is_some() || is_broad_collection_query(&query);
    let matching_count = scored
        .iter()
        .filter(|item| {
            if sensitive_lookup {
                capture_sensitive_value(&item.capture).is_some()
            } else {
                item.score > 0 || use_full_scope
            }
        })
        .count();
    let limit = request
        .limit
        .unwrap_or(mode.evidence_limit())
        .min(mode.evidence_limit())
        .max(1);
    Ok(MagicSearchPreviewDto {
        evidence_count: matching_count.min(limit),
        available_count,
    })
}

fn generate_magic_search_document(
    conn: &mut Connection,
    state: &AppState,
    mut request: MagicSearchRequest,
) -> CommandResult<MagicSearchDocumentDto> {
    let settings = settings_with_ai_secret(conn, state)?;
    let portuguese = settings.language == "pt-BR";
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err(AppError::new("search.query_required"));
    }
    let mode = classify_magic_response(&query, request.response_mode.as_deref());
    request.response_mode = Some(mode.as_str().to_string());
    let sensitive_lookup = is_sensitive_lookup(&query);
    let captures = load_magic_search_captures(conn, &request)?;
    let intent = detect_chat_intent(&query);
    let mut scored = score_captures_for_query(&query, captures, &intent);
    if sensitive_lookup {
        for item in &mut scored {
            if capture_sensitive_value(&item.capture).is_some() {
                item.score += 100;
            }
        }
    }
    scored.sort_by_key(|capture| std::cmp::Reverse(capture.score));
    let use_full_scope =
        request.tag.is_some() || request.context_id.is_some() || is_broad_collection_query(&query);
    let limit = request
        .limit
        .unwrap_or(mode.evidence_limit())
        .min(mode.evidence_limit())
        .max(1);
    let relevant = scored
        .into_iter()
        .filter(|item| {
            if sensitive_lookup {
                capture_sensitive_value(&item.capture).is_some()
            } else {
                item.score > 0 || use_full_scope
            }
        })
        .take(limit)
        .collect::<Vec<_>>();
    if relevant.is_empty() {
        return Err(AppError::new("search.no_evidence"));
    }

    let title = match mode {
        MagicResponseMode::Direct => format!(
            "{} — {}",
            if portuguese {
                "Resposta direta"
            } else {
                "Direct answer"
            },
            magic_search_title(&query)
        ),
        MagicResponseMode::Brief => format!(
            "{} — {}",
            if portuguese {
                "Resumo breve"
            } else {
                "Brief summary"
            },
            magic_search_title(&query)
        ),
        MagicResponseMode::Document => magic_search_title(&query),
    };
    let secret_map = SecretRedactionMap::for_magic_search(&query, &relevant);
    let sensitive_value = if sensitive_lookup {
        relevant
            .iter()
            .find_map(|item| capture_sensitive_value(&item.capture))
    } else {
        None
    };
    let deterministic = render_magic_search_response(
        &title,
        &query,
        &relevant,
        mode,
        portuguese,
        sensitive_value.as_deref(),
    );
    let (markdown, provider, model, generation_warning) = if sensitive_value.is_some() {
        (
            deterministic,
            "local".to_string(),
            "secure-lookup".to_string(),
            None,
        )
    } else if settings.ai_api_key.trim().is_empty() {
        (
            deterministic,
            "local".to_string(),
            "deterministic".to_string(),
            None,
        )
    } else {
        let prompt = build_magic_search_prompt(&query, &relevant, mode, portuguese, &secret_map);
        let system = magic_search_system_prompt(mode, portuguese);
        match call_ai_raw(&settings, &system, &prompt) {
            Ok(mut markdown) => {
                if !response_uses_expected_language(&markdown, portuguese) {
                    let retry_system = format!(
                        "{} {}",
                        system,
                        if portuguese {
                            "IMPORTANTE: responda exclusivamente em português brasileiro."
                        } else {
                            "IMPORTANT: respond exclusively in English."
                        }
                    );
                    if let Ok(retry) = call_ai_raw(&settings, &retry_system, &prompt) {
                        markdown = retry;
                    }
                }
                markdown = constrain_magic_response(&markdown, mode);
                (markdown, settings.ai_provider, settings.ai_model, None)
            }
            Err(error) => {
                eprintln!("AI provider failed; local synthesis was used: {error}");
                (
                    deterministic,
                    "local".to_string(),
                    "deterministic".to_string(),
                    Some(AppNotice::new("ai.provider_failed_local_fallback")),
                )
            }
        }
    };
    let markdown = if mode == MagicResponseMode::Document {
        let restored = secret_map.restore_document(&markdown);
        number_magic_search_sources(&restored, &relevant, portuguese)
    } else {
        markdown
    };

    let id = Uuid::new_v4().to_string();
    let created_at = now();
    let filters_json = serde_json::to_string(&request).map_err(err)?;
    let transaction = conn.transaction().map_err(err)?;
    let root_id = if let Some(previous_id) = request.previous_document_id.as_deref() {
        transaction
            .query_row(
                "SELECT root_id FROM magic_search_documents WHERE id = ?",
                [previous_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(err)?
    } else {
        id.clone()
    };
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM magic_search_documents WHERE root_id = ?",
            [&root_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(err)?;
    let generation_warning_json = generation_warning
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(err)?;
    transaction.execute(
        "INSERT INTO magic_search_documents
         (id, root_id, previous_document_id, version, title, query, markdown, provider, model, filters_json, generation_warning, evidence_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![id, root_id, request.previous_document_id, version, title, query, markdown, provider, model, filters_json, generation_warning_json, relevant.len() as i64, created_at],
    ).map_err(err)?;
    for (rank, item) in relevant.iter().enumerate() {
        let capture = &item.capture;
        let asset_paths = capture
            .assets
            .iter()
            .filter_map(|asset| asset.path.clone())
            .collect::<Vec<_>>();
        let asset_paths_json = serde_json::to_string(&asset_paths).map_err(err)?;
        transaction
            .execute(
                "INSERT INTO magic_search_evidence
             (document_id, capture_id, rank, score, captured_at, context_name, app_name,
              application_id, window_title, excerpt, asset_paths_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    capture.id,
                    rank as i64,
                    item.score,
                    capture.captured_at,
                    context_label(capture),
                    capture.source_app_name,
                    capture.source_app_id,
                    capture.window_title,
                    excerpt_for_query(&redact_sensitive_values(&capture.content_text)),
                    asset_paths_json,
                ],
            )
            .map_err(err)?;
    }
    transaction.commit().map_err(err)?;
    let mut document = get_magic_search_document(conn, &id)?;
    document.sensitive_value = sensitive_value;
    Ok(document)
}

fn magic_search_title(query: &str) -> String {
    let clean = query.trim().trim_end_matches(['.', '?', '!']);
    if clean.chars().count() <= 72 {
        clean.into()
    } else {
        shorten(clean, 72)
    }
}

fn render_magic_search_response(
    title: &str,
    query: &str,
    relevant: &[ScoredCapture],
    mode: MagicResponseMode,
    portuguese: bool,
    sensitive_value: Option<&str>,
) -> String {
    if let Some(value) = sensitive_value {
        let masked = mask_secret(value);
        let capture_id = &relevant[0].capture.id;
        return if portuguese {
            format!("A credencial encontrada é `{masked}`. Use **Revelar** ou **Copiar credencial** para acessar o valor completo. [capture:{capture_id}]")
        } else {
            format!("The credential found is `{masked}`. Use **Reveal** or **Copy credential** to access the full value. [capture:{capture_id}]")
        };
    }
    match mode {
        MagicResponseMode::Document => {
            render_magic_search_fallback(title, query, relevant, portuguese)
        }
        MagicResponseMode::Direct => {
            let capture = &relevant[0].capture;
            if query_requests_application_id(query) {
                if let Some(value) = capture
                    .source_app_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    return format!("`{value}` [capture:{}]", capture.id);
                }
            }
            let value = redact_sensitive_values(capture.content_text.trim());
            let concise = shorten(&value, 360);
            if portuguese {
                format!("Encontrei: {concise} [capture:{}]", capture.id)
            } else {
                format!("I found: {concise} [capture:{}]", capture.id)
            }
        }
        MagicResponseMode::Brief => {
            let heading = if portuguese {
                "## Resumo"
            } else {
                "## Summary"
            };
            let bullets = relevant
                .iter()
                .take(5)
                .map(|item| {
                    format!(
                        "- {} [capture:{}]",
                        shorten(
                            &redact_sensitive_values(item.capture.content_text.trim()),
                            220
                        ),
                        item.capture.id
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{heading}\n\n{bullets}")
        }
    }
}

fn query_requests_application_id(query: &str) -> bool {
    let normalized = normalize_text(query);
    [
        "applicationid",
        "application id",
        "app id",
        "identificador da aplicacao",
        "identificador da aplicação",
        "id da aplicacao",
        "id da aplicação",
    ]
    .iter()
    .any(|term| normalized.contains(term))
}

fn direct_answer_from_evidence(query: &str, evidence: &[EvidenceItem]) -> Option<String> {
    if !query_requests_application_id(query) {
        return None;
    }
    evidence
        .iter()
        .find_map(|item| item.application_id.clone())
        .filter(|value| !value.trim().is_empty())
}

fn magic_search_system_prompt(mode: MagicResponseMode, portuguese: bool) -> String {
    let language = if portuguese {
        "Responda exclusivamente em português brasileiro, independentemente do idioma da consulta."
    } else {
        "Respond exclusively in English, regardless of the query language."
    };
    let format = match (mode, portuguese) {
        (MagicResponseMode::Direct, true) => "Dê somente a resposta necessária em uma ou duas frases. Não crie título, introdução, conclusão, lista ou relatório.",
        (MagicResponseMode::Direct, false) => "Give only the necessary answer in one or two sentences. Do not create a title, introduction, conclusion, list, or report.",
        (MagicResponseMode::Brief, true) => "Produza um resumo curto: um parágrafo ou no máximo cinco tópicos. Não crie um relatório extenso.",
        (MagicResponseMode::Brief, false) => "Produce a brief summary: one paragraph or no more than five bullets. Do not create a long report.",
        (MagicResponseMode::Document, true) => "Gere um documento Markdown estruturado com resumo, estado atual, decisões, riscos, pendências e linha do tempo somente quando houver suporte.",
        (MagicResponseMode::Document, false) => "Generate a structured Markdown document with a summary, current state, decisions, risks, pending work, and a timeline only when supported.",
    };
    let evidence = if portuguese {
        "Use exclusivamente as evidências fornecidas. Toda afirmação factual deve citar [capture:ID]. Declare lacunas e não use cercas de código ao redor da resposta."
    } else {
        "Use only the supplied evidence. Every factual statement must cite [capture:ID]. State gaps and do not wrap the response in a code fence."
    };
    let placeholders = if portuguese {
        "Valores sensíveis aparecem como [SCRYPUPPY_SECRET_N]. Preserve cada placeholder exatamente como recebido e nunca tente reconstruir o valor oculto."
    } else {
        "Sensitive values appear as [SCRYPUPPY_SECRET_N]. Preserve every placeholder exactly as received and never try to reconstruct the hidden value."
    };
    format!("{language} {format} {evidence} {placeholders}")
}

fn number_magic_search_sources(
    markdown: &str,
    relevant: &[ScoredCapture],
    portuguese: bool,
) -> String {
    let mut numbered = markdown.trim().to_string();
    for (index, item) in relevant.iter().enumerate() {
        numbered = numbered.replace(
            &format!("[capture:{}]", item.capture.id),
            &format!("[{}]", index + 1),
        );
    }

    for heading in ["\n## Fontes", "\n## Sources"] {
        if let Some(index) = numbered.find(heading) {
            numbered.truncate(index);
            numbered = numbered.trim_end().to_string();
        }
    }

    let sources_heading = if portuguese {
        "## Fontes"
    } else {
        "## Sources"
    };
    numbered.push_str(&format!("\n\n{sources_heading}\n\n"));
    for (index, item) in relevant.iter().enumerate() {
        let capture = &item.capture;
        let app = capture
            .source_app_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(if portuguese {
                "Aplicativo desconhecido"
            } else {
                "Unknown application"
            });
        let window = capture
            .window_title
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        let context = context_label(capture);
        numbered.push_str(&format!("{}. **{}**", index + 1, app));
        if let Some(window) = window {
            numbered.push_str(&format!(" — {}", window));
        }
        numbered.push_str(&format!(
            " — {}. {}: {}. `capture:{}`\n",
            capture.captured_at,
            if portuguese { "Contexto" } else { "Context" },
            context,
            capture.id,
        ));
    }
    numbered
}

fn strip_magic_search_sources(markdown: &str) -> String {
    let source_index = ["\n## Fontes", "\n## Sources"]
        .iter()
        .filter_map(|heading| markdown.find(heading))
        .min();
    source_index
        .map(|index| markdown[..index].trim_end().to_string())
        .unwrap_or_else(|| markdown.trim_end().to_string())
}

fn append_magic_search_sources(body: &str, evidence: &[EvidenceItem], portuguese: bool) -> String {
    let mut markdown = body.trim_end().to_string();
    markdown.push_str(if portuguese {
        "\n\n## Fontes\n\n"
    } else {
        "\n\n## Sources\n\n"
    });
    for (index, item) in evidence.iter().enumerate() {
        let app = item.app_name.as_deref().unwrap_or(if portuguese {
            "Aplicativo desconhecido"
        } else {
            "Unknown application"
        });
        markdown.push_str(&format!("{}. **{}**", index + 1, app));
        if let Some(window) = item
            .window_title
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            markdown.push_str(&format!(" — {window}"));
        }
        let contexts = if item.context_names.is_empty() {
            "Inbox".to_string()
        } else {
            item.context_names.join(", ")
        };
        markdown.push_str(&format!(
            " — {}. {}: {}. `capture:{}`\n",
            item.captured_at,
            if portuguese { "Contexto" } else { "Context" },
            contexts,
            item.capture_id,
        ));
    }
    markdown
}

fn renumber_citations_after_removal(markdown: &str, removed_number: usize) -> String {
    let citation = Regex::new(r"\[(\d+)\]").expect("valid citation regex");
    citation
        .replace_all(markdown, |captures: &regex::Captures<'_>| {
            let number = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            if number == removed_number {
                String::new()
            } else if number > removed_number {
                format!("[{}]", number - 1)
            } else {
                captures[0].to_string()
            }
        })
        .into_owned()
}

fn rewrite_magic_search_sources(
    conn: &Connection,
    document_id: &str,
    removed_number: Option<usize>,
) -> Result<(), String> {
    let document = get_magic_search_document(conn, document_id)?;
    let portuguese = document.markdown.contains("\n## Fontes");
    let mut body = strip_magic_search_sources(&document.markdown);
    if let Some(number) = removed_number {
        body = renumber_citations_after_removal(&body, number);
    }
    let markdown = append_magic_search_sources(&body, &document.evidence, portuguese);
    conn.execute(
        "UPDATE magic_search_documents SET markdown = ?, evidence_count = ? WHERE id = ?",
        params![markdown, document.evidence.len() as i64, document_id],
    )
    .map_err(err)?;
    Ok(())
}

fn add_magic_search_evidence_to_document(
    conn: &Connection,
    document_id: &str,
    capture_id: &str,
) -> Result<(), String> {
    get_magic_search_document(conn, document_id)?;
    if conn
        .query_row(
            "SELECT 1 FROM magic_search_evidence WHERE document_id = ? AND capture_id = ?",
            params![document_id, capture_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(err)?
        .is_some()
    {
        return Err("Esta captura já é uma fonte do documento.".to_string());
    }
    let capture = get_capture_by_id(conn, capture_id)?;
    let rank = conn
        .query_row(
            "SELECT COALESCE(MAX(rank), -1) + 1 FROM magic_search_evidence WHERE document_id = ?",
            [document_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(err)?;
    let asset_paths = capture
        .assets
        .iter()
        .filter_map(|asset| asset.path.clone())
        .collect::<Vec<_>>();
    conn.execute(
        "INSERT INTO magic_search_evidence
         (document_id, capture_id, rank, score, captured_at, context_name, app_name,
          application_id, window_title, excerpt, asset_paths_json)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
        params![
            document_id,
            capture.id,
            rank,
            capture.captured_at,
            context_label(&capture),
            capture.source_app_name,
            capture.source_app_id,
            capture.window_title,
            excerpt_for_query(&redact_sensitive_values(&capture.content_text)),
            serde_json::to_string(&asset_paths).map_err(err)?,
        ],
    )
    .map_err(err)?;
    rewrite_magic_search_sources(conn, document_id, None)
}

fn remove_magic_search_evidence_from_document(
    conn: &Connection,
    document_id: &str,
    capture_id: &str,
) -> Result<(), String> {
    let rank = conn
        .query_row(
            "SELECT rank FROM magic_search_evidence WHERE document_id = ? AND capture_id = ?",
            params![document_id, capture_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| "Fonte não encontrada no documento.".to_string())?;
    conn.execute(
        "DELETE FROM magic_search_evidence WHERE document_id = ? AND capture_id = ?",
        params![document_id, capture_id],
    )
    .map_err(err)?;
    conn.execute(
        "UPDATE magic_search_evidence SET rank = rank - 1 WHERE document_id = ? AND rank > ?",
        params![document_id, rank],
    )
    .map_err(err)?;
    rewrite_magic_search_sources(conn, document_id, Some(rank as usize + 1))
}

fn render_magic_search_fallback(
    title: &str,
    query: &str,
    relevant: &[ScoredCapture],
    portuguese: bool,
) -> String {
    let mut markdown = if portuguese {
        format!("# Magic Search — {title}\n\n> Consulta: {query}\n\n## Evidências consolidadas\n\n")
    } else {
        format!("# Magic Search — {title}\n\n> Query: {query}\n\n## Consolidated evidence\n\n")
    };
    for item in relevant {
        let capture = &item.capture;
        markdown.push_str(&format!(
            "### {} — {}\n\n",
            capture.captured_at,
            capture.source_app_name.as_deref().unwrap_or(if portuguese {
                "Aplicativo desconhecido"
            } else {
                "Unknown application"
            }),
        ));
        markdown.push_str(&markdown_fenced_block(&shorten(
            &redact_sensitive_values(&capture.content_text),
            1200,
        )));
        markdown.push_str(&if portuguese {
            format!(
                "\n**Contexto:** {}  \n**Referência:** [capture:{}]\n\n---\n\n",
                context_label(capture),
                capture.id
            )
        } else {
            format!(
                "\n**Context:** {}  \n**Reference:** [capture:{}]\n\n---\n\n",
                context_label(capture),
                capture.id
            )
        });
    }
    markdown
}

fn markdown_fenced_block(content: &str) -> String {
    let max_backticks = content
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat((max_backticks + 1).max(3));
    format!("{fence}text\n{content}\n{fence}\n")
}

fn build_magic_search_prompt(
    query: &str,
    relevant: &[ScoredCapture],
    mode: MagicResponseMode,
    portuguese: bool,
    secret_map: &SecretRedactionMap,
) -> String {
    let evidence = relevant
        .iter()
        .map(|item| {
            let capture = &item.capture;
            format!(
                "[capture:{}]\n{}: {}\nApp: {}\n{}: {}\n{}: {}\nTags: {}\n{}: {}\nOCR: {}",
                capture.id,
                if portuguese { "Data" } else { "Date" },
                capture.captured_at,
                secret_map.redact(capture.source_app_name.as_deref().unwrap_or("unknown")),
                if portuguese { "Contexto" } else { "Context" },
                secret_map.redact(&context_label(capture)),
                if portuguese { "Contextos" } else { "Contexts" },
                secret_map.redact(
                    &capture
                        .contexts
                        .iter()
                        .map(|context| context.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                secret_map.redact(&capture.tags.join(", ")),
                if portuguese { "Texto" } else { "Text" },
                shorten(&secret_map.redact(&capture.content_text), 1600),
                capture
                    .ocr
                    .as_ref()
                    .and_then(|ocr| ocr.text.as_deref())
                    .map(|text| shorten(&secret_map.redact(text), 500))
                    .unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let instruction = match (mode, portuguese) {
        (MagicResponseMode::Direct, true) => {
            "Responda diretamente, sem seções e sem repetir a pergunta."
        }
        (MagicResponseMode::Direct, false) => {
            "Answer directly, without sections and without repeating the question."
        }
        (MagicResponseMode::Brief, true) => "Forneça um resumo curto com no máximo cinco pontos.",
        (MagicResponseMode::Brief, false) => {
            "Provide a brief summary with no more than five points."
        }
        (MagicResponseMode::Document, true) => {
            "Gere um documento Markdown condensado e rastreável."
        }
        (MagicResponseMode::Document, false) => {
            "Generate a condensed and traceable Markdown document."
        }
    };
    let safe_query = secret_map.redact(query);
    if portuguese {
        format!(
            "Consulta do usuário:\n{safe_query}\n\nEvidências locais:\n{evidence}\n\n{instruction}"
        )
    } else {
        format!("User query:\n{safe_query}\n\nLocal evidence:\n{evidence}\n\n{instruction}")
    }
}

fn list_magic_search_documents(conn: &Connection) -> Result<Vec<MagicSearchListItemDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, root_id, version, title, query, provider, model, evidence_count, created_at, filters_json
         FROM magic_search_documents ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(err)?;
    let documents = stmt
        .query_map([], |row| {
            let filters_json = row.get::<_, String>(9)?;
            let response_mode = serde_json::from_str::<MagicSearchRequest>(&filters_json)
                .ok()
                .and_then(|filters| filters.response_mode)
                .unwrap_or_else(|| "document".to_string());
            Ok(MagicSearchListItemDto {
                id: row.get(0)?,
                root_id: row.get(1)?,
                version: row.get(2)?,
                title: row.get(3)?,
                query: row.get(4)?,
                provider: row.get(5)?,
                model: row.get(6)?,
                evidence_count: row.get(7)?,
                created_at: row.get(8)?,
                response_mode,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(documents)
}

fn get_magic_search_document(
    conn: &Connection,
    id: &str,
) -> Result<MagicSearchDocumentDto, String> {
    let row = conn.query_row(
        "SELECT id, root_id, previous_document_id, version, title, query, markdown, provider, model,
                filters_json, generation_warning, evidence_count, created_at
         FROM magic_search_documents WHERE id = ?",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, String>(12)?,
            ))
        },
    ).map_err(err)?;
    let filters: MagicSearchRequest = serde_json::from_str(&row.9).map_err(err)?;
    let response_mode = filters
        .response_mode
        .clone()
        .unwrap_or_else(|| "document".to_string());
    let mut document = MagicSearchDocumentDto {
        id: row.0,
        root_id: row.1,
        previous_document_id: row.2,
        version: row.3,
        title: row.4,
        query: row.5,
        markdown: row.6,
        provider: row.7,
        model: row.8,
        filters,
        generation_warning: row.10.as_deref().and_then(AppNotice::from_stored),
        evidence_count: row.11,
        created_at: row.12,
        evidence: Vec::new(),
        response_mode,
        sensitive_value: None,
        answer_value: None,
    };
    let mut stmt = conn
        .prepare(
            "SELECT mse.capture_id,
                    COALESCE(mse.captured_at, c.captured_at, ''),
                    COALESCE(mse.context_name, ''),
                    COALESCE(mse.app_name, c.source_app_name),
                    COALESCE(mse.application_id, c.source_app_id),
                    COALESCE(mse.window_title, c.window_title),
                    COALESCE(mse.excerpt, substr(c.content_text, 1, 220), 'Evidencia removida'),
                    mse.asset_paths_json
         FROM magic_search_evidence mse
         LEFT JOIN captures c ON c.id = mse.capture_id
         WHERE mse.document_id = ? ORDER BY mse.rank",
        )
        .map_err(err)?;
    document.evidence = stmt
        .query_map([id], |row| {
            let asset_paths_json = row.get::<_, String>(7)?;
            Ok(EvidenceItem {
                capture_id: row.get(0)?,
                captured_at: row.get(1)?,
                context_names: row
                    .get::<_, String>(2)?
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect(),
                app_name: row.get(3)?,
                application_id: row.get(4)?,
                window_title: row.get(5)?,
                excerpt: row.get(6)?,
                matched_fields: Vec::new(),
                asset_paths: serde_json::from_str(&asset_paths_json).unwrap_or_default(),
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if document.response_mode == "direct" {
        document.answer_value = direct_answer_from_evidence(&document.query, &document.evidence);
    }
    Ok(document)
}

fn export_markdown(
    state: &AppState,
    category: &str,
    title: &str,
    markdown: &str,
) -> Result<String, String> {
    let directory = state.app_dir.join("exports").join(category);
    fs::create_dir_all(&directory).map_err(err)?;
    let slug = slugify(title);
    let path = directory.join(format!(
        "{}-{}.md",
        if slug.is_empty() { "documento" } else { &slug },
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::write(&path, markdown).map_err(err)?;
    Ok(path.display().to_string())
}

fn export_markdown_to_path(requested_path: &str, markdown: &str) -> CommandResult<String> {
    let requested_path = requested_path.trim();
    if requested_path.is_empty() {
        return Err(AppError::new("export.path_required"));
    }

    let mut path = PathBuf::from(requested_path);
    if !path.is_absolute() {
        return Err(AppError::new("export.absolute_path_required"));
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("md"))
        .unwrap_or(true)
    {
        path.set_extension("md");
    }
    if path.is_dir() {
        return Err(AppError::new("export.file_required"));
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| AppError::new("export.folder_not_found"))?;
    if !parent.is_absolute() {
        return Err(AppError::new("export.absolute_path_required"));
    }

    fs::write(&path, markdown).map_err(err)?;
    Ok(path.display().to_string())
}

fn call_ai_provider(
    settings: &SettingsDto,
    query: &str,
    local_answer: &ChatAnswer,
) -> Result<String, String> {
    let portuguese = settings.language == "pt-BR";
    let system = if portuguese {
        "Você é o assistente do ScryPuppy. Responda em português brasileiro. Use somente as evidências fornecidas. Sempre cite as capturas usadas pelo horário, aplicativo e contexto. Se a evidência for insuficiente, diga isso claramente."
    } else {
        "You are the ScryPuppy assistant. Respond in English. Use only the supplied evidence. Always cite the captures used by time, application, and context. If the evidence is insufficient, say so clearly."
    };
    let prompt = build_ai_prompt(query, local_answer, portuguese);

    call_ai_raw(settings, system, &prompt)
}

fn build_ai_prompt(query: &str, local_answer: &ChatAnswer, portuguese: bool) -> String {
    let evidence = local_answer
        .evidence
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "{} {}:\n- capture_id: {}\n- {}: {}\n- {}: {}\n- app: {}\n- application_id: {}\n- {}: {}\n- {}: {}\n- {}: {}",
                if portuguese { "Evidência" } else { "Evidence" },
                index + 1,
                item.capture_id,
                if portuguese { "horário" } else { "time" },
                item.captured_at,
                if portuguese { "contexto" } else { "context" },
                item.context_names.join(", "),
                item.app_name.as_deref().unwrap_or("unknown"),
                item.application_id.as_deref().unwrap_or("unknown"),
                if portuguese { "janela" } else { "window" },
                item.window_title.as_deref().unwrap_or("unknown"),
                if portuguese { "campos_encontrados" } else { "matched_fields" },
                item.matched_fields.join(", "),
                if portuguese { "trecho" } else { "excerpt" },
                item.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if portuguese {
        format!("Pergunta do usuário:\n{}\n\nResposta local preliminar:\n{}\n\nEvidências locais:\n{}\n\nGere uma resposta final curta, precisa e com evidências.", query, local_answer.answer, evidence)
    } else {
        format!("User question:\n{}\n\nPreliminary local answer:\n{}\n\nLocal evidence:\n{}\n\nGenerate a short, precise final answer supported by evidence.", query, local_answer.answer, evidence)
    }
}

fn open_conn(state: &AppState) -> Result<Connection, String> {
    fs::create_dir_all(&state.app_dir).map_err(err)?;
    let conn = Connection::open(state.db_path()).map_err(err)?;
    apply_database_key(&conn, &state.database_key)?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(err)?;
    Ok(conn)
}

fn initialize_database(state: &AppState) -> Result<(), String> {
    fs::create_dir_all(&state.app_dir).map_err(err)?;
    ensure_encrypted_database(state)?;
    let conn = open_conn(state)?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Não foi possível abrir a base criptografada. Verifique a credencial do ScryPuppy no Windows Credential Manager: {error}"))?;
    migrate(&conn).map_err(err)?;
    migrate_legacy_ai_key(&conn)?;
    Ok(())
}

fn import_file_capture(
    app: &AppHandle,
    state: AppState,
    source_path: &Path,
) -> Result<CaptureDto, String> {
    if !source_path.exists() {
        return Err(format!(
            "The selected path does not exist: {}",
            source_path.display()
        ));
    }
    let source_path = source_path.to_path_buf();
    let active_window = ActiveWindowMetadata {
        title: source_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string),
        process_path: None,
        app_name: Some("Windows Explorer".into()),
        window_id: None,
        process_id: None,
        position: None,
        error: None,
    };
    persist_clipboard_payload(
        app,
        state,
        ClipboardSnapshot {
            representations: vec![ClipboardRepresentation::Files(vec![
                ClipboardFile::physical(source_path),
            ])],
            formats: Vec::new(),
        },
        active_window,
        CaptureOrigin::FileImport,
        "capture",
        INBOX_CONTEXT_ID,
    )
}

fn import_path_from_args(args: &[String]) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == "--import-file")
        .map(|pair| PathBuf::from(&pair[1]))
}

fn process_import_args(app: AppHandle, args: Vec<String>) {
    let Some(path) = import_path_from_args(&args) else {
        return;
    };
    thread::spawn(move || {
        let state = app.state::<AppState>().inner().clone();
        if let Err(message) = import_file_capture(&app, state, &path) {
            let _ = app.emit(
                "capture-error",
                CaptureErrorEvent {
                    error: AppError::from(message),
                },
            );
        }
    });
}

#[cfg(target_os = "windows")]
fn register_windows_context_menu() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(err)?;
    let command = format!("\"{}\" --import-file \"%1\"", executable.display());
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu.create_subkey("Software\\Classes").map_err(err)?.0;
    let icon = executable.display().to_string();
    let associations = ["*", "Directory"];

    for association in associations {
        let key_path = format!("SystemFileAssociations\\{association}\\shell\\Scryppy");
        let shell_key = classes.create_subkey(&key_path).map_err(err)?.0;
        shell_key
            .set_value("", &"Save with ScryPuppy")
            .map_err(err)?;
        shell_key.set_value("Icon", &icon).map_err(err)?;
        let command_key = shell_key.create_subkey("command").map_err(err)?.0;
        command_key.set_value("", &command).map_err(err)?;
    }
    Ok(())
}

fn apply_database_key(conn: &Connection, key: &str) -> Result<(), String> {
    if key.len() != 64 || !key.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Chave local do banco inválida.".into());
    }
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
        .map_err(err)
}

fn ensure_encrypted_database(state: &AppState) -> Result<(), String> {
    let path = state.db_path();
    if !path.exists() || !database_is_plaintext(&path)? {
        return Ok(());
    }

    let encrypted_path = state.app_dir.join("scryppy.sqlite.encrypted-tmp");
    let backup_path = state
        .app_dir
        .join("scryppy.sqlite.plaintext-migration-backup");
    if encrypted_path.exists() {
        secure_remove_file(&encrypted_path)?;
    }
    if backup_path.exists() {
        secure_remove_file(&backup_path)?;
    }

    let plaintext = Connection::open(&path).map_err(err)?;
    plaintext
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(err)?;
    plaintext
        .execute(
            "ATTACH DATABASE ? AS encrypted KEY ?",
            params![
                encrypted_path.display().to_string(),
                format!("x'{}'", state.database_key)
            ],
        )
        .map_err(err)?;
    plaintext
        .execute_batch("SELECT sqlcipher_export('encrypted'); DETACH DATABASE encrypted;")
        .map_err(|error| format!("Falha ao criptografar a base existente: {error}"))?;
    drop(plaintext);

    let encrypted = Connection::open(&encrypted_path).map_err(err)?;
    apply_database_key(&encrypted, &state.database_key)?;
    encrypted
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| format!("A cópia criptografada não pôde ser validada: {error}"))?;
    drop(encrypted);

    fs::rename(&path, &backup_path).map_err(err)?;
    fs::rename(&encrypted_path, &path).map_err(err)?;
    secure_remove_file(&backup_path)?;
    Ok(())
}

fn database_is_plaintext(path: &Path) -> Result<bool, String> {
    let mut header = [0u8; 16];
    let mut file = File::open(path).map_err(err)?;
    match file.read_exact(&mut header) {
        Ok(()) => Ok(header.starts_with(b"SQLite format 3\0")),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(err(error)),
    }
}

fn credential_entry(name: &str) -> Result<CredentialEntry, String> {
    CredentialEntry::new(CREDENTIAL_SERVICE, name)
        .map_err(|error| format!("Windows Credential Manager indisponível: {error}"))
}

fn get_or_create_secret(name: &str, allow_create: bool) -> Result<String, String> {
    let entry = credential_entry(name)?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) | Err(CredentialError::NoEntry) if allow_create => {
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            entry.set_password(&secret).map_err(|error| format!("Não foi possível salvar a chave no Windows Credential Manager: {error}"))?;
            Ok(secret)
        }
        Ok(_) => Err("A credencial de segurança local está vazia.".into()),
        Err(CredentialError::NoEntry) => Err("A chave de segurança local não foi encontrada no Windows Credential Manager. A base existente não será aberta sem ela.".into()),
        Err(error) => Err(format!("Não foi possível ler o Windows Credential Manager: {error}")),
    }
}

fn get_credential(name: &str) -> Result<Option<String>, String> {
    match credential_entry(name)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(CredentialError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Não foi possível ler o Windows Credential Manager: {error}"
        )),
    }
}

fn set_credential(name: &str, value: &str) -> Result<(), String> {
    credential_entry(name)?
        .set_password(value)
        .map_err(|error| format!("Não foi possível salvar no Windows Credential Manager: {error}"))
}

fn delete_credential(name: &str) -> Result<(), String> {
    match credential_entry(name)?.delete_credential() {
        Ok(()) | Err(CredentialError::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Não foi possível remover do Windows Credential Manager: {error}"
        )),
    }
}

fn secure_remove_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() {
        let len = fs::metadata(path).map_err(err)?.len();
        let mut file = OpenOptions::new().write(true).open(path).map_err(err)?;
        let zeros = [0u8; 8192];
        let mut remaining = len;
        while remaining > 0 {
            let amount = remaining.min(zeros.len() as u64) as usize;
            file.write_all(&zeros[..amount]).map_err(err)?;
            remaining -= amount as u64;
        }
        file.sync_all().map_err(err)?;
    }
    fs::remove_file(path).map_err(err)
}

fn secure_remove_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.is_dir() {
            secure_remove_dir(&path)?;
        } else {
            secure_remove_file(&path)?;
        }
    }
    fs::remove_dir(path).map_err(err)
}

fn delete_all_data_from_state(state: &AppState) -> Result<(), String> {
    secure_remove_dir(&state.app_dir.join("assets"))?;
    secure_remove_dir(&state.markdown_dir())?;
    for suffix in [
        "",
        "-wal",
        "-shm",
        ".plaintext-migration-backup",
        ".encrypted-tmp",
    ] {
        secure_remove_file(&PathBuf::from(format!(
            "{}{}",
            state.db_path().display(),
            suffix
        )))?;
    }
    delete_credential(AI_KEY_CREDENTIAL)?;
    initialize_database(state)?;
    sync_markdown(state).map_err(err)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS contexts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL DEFAULT '',
            slug TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS captures (
            id TEXT PRIMARY KEY,
            context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE RESTRICT,
            content_text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            source_app_name TEXT,
            source_app_id TEXT,
            source_process_id INTEGER,
            source_process_path TEXT,
            window_title TEXT,
            window_id TEXT,
            platform TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            capture_kind TEXT NOT NULL DEFAULT 'capture',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS capture_assets (
            id TEXT PRIMARY KEY,
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            path TEXT,
            status TEXT NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS capture_representations (
            id TEXT PRIMARY KEY,
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            kind TEXT NOT NULL,
            format_name TEXT NOT NULL,
            mime_type TEXT,
            text_content TEXT,
            asset_path TEXT,
            size_bytes INTEGER,
            sha256 TEXT,
            restorable INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(capture_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS capture_file_entries (
            id TEXT PRIMARY KEY,
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            representation_id TEXT NOT NULL REFERENCES capture_representations(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            original_path TEXT,
            local_path TEXT,
            entry_kind TEXT NOT NULL,
            extension TEXT,
            size_bytes INTEGER,
            sha256 TEXT,
            availability TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(representation_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS capture_clipboard_formats (
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            format_id INTEGER NOT NULL,
            format_name TEXT NOT NULL,
            supported INTEGER NOT NULL,
            PRIMARY KEY(capture_id, format_id)
        );

        CREATE INDEX IF NOT EXISTS idx_capture_representations_capture
            ON capture_representations(capture_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_capture_file_entries_capture
            ON capture_file_entries(capture_id, ordinal);

        CREATE TABLE IF NOT EXISTS capture_tags (
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (capture_id, tag)
        );

        CREATE TABLE IF NOT EXISTS capture_contexts (
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
            assignment_origin TEXT NOT NULL CHECK (assignment_origin IN ('manual', 'automatic')),
            confidence REAL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (capture_id, context_id)
        );

        CREATE TABLE IF NOT EXISTS capture_entities (
            id TEXT PRIMARY KEY,
            capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            source TEXT NOT NULL,
            confidence REAL NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS capture_ocr (
            capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            text TEXT,
            error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ocr_jobs (
            capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL REFERENCES capture_assets(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            queued_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS magic_search_documents (
            id TEXT PRIMARY KEY,
            root_id TEXT NOT NULL,
            previous_document_id TEXT,
            version INTEGER NOT NULL,
            title TEXT NOT NULL,
            query TEXT NOT NULL,
            markdown TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            filters_json TEXT NOT NULL,
            generation_warning TEXT,
            evidence_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS magic_search_evidence (
            document_id TEXT NOT NULL REFERENCES magic_search_documents(id) ON DELETE CASCADE,
            capture_id TEXT NOT NULL,
            rank INTEGER NOT NULL,
            score INTEGER NOT NULL,
            captured_at TEXT,
            context_name TEXT,
            app_name TEXT,
            application_id TEXT,
            window_title TEXT,
            excerpt TEXT,
            asset_paths_json TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (document_id, capture_id)
        );

        CREATE INDEX IF NOT EXISTS idx_captures_captured_at ON captures(captured_at);
        CREATE INDEX IF NOT EXISTS idx_capture_contexts_context ON capture_contexts(context_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_capture_tags_tag ON capture_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_capture_entities_kind_value ON capture_entities(kind, value);
        CREATE INDEX IF NOT EXISTS idx_ocr_jobs_status ON ocr_jobs(status, queued_at);
        CREATE INDEX IF NOT EXISTS idx_magic_search_root ON magic_search_documents(root_id, version DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_search_root_version ON magic_search_documents(root_id, version);
        CREATE INDEX IF NOT EXISTS idx_magic_search_evidence_document ON magic_search_evidence(document_id, rank);
        ",
    )?;

    if !column_exists(conn, "contexts", "normalized_name")? {
        conn.execute(
            "ALTER TABLE contexts ADD COLUMN normalized_name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    conn.execute(
        "UPDATE contexts SET normalized_name = lower(trim(name)) WHERE normalized_name = ''",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_normalized_name
         ON contexts(normalized_name) WHERE id NOT IN ('inbox', 'content-base')",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO capture_contexts
            (capture_id, context_id, assignment_origin, confidence, created_at)
         SELECT id, context_id, 'manual', NULL, created_at FROM captures
         WHERE context_id NOT IN ('inbox', 'content-base')",
        [],
    )?;
    conn.execute(
        "UPDATE captures SET context_id = CASE WHEN capture_kind = 'reference' THEN 'content-base' ELSE 'inbox' END
         WHERE context_id NOT IN ('inbox', 'content-base')",
        [],
    )?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS capture_project_categories;
         DROP TABLE IF EXISTS project_category_anchors;
         DROP TABLE IF EXISTS project_categories;",
    )?;

    if !column_exists(conn, "captures", "capture_kind")? {
        conn.execute(
            "ALTER TABLE captures ADD COLUMN capture_kind TEXT NOT NULL DEFAULT 'capture'",
            [],
        )?;
    }

    if !column_exists(conn, "magic_search_documents", "generation_warning")? {
        conn.execute(
            "ALTER TABLE magic_search_documents ADD COLUMN generation_warning TEXT",
            [],
        )?;
    }
    for (column, definition) in [
        ("captured_at", "TEXT"),
        ("context_name", "TEXT"),
        ("app_name", "TEXT"),
        ("application_id", "TEXT"),
        ("window_title", "TEXT"),
        ("excerpt", "TEXT"),
        ("asset_paths_json", "TEXT NOT NULL DEFAULT '[]'"),
    ] {
        if !column_exists(conn, "magic_search_evidence", column)? {
            conn.execute(
                &format!("ALTER TABLE magic_search_evidence ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    conn.execute_batch(
        "UPDATE magic_search_evidence
         SET captured_at = COALESCE(captured_at, (
                 SELECT c.captured_at FROM captures c WHERE c.id = magic_search_evidence.capture_id
             )),
             context_name = COALESCE(context_name, (
                 SELECT group_concat(co.name, ', ') FROM capture_contexts cc
                 JOIN contexts co ON co.id = cc.context_id
                 WHERE cc.capture_id = magic_search_evidence.capture_id
             ), ''),
             app_name = COALESCE(app_name, (
                 SELECT c.source_app_name FROM captures c WHERE c.id = magic_search_evidence.capture_id
             )),
             application_id = COALESCE(application_id, (
                 SELECT c.source_app_id FROM captures c WHERE c.id = magic_search_evidence.capture_id
             )),
             window_title = COALESCE(window_title, (
                 SELECT c.window_title FROM captures c WHERE c.id = magic_search_evidence.capture_id
             )),
             excerpt = COALESCE(excerpt, (
                 SELECT substr(c.content_text, 1, 220) FROM captures c WHERE c.id = magic_search_evidence.capture_id
             )),
             asset_paths_json = CASE WHEN asset_paths_json = '[]' THEN COALESCE((
                 SELECT json_group_array(ca.path) FROM capture_assets ca
                 WHERE ca.capture_id = magic_search_evidence.capture_id AND ca.path IS NOT NULL
             ), '[]') ELSE asset_paths_json END
         WHERE captured_at IS NULL
           AND EXISTS (SELECT 1 FROM captures c WHERE c.id = magic_search_evidence.capture_id);",
    )?;

    let now = now();
    conn.execute(
        "INSERT OR IGNORE INTO contexts (id, name, normalized_name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![INBOX_CONTEXT_ID, "Inbox", "inbox", "inbox", now, now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO contexts (id, name, normalized_name, slug, created_at, updated_at)
         VALUES (?, ?, 'content base', ?, ?, ?)",
        params![
            CONTENT_BASE_CONTEXT_ID,
            "Base de conteúdo",
            "base-de-conteudo",
            now,
            now
        ],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('capture_screenshots', 'true')",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_provider', 'deepseek')",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_model', 'deepseek-v4-flash')",
        [],
    )?;
    for key in [
        "clipboard_monitor_enabled",
        "clipboard_monitor_capture_screenshots",
        "clipboard_monitor_quick_context_enabled",
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'false')",
            [key],
        )?;
    }
    Ok(())
}

fn migrate_legacy_ai_key(conn: &Connection) -> Result<(), String> {
    let legacy_key = get_setting(conn, "ai_api_key")?;
    if let Some(legacy_key) = legacy_key.filter(|value| !value.trim().is_empty()) {
        if get_credential(AI_KEY_CREDENTIAL)?.is_none() {
            set_credential(AI_KEY_CREDENTIAL, legacy_key.trim())?;
        }
    }
    conn.execute("DELETE FROM settings WHERE key = 'ai_api_key'", [])
        .map_err(err)?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for candidate in columns {
        if candidate? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn capture_base_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureDto> {
    let id: String = row.get(0)?;
    let metadata_json: String = row.get(10)?;
    Ok(CaptureDto {
        id,
        content_text: row.get(1)?,
        captured_at: row.get(2)?,
        source_app_name: row.get(3)?,
        source_app_id: row.get(4)?,
        source_process_id: row.get(5)?,
        source_process_path: row.get(6)?,
        window_title: row.get(7)?,
        window_id: row.get(8)?,
        platform: row.get(9)?,
        kind: row.get(11)?,
        content_kind: "unknown".into(),
        metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({})),
        assets: Vec::new(),
        representations: Vec::new(),
        files: Vec::new(),
        clipboard_formats: Vec::new(),
        tags: Vec::new(),
        entities: Vec::new(),
        ocr: None,
        contexts: Vec::new(),
    })
}

fn hydrate_captures(conn: &Connection, captures: &mut [CaptureDto]) -> Result<(), String> {
    if captures.is_empty() {
        return Ok(());
    }
    let indexes = captures
        .iter()
        .enumerate()
        .map(|(index, capture)| (capture.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let ids = captures
        .iter()
        .map(|capture| capture.id.clone())
        .collect::<Vec<_>>();
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let args = ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect::<Vec<_>>();

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, id, kind, path, status, error, created_at
         FROM capture_assets WHERE capture_id IN ({placeholders}) ORDER BY created_at"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CaptureAssetDto {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    path: row.get(3)?,
                    status: row.get(4)?,
                    error: row.get(5)?,
                    created_at: row.get(6)?,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, asset) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].assets.push(asset);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, id, kind, format_name, mime_type, text_content,
                    asset_path, size_bytes, sha256, restorable, metadata_json
             FROM capture_representations
             WHERE capture_id IN ({placeholders}) ORDER BY capture_id, ordinal"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            let metadata_json: String = row.get(10)?;
            Ok((
                row.get::<_, String>(0)?,
                CaptureRepresentationDto {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    format_name: row.get(3)?,
                    mime_type: row.get(4)?,
                    text_content: row.get(5)?,
                    asset_path: row.get(6)?,
                    size_bytes: row.get(7)?,
                    sha256: row.get(8)?,
                    restorable: row.get::<_, i64>(9)? != 0,
                    metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({})),
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, representation) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].representations.push(representation);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, id, representation_id, ordinal, display_name, original_path,
                    local_path, entry_kind, extension, size_bytes, sha256, availability,
                    metadata_json
             FROM capture_file_entries
             WHERE capture_id IN ({placeholders}) ORDER BY capture_id, ordinal"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            let metadata_json: String = row.get(12)?;
            Ok((
                row.get::<_, String>(0)?,
                CaptureFileDto {
                    id: row.get(1)?,
                    representation_id: row.get(2)?,
                    ordinal: row.get(3)?,
                    display_name: row.get(4)?,
                    original_path: row.get(5)?,
                    local_path: row.get(6)?,
                    entry_kind: row.get(7)?,
                    extension: row.get(8)?,
                    size_bytes: row.get(9)?,
                    sha256: row.get(10)?,
                    availability: row.get(11)?,
                    metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({})),
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, file) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            let mut file = file;
            if matches!(file.availability.as_str(), "available" | "missing") {
                if let Some(path) = file.local_path.as_deref().or(file.original_path.as_deref()) {
                    let path = Path::new(path);
                    if !clipboard::is_network_path(path) {
                        file.availability = if path.exists() {
                            "available".into()
                        } else {
                            "missing".into()
                        };
                    }
                }
            }
            captures[*index].files.push(file);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, format_id, format_name, supported
             FROM capture_clipboard_formats
             WHERE capture_id IN ({placeholders}) ORDER BY capture_id, format_id"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CaptureClipboardFormatDto {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    supported: row.get::<_, i64>(3)? != 0,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, format) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].clipboard_formats.push(format);
        }
    }

    for capture in captures.iter_mut() {
        capture.content_kind = ["files", "image", "html", "rich_text", "url", "plain_text"]
            .into_iter()
            .find(|kind| {
                capture
                    .representations
                    .iter()
                    .any(|item| item.kind == *kind)
            })
            .unwrap_or("unknown")
            .to_string();
    }

    let mut stmt = conn
        .prepare(&format!(
        "SELECT capture_id, tag FROM capture_tags WHERE capture_id IN ({placeholders}) ORDER BY tag"
    ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, tag) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].tags.push(tag);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, id, kind, value, source, confidence FROM capture_entities
         WHERE capture_id IN ({placeholders}) ORDER BY kind, value"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CaptureEntityDto {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    value: row.get(3)?,
                    source: row.get(4)?,
                    confidence: row.get(5)?,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, entity) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].entities.push(entity);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT capture_id, status, text, error, updated_at FROM capture_ocr
         WHERE capture_id IN ({placeholders})"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CaptureOcrDto {
                    status: row.get(1)?,
                    text: row.get(2)?,
                    error: row.get(3)?,
                    updated_at: row.get(4)?,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(stmt);
    for (capture_id, ocr) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].ocr = Some(ocr);
        }
    }

    let mut stmt = conn
        .prepare(&format!(
            "SELECT cc.capture_id, co.id, co.name, co.normalized_name, co.slug,
                co.created_at, co.updated_at,
                (SELECT COUNT(*) FROM capture_contexts all_cc WHERE all_cc.context_id = co.id),
                cc.assignment_origin, cc.confidence, cc.created_at
         FROM capture_contexts cc
         JOIN contexts co ON co.id = cc.context_id
         WHERE cc.capture_id IN ({placeholders}) ORDER BY lower(co.name)"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(&args[..], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ContextAssignmentDto {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    normalized_name: row.get(3)?,
                    slug: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    capture_count: row.get(7)?,
                    assignment_origin: row.get(8)?,
                    confidence: row.get(9)?,
                    assigned_at: row.get(10)?,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for (capture_id, context) in rows {
        if let Some(index) = indexes.get(&capture_id) {
            captures[*index].contexts.push(context);
        }
    }
    Ok(())
}

fn get_capture_by_id(conn: &Connection, id: &str) -> Result<CaptureDto, String> {
    let capture = conn
        .query_row(
            "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         WHERE c.id = ?",
            [id],
            capture_base_from_row,
        )
        .map_err(err)?;
    let mut captures = vec![capture];
    hydrate_captures(conn, &mut captures)?;
    captures
        .pop()
        .ok_or_else(|| "Captura nao encontrada.".into())
}

fn context_ids_for_capture(conn: &Connection, capture_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT context_id FROM capture_contexts WHERE capture_id = ?")
        .map_err(err)?;
    let ids = stmt
        .query_map([capture_id], |row| row.get(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(ids)
}

fn assets_for_capture(conn: &Connection, capture_id: &str) -> Result<Vec<CaptureAssetDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, path, status, error, created_at
             FROM capture_assets
             WHERE capture_id = ?
             ORDER BY created_at",
        )
        .map_err(err)?;

    let assets = stmt
        .query_map([capture_id], |row| {
            Ok(CaptureAssetDto {
                id: row.get(0)?,
                kind: row.get(1)?,
                path: row.get(2)?,
                status: row.get(3)?,
                error: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(assets)
}

fn enqueue_ocr_job(conn: &Connection, capture_id: &str) -> Result<(), String> {
    let asset_id: Option<String> = conn
        .query_row(
            "SELECT id FROM capture_assets
             WHERE capture_id = ? AND kind IN ('clipboard_image', 'imported_image', 'screenshot') AND status = 'saved'
             ORDER BY CASE kind WHEN 'clipboard_image' THEN 0 WHEN 'imported_image' THEN 1 ELSE 2 END, created_at
             LIMIT 1",
            [capture_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;

    let Some(asset_id) = asset_id else {
        return Ok(());
    };
    conn.execute(
        "INSERT OR IGNORE INTO ocr_jobs (capture_id, asset_id, status, queued_at)
         VALUES (?, ?, 'queued', ?)",
        params![capture_id, asset_id, now()],
    )
    .map_err(err)?;
    Ok(())
}

fn enqueue_pending_ocr_jobs(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT id FROM captures").map_err(err)?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for id in ids {
        enqueue_ocr_job(conn, &id)?;
    }
    Ok(())
}

fn kick_ocr_worker(app: AppHandle, state: AppState) {
    let Ok(mut running) = state.ocr_worker_running.lock() else {
        return;
    };
    if *running {
        return;
    }
    *running = true;
    drop(running);

    thread::spawn(move || {
        loop {
            let next = open_conn(&state).and_then(|mut conn| claim_next_ocr_job(&mut conn));
            let Some((capture_id, path)) = (match next {
                Ok(job) => job,
                Err(error) => {
                    eprintln!("Falha ao obter trabalho de OCR: {error}");
                    None
                }
            }) else {
                break;
            };

            let result = run_local_ocr(Path::new(&path));
            if let Ok(mut conn) = open_conn(&state) {
                let _ = finish_ocr_job(&mut conn, &capture_id, result);
                if let Ok(capture) = get_capture_by_id(&conn, &capture_id) {
                    let _ = app.emit("capture-analysis-updated", CaptureUpdatedEvent { capture });
                }
            }
        }

        if let Ok(mut running) = state.ocr_worker_running.lock() {
            *running = false;
        }
    });
}

fn claim_next_ocr_job(conn: &mut Connection) -> Result<Option<(String, String)>, String> {
    let transaction = conn.transaction().map_err(err)?;
    let job: Option<(String, String)> = transaction
        .query_row(
            "SELECT j.capture_id, a.path
             FROM ocr_jobs j JOIN capture_assets a ON a.id = j.asset_id
             WHERE j.status = 'queued' AND a.path IS NOT NULL
             ORDER BY j.queued_at
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((capture_id, path)) = job {
        transaction.execute(
            "UPDATE ocr_jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE capture_id = ?",
            params![now(), capture_id],
        )
        .map_err(err)?;
        transaction.execute(
            "UPDATE capture_ocr SET status = 'running', error = NULL, updated_at = ? WHERE capture_id = ?",
            params![now(), capture_id],
        )
        .map_err(err)?;
        transaction.commit().map_err(err)?;
        Ok(Some((capture_id, path)))
    } else {
        transaction.commit().map_err(err)?;
        Ok(None)
    }
}

fn finish_ocr_job(
    conn: &mut Connection,
    capture_id: &str,
    result: Result<String, String>,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(err)?;
    let timestamp = now();
    match result {
        Ok(text) => {
            transaction.execute(
                "UPDATE ocr_jobs SET status = 'done', completed_at = ?, error = NULL WHERE capture_id = ?",
                params![timestamp, capture_id],
            ).map_err(err)?;
            transaction.execute(
                "UPDATE capture_ocr SET status = 'done', text = ?, error = NULL, updated_at = ? WHERE capture_id = ?",
                params![text, timestamp, capture_id],
            ).map_err(err)?;
            index_ocr_text(&transaction, capture_id, &text)?;
        }
        Err(error) => {
            transaction.execute(
                "UPDATE ocr_jobs SET status = 'failed', completed_at = ?, error = ? WHERE capture_id = ?",
                params![timestamp, error, capture_id],
            ).map_err(err)?;
            transaction.execute(
                "UPDATE capture_ocr SET status = 'failed', error = ?, updated_at = ? WHERE capture_id = ?",
                params![error, timestamp, capture_id],
            ).map_err(err)?;
        }
    }
    transaction.commit().map_err(err)
}

fn index_ocr_text(conn: &Connection, capture_id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let mut tags = Vec::new();
    let mut entities = Vec::new();
    let mut seen = std::collections::HashSet::new();
    extract_regex_entities(text, &mut tags, &mut entities, &mut seen);
    for tag in tags {
        conn.execute(
            "INSERT OR IGNORE INTO capture_tags (capture_id, tag, source, created_at) VALUES (?, ?, 'ocr-local', ?)",
            params![capture_id, tag, now()],
        ).map_err(err)?;
    }
    for entity in entities {
        conn.execute(
            "INSERT INTO capture_entities (id, capture_id, kind, value, source, confidence, created_at)
             SELECT ?, ?, ?, ?, 'ocr-local', ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM capture_entities WHERE capture_id = ? AND kind = ? AND value = ?)",
            params![Uuid::new_v4().to_string(), capture_id, entity.kind, entity.value, entity.confidence, now(), capture_id, entity.kind, entity.value],
        ).map_err(err)?;
    }
    Ok(())
}

fn analyze_context_suggestions(
    conn: &Connection,
    state: &AppState,
    request: CategorizeRequest,
) -> Result<ContextAnalysisResult, String> {
    let days = request.days.unwrap_or(30).clamp(1, 3650);
    let threshold = (Utc::now() - chrono::TimeDelta::days(days)).to_rfc3339();
    let captures = captures_since(conn, &threshold)?;
    let contexts = list_context_rows(conn)?;
    let existing_by_name = contexts
        .iter()
        .map(|context| (context.normalized_name.clone(), context.id.clone()))
        .collect::<HashMap<_, _>>();
    let mut groups: HashMap<String, (String, Vec<String>, String)> = HashMap::new();

    for capture in &captures {
        for (anchor, preferred_name, reason) in context_anchors_for_capture(capture) {
            let entry = groups
                .entry(anchor)
                .or_insert((preferred_name, Vec::new(), reason));
            entry.1.push(capture.id.clone());
        }
    }

    let mut suggestions = groups
        .into_iter()
        .filter_map(|(anchor, (name, mut capture_ids, reason))| {
            capture_ids.sort();
            capture_ids.dedup();
            if capture_ids.len() < 2 {
                return None;
            }
            let normalized = normalize_text(&name);
            Some(ContextSuggestion {
                id: format!("local:{}", sha256_hex(anchor.as_bytes())),
                name,
                existing_context_id: existing_by_name.get(&normalized).cloned(),
                capture_ids,
                reason,
                confidence: 0.9,
                source: "local".into(),
            })
        })
        .collect::<Vec<_>>();

    let mut ai_message = None;
    if request.include_ai.unwrap_or(false) {
        let settings = settings_with_ai_secret(conn, state)?;
        if settings.ai_api_key.trim().is_empty() {
            ai_message = Some(AppNotice::new("ai.key_missing_local_only"));
        } else {
            match call_ai_for_context_suggestions(&settings, &captures) {
                Ok(response) => {
                    for item in parse_ai_context_suggestions(&response) {
                        let mut capture_ids = item
                            .capture_ids
                            .into_iter()
                            .filter(|id| captures.iter().any(|capture| &capture.id == id))
                            .collect::<Vec<_>>();
                        capture_ids.sort();
                        capture_ids.dedup();
                        if capture_ids.is_empty() {
                            continue;
                        }
                        let normalized = normalize_text(&item.name);
                        suggestions.push(ContextSuggestion {
                            id: format!("ai:{}", Uuid::new_v4()),
                            name: item.name,
                            existing_context_id: existing_by_name.get(&normalized).cloned(),
                            capture_ids,
                            reason: item.reason,
                            confidence: item.confidence.clamp(0.0, 1.0),
                            source: "ai".into(),
                        });
                    }
                }
                Err(error) => {
                    eprintln!(
                        "AI context analysis failed; local suggestions remain available: {error}"
                    );
                    ai_message = Some(AppNotice::new("ai.analysis_failed_local_fallback"));
                }
            }
        }
    }
    suggestions.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| a.name.cmp(&b.name))
    });
    let matched = suggestions
        .iter()
        .flat_map(|item| item.capture_ids.iter().cloned())
        .collect::<std::collections::HashSet<_>>();
    let unmatched_capture_ids = captures
        .iter()
        .filter(|capture| !matched.contains(&capture.id))
        .map(|capture| capture.id.clone())
        .collect();
    Ok(ContextAnalysisResult {
        scanned_count: captures.len(),
        contextualized_count: captures
            .iter()
            .filter(|capture| !capture.contexts.is_empty())
            .count(),
        suggestions,
        unmatched_capture_ids,
        ai_message,
    })
}

#[tauri::command]
fn apply_context_suggestions(
    state: State<AppState>,
    suggestions: Vec<ApplyContextSuggestion>,
) -> CommandResult<ApplyContextSuggestionsResult> {
    let mut conn = open_conn(&state)?;
    let transaction = conn.transaction().map_err(err)?;
    let mut contexts_created = 0;
    let mut associations_added = 0;
    let mut touched = Vec::new();
    for suggestion in suggestions {
        let _suggestion_id = suggestion.suggestion_id;
        let context_id = if let Some(id) = suggestion.existing_context_id {
            validate_user_context_exists(&transaction, &id)?;
            id
        } else {
            let name = normalized_context_name(&suggestion.name)?;
            let normalized_name = normalize_text(&name);
            if let Some(id) = transaction.query_row(
                "SELECT id FROM contexts WHERE normalized_name = ? AND id NOT IN ('inbox', 'content-base')",
                [&normalized_name], |row| row.get(0),
            ).optional().map_err(err)? { id } else {
                let id = Uuid::new_v4().to_string();
                let slug = unique_slug(&transaction, &slugify(&name), None)?;
                let timestamp = now();
                transaction.execute(
                    "INSERT INTO contexts (id, name, normalized_name, slug, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    params![id, name, normalized_name, slug, timestamp, timestamp],
                ).map_err(err)?;
                contexts_created += 1;
                id
            }
        };
        for capture_id in suggestion.capture_ids {
            validate_capture_exists(&transaction, &capture_id)?;
            associations_added += transaction
                .execute(
                    "INSERT OR IGNORE INTO capture_contexts
                 (capture_id, context_id, assignment_origin, confidence, created_at)
                 VALUES (?, ?, 'automatic', ?, ?)",
                    params![
                        capture_id,
                        context_id,
                        suggestion.confidence.clamp(0.0, 1.0),
                        now()
                    ],
                )
                .map_err(err)?;
        }
        touched.push(context_id);
    }
    transaction.commit().map_err(err)?;
    sync_contexts_best_effort(&state, &touched);
    Ok(ApplyContextSuggestionsResult {
        contexts_created,
        associations_added,
    })
}

fn list_context_rows(conn: &Connection) -> Result<Vec<ContextDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT co.id, co.name, co.normalized_name, co.slug, co.created_at, co.updated_at,
                COUNT(cc.capture_id) FROM contexts co
         LEFT JOIN capture_contexts cc ON cc.context_id = co.id
         WHERE co.id NOT IN ('inbox', 'content-base') GROUP BY co.id",
        )
        .map_err(err)?;
    let contexts = stmt
        .query_map([], |row| {
            Ok(ContextDto {
                id: row.get(0)?,
                name: row.get(1)?,
                normalized_name: row.get(2)?,
                slug: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                capture_count: row.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(contexts)
}

fn captures_since(conn: &Connection, threshold: &str) -> Result<Vec<CaptureDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content_text, c.captured_at, c.source_app_name, c.source_app_id,
                c.source_process_id, c.source_process_path, c.window_title, c.window_id,
                c.platform, c.metadata_json, c.capture_kind
         FROM captures c WHERE c.captured_at >= ? ORDER BY c.captured_at DESC LIMIT 500",
        )
        .map_err(err)?;
    let mut captures = stmt
        .query_map([threshold], capture_base_from_row)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;
    Ok(captures)
}

fn context_anchors_for_capture(capture: &CaptureDto) -> Vec<(String, String, String)> {
    let mut anchors = Vec::new();
    for entity in &capture.entities {
        if matches!(
            entity.kind.as_str(),
            "domain" | "url" | "path" | "hash" | "uuid" | "application_id"
        ) {
            let value = entity.value.trim();
            if !value.is_empty() {
                let name = if entity.kind == "url" {
                    domain_from_url(value).unwrap_or_else(|| shorten(value, 48))
                } else {
                    shorten(value, 48)
                };
                anchors.push((
                    format!("{}:{}", entity.kind, normalize_text(value)),
                    name,
                    format!("Repeated {}: {}", entity.kind, shorten(value, 80)),
                ));
            }
        }
    }
    if let Some(app_id) = capture
        .source_app_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        anchors.push((
            format!("app:{}", normalize_text(app_id)),
            capture
                .source_app_name
                .clone()
                .unwrap_or_else(|| shorten(app_id, 48)),
            "Same source application".into(),
        ));
    }
    if let Some(path) = capture
        .source_process_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        anchors.push((
            format!("process:{}", normalize_text(path)),
            capture
                .source_app_name
                .clone()
                .unwrap_or_else(|| shorten(path, 48)),
            "Same executable path".into(),
        ));
    }
    anchors
}

#[derive(Debug)]
struct AiContextSuggestion {
    name: String,
    capture_ids: Vec<String>,
    reason: String,
    confidence: f64,
}

fn call_ai_for_context_suggestions(
    settings: &SettingsDto,
    captures: &[CaptureDto],
) -> Result<String, String> {
    let rows = captures.iter().filter(|capture| capture.content_kind != "image").map(|capture| json!({
        "id": capture.id,
        "kind": capture.kind,
        "app": capture.source_app_name.as_deref().map(redact_sensitive_values),
        "window": capture.window_title.as_deref().map(redact_sensitive_values),
        "text": shorten(&redact_sensitive_values(&capture.content_text), 700),
        "entities": capture.entities.iter().map(|entity| redact_sensitive_values(&format!("{}:{}", entity.kind, entity.value))).collect::<Vec<_>>(),
        "contexts": context_names(capture).into_iter().map(|context| redact_sensitive_values(&context)).collect::<Vec<_>>(),
    })).collect::<Vec<_>>();
    let (system, prompt) = if settings.language == "pt-BR" {
        ("Você sugere associações a contextos no ScryPuppy. Responda apenas JSON e nunca invente IDs.",
         format!("Sugira contextos sem remover associações existentes. Uma captura pode aparecer em mais de uma sugestão. Retorne {{\"suggestions\":[{{\"name\":\"Contexto\",\"capture_ids\":[\"id\"],\"reason\":\"relação curta\",\"confidence\":0.0}}]}}. Imagens não foram incluídas. Dados: {}", Value::Array(rows)))
    } else {
        ("You suggest context associations in ScryPuppy. Respond with JSON only and never invent IDs.",
         format!("Suggest contexts without removing existing associations. A capture may appear in more than one suggestion. Return {{\"suggestions\":[{{\"name\":\"Context\",\"capture_ids\":[\"id\"],\"reason\":\"short relationship\",\"confidence\":0.0}}]}}. Images were not included. Data: {}", Value::Array(rows)))
    };
    call_ai_raw(settings, system, &prompt)
}

fn parse_ai_context_suggestions(response: &str) -> Vec<AiContextSuggestion> {
    let cleaned = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str::<Value>(cleaned)
        .ok()
        .and_then(|value| value.get("suggestions").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(AiContextSuggestion {
                name,
                capture_ids: item
                    .get("capture_ids")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect(),
                reason: item
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Semantic relationship")
                    .to_string(),
                confidence: item
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.7),
            })
        })
        .collect()
}

fn call_ai_raw(settings: &SettingsDto, system: &str, prompt: &str) -> Result<String, String> {
    // Final provider boundary: callers should pre-redact before truncation, and this
    // second pass prevents a complete recognized credential from leaving the device.
    let safe_system = redact_sensitive_values(system);
    let safe_prompt = redact_sensitive_values(prompt);
    ai::call_provider(
        &settings.ai_provider,
        &settings.ai_api_key,
        &settings.ai_model,
        &safe_system,
        &safe_prompt,
    )
}

fn shorten(value: &str, limit: usize) -> String {
    let mut result = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

#[cfg(target_os = "windows")]
fn run_local_ocr(path: &Path) -> Result<String, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::{
        core::HSTRING,
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::{FileAccessMode, StorageFile},
    };
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.display().to_string()))
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let max_dimension = OcrEngine::MaxImageDimension().map_err(|error| error.to_string())?;
    if bitmap.PixelWidth().map_err(|error| error.to_string())? as u32 > max_dimension
        || bitmap.PixelHeight().map_err(|error| error.to_string())? as u32 > max_dimension
    {
        return Err(format!(
            "Imagem acima do limite local de OCR ({max_dimension}px)."
        ));
    }
    let engine =
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|error| error.to_string())?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    Ok(result
        .Text()
        .map_err(|error| error.to_string())?
        .to_string())
}

#[cfg(not(target_os = "windows"))]
fn run_local_ocr(_path: &Path) -> Result<String, String> {
    Err("OCR local está disponível nesta versão para Windows.".into())
}

fn collect_active_window() -> ActiveWindowMetadata {
    match get_active_window() {
        Ok(window) => ActiveWindowMetadata {
            title: non_empty(window.title),
            process_path: non_empty(window.process_path.display().to_string()),
            app_name: non_empty(window.app_name),
            window_id: non_empty(window.window_id),
            process_id: Some(window.process_id),
            position: Some(json!({
                "x": window.position.x,
                "y": window.position.y,
                "width": window.position.width,
                "height": window.position.height,
            })),
            error: None,
        },
        Err(_) => ActiveWindowMetadata {
            title: None,
            process_path: None,
            app_name: None,
            window_id: None,
            process_id: None,
            position: None,
            error: Some("Nao foi possivel identificar a janela ativa.".into()),
        },
    }
}

fn simulate_copy() -> Result<(), String> {
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    release_hotkey_modifiers(&mut enigo)?;
    thread::sleep(Duration::from_millis(120));
    enigo
        .key(modifier, Press)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Unicode('c'), Click)
        .map_err(|error| error.to_string())?;
    enigo
        .key(modifier, Release)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn simulate_paste() -> Result<(), String> {
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    release_hotkey_modifiers(&mut enigo)?;
    enigo
        .key(modifier, Press)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Unicode('v'), Click)
        .map_err(|error| error.to_string())?;
    enigo
        .key(modifier, Release)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn release_hotkey_modifiers(enigo: &mut Enigo) -> Result<(), String> {
    for key in [
        Key::Shift,
        Key::LShift,
        Key::RShift,
        Key::Control,
        Key::LControl,
        Key::RControl,
        Key::Meta,
    ] {
        let _ = enigo.key(key, Release);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enigo.key(Key::Alt, Release);
    }

    Ok(())
}

fn write_clipboard_text(state: &AppState, text: &str) -> Result<(), String> {
    let result = state.clipboard.write(ClipboardSnapshot::text(text));
    if result.is_ok() {
        mark_current_clipboard_sequence(state);
    }
    result
}

fn cleanup_clipboard_vault(state: &AppState) -> Result<(), String> {
    let root = state.clipboard_files_dir();
    fs::create_dir_all(&root).map_err(err)?;
    let conn = open_conn(state)?;
    let mut statement = conn.prepare("SELECT id FROM captures").map_err(err)?;
    let valid_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(err)?;
    for entry in fs::read_dir(&root).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if !path.is_dir() {
            if path.extension().and_then(|value| value.to_str()) == Some("part") {
                let _ = secure_remove_file(&path);
            }
            continue;
        }
        let capture_id = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !valid_ids.contains(capture_id) {
            let _ = secure_remove_dir(&path);
            continue;
        }
        for child in fs::read_dir(&path).map_err(err)? {
            let child = child.map_err(err)?.path();
            if child.extension().and_then(|value| value.to_str()) == Some("part") {
                let _ = secure_remove_file(&child);
            }
        }
    }
    Ok(())
}

fn write_clipboard_payload(state: &AppState, payload: &ClipboardPayload) -> Result<(), String> {
    let result = state.clipboard.write(payload.clone());
    if result.is_ok() {
        mark_current_clipboard_sequence(state);
    }
    result
}

fn read_clipboard_payload(state: &AppState) -> Result<Option<ClipboardPayload>, String> {
    for _ in 0..6 {
        if let Some(payload) = state.clipboard.read()? {
            return Ok(Some(payload));
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(None)
}

fn is_internal_clipboard_marker(text: &str) -> bool {
    text.starts_with("__CLIPSCRY_COPY_MARKER_")
}

fn read_clipboard_after_copy(state: &AppState, marker: &str) -> Result<ClipboardPayload, String> {
    for _ in 0..6 {
        thread::sleep(Duration::from_millis(50));
        if let Some(payload) = state.clipboard.read()? {
            if payload.plain_text() == Some(marker) && payload.representations.len() == 1 {
                continue;
            }
            return Ok(payload);
        }
    }

    Err("The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again.".into())
}

fn mark_current_clipboard_sequence(state: &AppState) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if sequence != 0 {
            state.ignore_clipboard_sequence(sequence);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = state;
}

fn insert_screenshot_asset(
    conn: &Connection,
    state: &AppState,
    capture_id: &str,
    active_window: &ActiveWindowMetadata,
) -> Result<(), String> {
    fs::create_dir_all(state.screenshots_dir()).map_err(err)?;
    let asset_id = Uuid::new_v4().to_string();
    let created_at = now();
    let mut path = None;
    let mut status = "unavailable".to_string();
    let mut error_message = None;

    match capture_active_window_image(state, capture_id, active_window) {
        Ok(saved_path) => {
            path = Some(saved_path.display().to_string());
            status = "saved".into();
        }
        Err(error) => {
            error_message = Some(error);
        }
    }

    conn.execute(
        "INSERT INTO capture_assets (id, capture_id, kind, path, status, error, created_at)
         VALUES (?, ?, 'screenshot', ?, ?, ?, ?)",
        params![
            asset_id,
            capture_id,
            path,
            status,
            error_message,
            created_at
        ],
    )
    .map_err(err)?;
    Ok(())
}

fn insert_clipboard_image_asset(
    conn: &Connection,
    state: &AppState,
    capture_id: &str,
    image: &ImageData<'static>,
) -> Result<(), String> {
    fs::create_dir_all(state.clipboard_images_dir()).map_err(err)?;
    let asset_id = Uuid::new_v4().to_string();
    let created_at = now();
    let path = state
        .clipboard_images_dir()
        .join(format!("{capture_id}.png"));

    save_clipboard_image(image, &path)?;

    conn.execute(
        "INSERT INTO capture_assets (id, capture_id, kind, path, status, error, created_at)
         VALUES (?, ?, 'clipboard_image', ?, 'saved', NULL, ?)",
        params![asset_id, capture_id, path.display().to_string(), created_at],
    )
    .map_err(err)?;
    Ok(())
}

fn persist_clipboard_representations(
    conn: &Connection,
    state: &AppState,
    capture_id: &str,
    snapshot: &ClipboardSnapshot,
    created_at: &str,
) -> Result<(), String> {
    for format in &snapshot.formats {
        conn.execute(
            "INSERT INTO capture_clipboard_formats
                (capture_id, format_id, format_name, supported) VALUES (?, ?, ?, ?)",
            params![
                capture_id,
                format.id as i64,
                format.name,
                format.supported as i64
            ],
        )
        .map_err(err)?;
    }

    for (ordinal, representation) in snapshot.representations.iter().enumerate() {
        let representation_id = Uuid::new_v4().to_string();
        let (
            kind,
            format_name,
            mime_type,
            text_content,
            asset_path,
            size_bytes,
            hash,
            restorable,
            metadata,
        ) = match representation {
            ClipboardRepresentation::PlainText(value) => (
                "plain_text",
                "CF_UNICODETEXT",
                Some("text/plain"),
                Some(value.clone()),
                None,
                Some(value.len() as i64),
                Some(sha256_hex(value.as_bytes())),
                true,
                json!({}),
            ),
            ClipboardRepresentation::Html(value) => (
                "html",
                "HTML Format",
                Some("text/html"),
                Some(value.clone()),
                None,
                Some(value.len() as i64),
                Some(sha256_hex(value.as_bytes())),
                true,
                json!({ "sanitization": "required_before_render" }),
            ),
            ClipboardRepresentation::RichText(value) => (
                "rich_text",
                "Rich Text Format",
                Some("text/rtf"),
                Some(value.clone()),
                None,
                Some(value.len() as i64),
                Some(sha256_hex(value.as_bytes())),
                true,
                json!({}),
            ),
            ClipboardRepresentation::Url(value) => (
                "url",
                "UniformResourceLocatorW",
                Some("text/uri-list"),
                Some(value.clone()),
                None,
                Some(value.len() as i64),
                Some(sha256_hex(value.as_bytes())),
                true,
                json!({}),
            ),
            ClipboardRepresentation::Image(image) => {
                let path = state
                    .clipboard_images_dir()
                    .join(format!("{capture_id}.png"));
                (
                    "image",
                    "CF_DIBV5",
                    Some("image/png"),
                    None,
                    Some(path.display().to_string()),
                    Some(image.rgba.len() as i64),
                    Some(sha256_hex(&image.rgba)),
                    true,
                    json!({ "width": image.width, "height": image.height }),
                )
            }
            ClipboardRepresentation::Files(files) => (
                "files",
                if files.iter().any(|file| file.bytes.is_some()) {
                    "FileGroupDescriptorW"
                } else {
                    "CF_HDROP"
                },
                Some("application/x-scrypuppy-file-list"),
                None,
                None,
                Some(
                    files
                        .iter()
                        .filter_map(|file| file.size_bytes)
                        .fold(0u64, u64::saturating_add)
                        .min(i64::MAX as u64) as i64,
                ),
                None,
                files.iter().any(|file| {
                    file.original_path.is_some()
                        || file.bytes.is_some()
                        || file.kind == ClipboardFileKind::Directory
                }),
                json!({ "item_count": files.len() }),
            ),
        };
        conn.execute(
            "INSERT INTO capture_representations
                (id, capture_id, ordinal, kind, format_name, mime_type, text_content,
                 asset_path, size_bytes, sha256, restorable, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                representation_id,
                capture_id,
                ordinal as i64,
                kind,
                format_name,
                mime_type,
                text_content,
                asset_path,
                size_bytes,
                hash,
                restorable as i64,
                metadata.to_string(),
                created_at,
            ],
        )
        .map_err(err)?;

        if let ClipboardRepresentation::Files(files) = representation {
            persist_file_entries(
                conn,
                state,
                capture_id,
                &representation_id,
                files,
                created_at,
            )?;
        }
    }
    Ok(())
}

fn persist_file_entries(
    conn: &Connection,
    state: &AppState,
    capture_id: &str,
    representation_id: &str,
    files: &[ClipboardFile],
    created_at: &str,
) -> Result<(), String> {
    let root = state.clipboard_files_dir().join(capture_id);
    for (ordinal, file) in files.iter().enumerate() {
        let mut local_path = None;
        let mut availability = file.availability.clone();
        let mut hash = None;
        if file.original_path.is_none() {
            let path = root.join(format!(
                "{:04}-{}",
                ordinal,
                clipboard::sanitize_file_name(&file.display_name)
            ));
            if file.kind == ClipboardFileKind::Directory {
                fs::create_dir_all(&path).map_err(err)?;
                local_path = Some(path.display().to_string());
                availability = ClipboardFileAvailability::Available;
            } else if let Some(bytes) = &file.bytes {
                fs::create_dir_all(&root).map_err(err)?;
                let temporary = root.join(format!(".{}.{}.part", ordinal, Uuid::new_v4()));
                let mut output = File::create(&temporary).map_err(err)?;
                output.write_all(bytes).map_err(err)?;
                output.sync_all().map_err(err)?;
                fs::rename(&temporary, &path).map_err(err)?;
                local_path = Some(path.display().to_string());
                availability = ClipboardFileAvailability::Available;
                hash = Some(sha256_hex(bytes));
            }
        }
        let extension = Path::new(&file.display_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        conn.execute(
            "INSERT INTO capture_file_entries
                (id, capture_id, representation_id, ordinal, display_name, original_path,
                 local_path, entry_kind, extension, size_bytes, sha256, availability,
                 metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)",
            params![
                Uuid::new_v4().to_string(),
                capture_id,
                representation_id,
                ordinal as i64,
                file.display_name,
                file.original_path
                    .as_ref()
                    .map(|path| path.display().to_string()),
                local_path,
                file.kind.as_str(),
                extension,
                file.size_bytes
                    .map(|value| value.min(i64::MAX as u64) as i64),
                hash,
                availability.as_str(),
                created_at,
            ],
        )
        .map_err(err)?;
    }
    Ok(())
}

fn save_clipboard_image(image: &ImageData<'static>, path: &Path) -> Result<(), String> {
    let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.clone().into_owned(),
    )
    .ok_or_else(|| "Dados de imagem do clipboard invalidos.".to_string())?;

    buffer.save(path).map_err(|error| error.to_string())
}

fn capture_active_window_image(
    state: &AppState,
    capture_id: &str,
    active_window: &ActiveWindowMetadata,
) -> Result<PathBuf, String> {
    let windows = xcap::Window::all().map_err(|error| error.to_string())?;
    let active_pid = active_window.process_id.map(|pid| pid as u32);
    let active_title = active_window.title.as_deref().unwrap_or_default();
    let active_app = active_window.app_name.as_deref().unwrap_or_default();

    let window = windows
        .into_iter()
        .filter_map(|window| {
            let pid_matches = active_pid
                .and_then(|pid| window.pid().ok().map(|window_pid| window_pid == pid))
                .unwrap_or(false);
            let title_matches = window
                .title()
                .ok()
                .map(|title| {
                    !active_title.trim().is_empty()
                        && normalize_window_label(&title) == normalize_window_label(active_title)
                })
                .unwrap_or(false);
            let app_matches = window
                .app_name()
                .ok()
                .map(|app_name| {
                    !active_app.trim().is_empty()
                        && normalize_window_label(&app_name) == normalize_window_label(active_app)
                })
                .unwrap_or(false);
            let width = window.width().ok().unwrap_or_default() as u64;
            let height = window.height().ok().unwrap_or_default() as u64;
            let area = width.saturating_mul(height);

            // Explorer hosts the taskbar and File Explorer windows in the same
            // process. The PID alone is therefore not a sufficient identity.
            let score = if pid_matches && title_matches {
                400
            } else if title_matches && app_matches {
                300
            } else if pid_matches && app_matches && area > 20_000 {
                100
            } else if pid_matches && area > 20_000 {
                50
            } else {
                0
            };

            (score > 0).then_some((score, area, window))
        })
        .max_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)))
        .map(|(_, _, window)| window)
        .ok_or_else(|| "Janela ativa nao encontrada para screenshot.".to_string())?;

    if window.is_minimized().unwrap_or(false) {
        return Err("Janela ativa minimizada; screenshot nao capturado.".into());
    }

    let image = window.capture_image().map_err(|error| error.to_string())?;
    let path = state.screenshots_dir().join(format!("{capture_id}.png"));
    image.save(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn normalize_window_label(value: &str) -> String {
    value.trim().to_lowercase()
}

fn metadata_json(
    text: &str,
    window: &ActiveWindowMetadata,
    image_dimensions: Option<(usize, usize)>,
    origin: CaptureOrigin,
) -> Value {
    let mut detected = HashMap::new();
    if text.starts_with("http://") || text.starts_with("https://") {
        detected.insert("url", text.trim().to_string());
    }
    if Path::new(text.trim()).is_absolute() {
        detected.insert("path", text.trim().to_string());
    }

    json!({
        "active_window": window,
        "detected": detected,
        "clipboard_image": image_dimensions.map(|(width, height)| json!({
            "width": width,
            "height": height,
        })),
        "capture_origin": origin,
        "text_length": text.chars().count(),
    })
}

fn settings_from_conn(conn: &Connection, state: &AppState) -> Result<SettingsDto, String> {
    let capture_screenshots = get_setting(conn, "capture_screenshots")?
        .map(|value| value == "true")
        .unwrap_or(true);
    let provider = get_setting(conn, "ai_provider")?.unwrap_or_else(|| "deepseek".into());
    let model =
        get_setting(conn, "ai_model")?.unwrap_or_else(|| default_model_for_provider(&provider));
    let launch_at_startup = get_setting(conn, "launch_at_startup")?
        .map(|value| value == "true")
        .unwrap_or(false);
    let language = get_setting(conn, "language")?
        .filter(|value| value == "pt-BR")
        .unwrap_or_else(|| "en".into());
    let setting_bool = |key: &str, default: bool| -> Result<bool, String> {
        Ok(get_setting(conn, key)?
            .map(|value| value == "true")
            .unwrap_or(default))
    };

    Ok(SettingsDto {
        capture_screenshots,
        launch_at_startup,
        language,
        hotkey: HOTKEY.into(),
        reference_hotkey: REFERENCE_HOTKEY.into(),
        paste_hotkey: PASTE_HOTKEY.into(),
        data_dir: state.app_dir.display().to_string(),
        ai_provider: provider,
        ai_model: model,
        ai_api_key: String::new(),
        // Settings must remain readable even when the optional AI credential
        // cannot be queried from Credential Manager. A missing AI credential
        // should never disable the rest of the Settings screen.
        ai_api_key_configured: get_credential(AI_KEY_CREDENTIAL).ok().flatten().is_some(),
        quick_context_enabled: setting_bool("quick_context_enabled", true)?,
        quick_context_after_reference: setting_bool("quick_context_after_reference", false)?,
        quick_context_timeout_seconds: get_setting(conn, "quick_context_timeout_seconds")?
            .and_then(|value| value.parse().ok())
            .filter(|value| [0, 3, 5, 8, 15].contains(value))
            .unwrap_or(8),
        quick_context_show_preview: setting_bool("quick_context_show_preview", true)?,
        quick_context_show_recent: setting_bool("quick_context_show_recent", true)?,
        onboarding_completed: setting_bool("onboarding_completed", false)?
            && get_setting(conn, "onboarding_completed_version")?.as_deref() == Some(APP_VERSION),
        clipboard_monitor_enabled: setting_bool("clipboard_monitor_enabled", false)?,
        clipboard_monitor_capture_screenshots: setting_bool(
            "clipboard_monitor_capture_screenshots",
            false,
        )?,
        clipboard_monitor_quick_context_enabled: setting_bool(
            "clipboard_monitor_quick_context_enabled",
            false,
        )?,
    })
}

fn settings_with_ai_secret(conn: &Connection, state: &AppState) -> Result<SettingsDto, String> {
    let mut settings = settings_from_conn(conn, state)?;
    settings.ai_api_key = get_credential(AI_KEY_CREDENTIAL)?.unwrap_or_default();
    Ok(settings)
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(err)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(err)?;
    Ok(())
}

fn ai_provider_options() -> Vec<AiProviderOption> {
    ai::provider_options()
}

fn default_model_for_provider(provider: &str) -> String {
    ai::default_model(provider)
}

fn sync_markdown(state: &AppState) -> std::io::Result<()> {
    let conn = open_conn(state).map_err(io_other)?;
    fs::create_dir_all(state.markdown_dir())?;

    for entry in fs::read_dir(state.markdown_dir())? {
        let entry = entry?;
        if matches!(
            entry.path().extension().and_then(|ext| ext.to_str()),
            Some("md") | Some("scryppy")
        ) {
            secure_remove_file(&entry.path()).map_err(io_other)?;
        }
    }

    let contexts = list_contexts_for_markdown(&conn).map_err(io_other)?;
    for context in contexts {
        write_context_export(state, &conn, &context)?;
    }

    Ok(())
}

fn sync_contexts(state: &AppState, context_ids: &[String]) -> std::io::Result<()> {
    if context_ids.is_empty() {
        return Ok(());
    }
    let conn = open_conn(state).map_err(io_other)?;
    fs::create_dir_all(state.markdown_dir())?;
    let contexts = list_contexts_for_markdown(&conn).map_err(io_other)?;
    for context in contexts
        .iter()
        .filter(|context| context_ids.iter().any(|id| id == &context.id))
    {
        write_context_export(state, &conn, context)?;
    }
    Ok(())
}

fn sync_contexts_best_effort(state: &AppState, context_ids: &[String]) {
    if let Err(error) = sync_contexts(state, context_ids) {
        eprintln!("Falha ao sincronizar contextos alterados: {error}");
    }
}

fn recover_interrupted_ocr_jobs(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE ocr_jobs SET status = 'queued', started_at = NULL
         WHERE status = 'running'",
        [],
    )
    .map_err(err)?;
    conn.execute(
        "UPDATE capture_ocr SET status = 'queued', error = NULL, updated_at = ?
         WHERE status = 'running'",
        [now()],
    )
    .map_err(err)?;
    Ok(())
}

fn write_context_export(
    state: &AppState,
    conn: &Connection,
    context: &ContextDto,
) -> std::io::Result<()> {
    let captures = captures_for_context(conn, &context.id).map_err(io_other)?;
    let markdown = render_context_markdown(context, &captures);
    let encrypted = encrypt_context_file(&markdown, &state.context_key).map_err(io_other)?;
    let path = state
        .markdown_dir()
        .join(format!("{}.scryppy", context.slug));
    let temporary = state
        .markdown_dir()
        .join(format!(".{}.{}.tmp", context.slug, Uuid::new_v4()));
    fs::write(&temporary, encrypted)?;
    if path.exists() {
        secure_remove_file(&path).map_err(io_other)?;
    }
    fs::rename(temporary, path)
}

fn remove_context_export(state: &AppState, slug: &str) -> Result<(), String> {
    secure_remove_file(&state.markdown_dir().join(format!("{slug}.scryppy")))
}

fn remove_context_export_best_effort(state: &AppState, slug: &str) {
    if let Err(error) = remove_context_export(state, slug) {
        eprintln!("Falha ao remover exportacao de contexto: {error}");
    }
}

fn list_contexts_for_markdown(conn: &Connection) -> rusqlite::Result<Vec<ContextDto>> {
    let mut stmt = conn.prepare(
        "SELECT co.id, co.name, co.normalized_name, co.slug, co.created_at, co.updated_at,
                COUNT(cc.capture_id) AS capture_count
         FROM contexts co
         LEFT JOIN capture_contexts cc ON cc.context_id = co.id
         WHERE co.id NOT IN ('inbox', 'content-base')
         GROUP BY co.id
         ORDER BY lower(co.name)",
    )?;

    let contexts = stmt
        .query_map([], |row| {
            Ok(ContextDto {
                id: row.get(0)?,
                name: row.get(1)?,
                normalized_name: row.get(2)?,
                slug: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                capture_count: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(contexts)
}

fn captures_for_context(conn: &Connection, context_id: &str) -> Result<Vec<CaptureDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content_text, c.captured_at,
                c.source_app_name, c.source_app_id, c.source_process_id,
                c.source_process_path, c.window_title, c.window_id, c.platform,
                c.metadata_json, c.capture_kind
         FROM captures c
         JOIN capture_contexts cc ON cc.capture_id = c.id
         WHERE cc.context_id = ?
         ORDER BY c.captured_at DESC",
        )
        .map_err(err)?;

    let mut captures = stmt
        .query_map([context_id], capture_base_from_row)
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    hydrate_captures(conn, &mut captures)?;
    Ok(captures)
}

fn render_context_markdown(context: &ContextDto, captures: &[CaptureDto]) -> String {
    let mut markdown = String::new();
    markdown.push_str(
        "<!-- Generated by ScryPuppy. Do not edit manually; changes can be overwritten. -->\n\n",
    );
    markdown.push_str(&format!("# {}\n\n", context.name));
    markdown.push_str(&format!("- Context ID: `{}`\n", context.id));
    markdown.push_str(&format!("- Captures: `{}`\n\n", captures.len()));

    for capture in captures {
        markdown.push_str("---\n\n");
        markdown.push_str(&format!("## {}\n\n", capture.captured_at));
        markdown.push_str(&format!("- Capture ID: `{}`\n", capture.id));
        markdown.push_str(&format!("- Type: `{}`\n", capture.kind));
        if !capture.contexts.is_empty() {
            markdown.push_str(&format!(
                "- Contexts: `{}`\n",
                capture
                    .contexts
                    .iter()
                    .map(|context| context.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        markdown.push_str(&format!(
            "- Application: `{}`\n",
            optional_md(&capture.source_app_name)
        ));
        markdown.push_str(&format!(
            "- Application ID: `{}`\n",
            optional_md(&capture.source_app_id)
        ));
        markdown.push_str(&format!(
            "- Process ID: `{}`\n",
            capture
                .source_process_id
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".into())
        ));
        markdown.push_str(&format!(
            "- Process Path: `{}`\n",
            optional_md(&capture.source_process_path)
        ));
        markdown.push_str(&format!(
            "- Window Title: `{}`\n",
            optional_md(&capture.window_title)
        ));
        markdown.push_str(&format!(
            "- Window ID: `{}`\n",
            optional_md(&capture.window_id)
        ));
        markdown.push_str(&format!("- Platform: `{}`\n", capture.platform));

        for asset in &capture.assets {
            markdown.push_str(&format!(
                "- Asset {}: status `{}`, path `{}`{}\n",
                asset.kind,
                asset.status,
                optional_md(&asset.path),
                asset
                    .error
                    .as_ref()
                    .map(|error| format!(", error `{}`", escape_ticks(error)))
                    .unwrap_or_default()
            ));
        }

        if !capture.tags.is_empty() {
            markdown.push_str(&format!("- Tags: `{}`\n", capture.tags.join("`, `")));
        }

        if let Some(ocr) = &capture.ocr {
            markdown.push_str(&format!("- OCR local: `{}`", ocr.status));
            if let Some(error) = &ocr.error {
                markdown.push_str(&format!(" ({})", escape_ticks(error)));
            }
            markdown.push('\n');
        }

        markdown.push_str("\n```text\n");
        markdown.push_str(&capture.content_text);
        if !capture.content_text.ends_with('\n') {
            markdown.push('\n');
        }
        markdown.push_str("```\n\n");
        markdown.push_str("<details>\n<summary>Metadata JSON</summary>\n\n```json\n");
        markdown.push_str(
            &serde_json::to_string_pretty(&capture.metadata).unwrap_or_else(|_| "{}".into()),
        );
        markdown.push_str("\n```\n</details>\n\n");

        if !capture.entities.is_empty() {
            markdown.push_str("<details>\n<summary>Local Entities</summary>\n\n");
            for entity in &capture.entities {
                markdown.push_str(&format!(
                    "- `{}`: `{}` (source `{}`, confidence `{:.2}`)\n",
                    entity.kind,
                    escape_ticks(&entity.value),
                    entity.source,
                    entity.confidence
                ));
            }
            markdown.push_str("\n</details>\n\n");
        }
    }

    markdown
}

fn unique_slug(
    conn: &Connection,
    base_slug: &str,
    current_id: Option<&str>,
) -> Result<String, String> {
    let base_slug = if base_slug.is_empty() {
        "contexto"
    } else {
        base_slug
    };
    let mut candidate = base_slug.to_string();
    let mut suffix = 2;

    loop {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM contexts WHERE slug = ?",
                [&candidate],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;

        match (existing, current_id) {
            (None, _) => return Ok(candidate),
            (Some(existing_id), Some(id)) if existing_id == id => return Ok(candidate),
            _ => {
                candidate = format!("{base_slug}-{suffix}");
                suffix += 1;
            }
        }
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn normalized_context_name(name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Nome do contexto nao pode ser vazio.".into());
    }
    Ok(name)
}

#[cfg(test)]
fn content_hash(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn optional_md(value: &Option<String>) -> String {
    value
        .as_ref()
        .map(|value| escape_ticks(value))
        .unwrap_or_else(|| "unknown".into())
}

fn escape_ticks(value: &str) -> String {
    value.replace('`', "'")
}

fn now() -> String {
    let now: DateTime<Utc> = Utc::now();
    now.to_rfc3339()
}

fn err(error: impl ToString) -> String {
    error.to_string()
}

fn io_other(error: impl ToString) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            restore_main_window(app);
            process_import_args(app.clone(), args);
        }))
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_dir)?;
            let assets_dir = app_dir.join("assets");
            fs::create_dir_all(&assets_dir)?;
            app.asset_protocol_scope()
                .allow_directory(&assets_dir, true)?;
            let database_path = app_dir.join("scryppy.sqlite");
            let database_key = get_or_create_secret(
                DATABASE_KEY_CREDENTIAL,
                !database_path.exists()
                    || database_is_plaintext(&database_path).map_err(io_other)?,
            )
            .map_err(io_other)?;
            let context_key =
                get_or_create_secret(CONTEXT_KEY_CREDENTIAL, true).map_err(io_other)?;
            let clipboard = Arc::new(ClipboardService::start().map_err(io_other)?);
            let monitor_handle = ClipboardMonitorHandle::new();
            let state = AppState {
                app_dir,
                database_key,
                context_key,
                capture_gate: Arc::new(Mutex::new(CaptureGate { in_progress: false })),
                ignored_clipboard_sequences: Arc::new(Mutex::new(SequenceSuppression::default())),
                clipboard,
                clipboard_monitor: monitor_handle.clone(),
                ocr_worker_running: Arc::new(Mutex::new(false)),
                paste_target_window: Arc::new(Mutex::new(None)),
            };
            initialize_database(&state).map_err(io_other)?;
            cleanup_clipboard_vault(&state).map_err(io_other)?;
            app.manage(state.clone());

            #[cfg(target_os = "windows")]
            setup_windows_tray(app)?;

            // Commands can run as soon as the first webview is built. Register every
            // plugin state they access before creating any configured window.
            #[cfg(all(desktop, target_os = "windows"))]
            app.handle().plugin(
                tauri_plugin_autostart::Builder::new()
                    .app_name("ScryPuppy")
                    .build(),
            )?;

            for window_config in app.config().app.windows.clone() {
                WebviewWindowBuilder::from_config(app.handle(), &window_config)?.build()?;
            }

            let conn = open_conn(&state).map_err(io_other)?;
            backfill_local_analysis(&conn).map_err(io_other)?;
            recover_interrupted_ocr_jobs(&conn).map_err(io_other)?;
            enqueue_pending_ocr_jobs(&conn).map_err(io_other)?;
            sync_markdown(&state)?;
            clipboard_monitor::start(app.handle().clone(), state.clone(), monitor_handle);
            kick_ocr_worker(app.handle().clone(), state);

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                });
            }

            #[cfg(target_os = "windows")]
            if let Err(error) = register_windows_context_menu() {
                eprintln!("Nao foi possivel registrar o menu do Explorer: {error}");
            }

            process_import_args(app.handle().clone(), std::env::args().collect());

            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_shortcuts([HOTKEY, REFERENCE_HOTKEY, PASTE_HOTKEY, MAGIC_HOTKEY])?
                        .with_handler(|app, shortcut, event| {
                            if event.state == ShortcutState::Released {
                                let is_magic = shortcut
                                    .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyF);
                                if is_magic {
                                    if let Err(message) = show_magic_search(app, None, None) {
                                        let _ = app.emit(
                                            "capture-error",
                                            CaptureErrorEvent {
                                                error: AppError::from(message),
                                            },
                                        );
                                    }
                                    return;
                                }
                                let is_paste = shortcut
                                    .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyV);
                                if is_paste {
                                    let state = app.state::<AppState>();
                                    if let Err(message) = show_paste_palette(app, &state) {
                                        let _ = app.emit(
                                            "capture-error",
                                            CaptureErrorEvent {
                                                error: AppError::from(message),
                                            },
                                        );
                                    }
                                    return;
                                }
                                let is_reference = shortcut
                                    .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyS);
                                let app_handle = app.clone();
                                thread::spawn(move || {
                                    let state = app_handle.state::<AppState>().inner().clone();
                                    let (kind, context) = if is_reference {
                                        ("reference", CONTENT_BASE_CONTEXT_ID)
                                    } else {
                                        ("capture", INBOX_CONTEXT_ID)
                                    };
                                    if let Err(message) =
                                        run_capture_core(&app_handle, state, kind, context)
                                    {
                                        if message == DUPLICATE_CAPTURE_IGNORED {
                                            return;
                                        }
                                        let _ = app_handle.emit(
                                            "capture-error",
                                            CaptureErrorEvent {
                                                error: AppError::from(message),
                                            },
                                        );
                                    }
                                });
                            }
                        })
                        .build(),
                )?;
                let _ = app.global_shortcut().is_registered(HOTKEY);
                let _ = app.global_shortcut().is_registered(PASTE_HOTKEY);
                let _ = app.global_shortcut().is_registered(MAGIC_HOTKEY);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_capture,
            save_reference,
            copy_text_to_clipboard,
            copy_capture_to_clipboard,
            list_captures,
            list_capture_page,
            get_capture,
            delete_capture,
            list_contexts,
            get_library_counts,
            list_categories,
            analyze_contexts,
            apply_context_suggestions,
            create_context,
            rename_context,
            delete_context,
            add_capture_contexts,
            add_captures_to_context,
            remove_capture_context,
            list_recent_contexts,
            get_settings,
            update_settings,
            clear_ai_api_key,
            delete_all_data,
            get_ai_provider_options,
            ask_chat,
            get_tag_document,
            export_tag_document,
            generate_magic_search,
            preview_magic_search,
            list_magic_searches,
            get_magic_search,
            export_magic_search,
            update_magic_search_markdown,
            rename_magic_search,
            delete_magic_search,
            delete_old_magic_search_versions,
            add_magic_search_evidence,
            remove_magic_search_evidence,
            resync_markdown,
            paste_capture,
            close_paste_palette,
            close_quick_context,
            open_magic_search,
            close_magic_search,
            open_magic_document
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app_handle.state::<AppState>();
                state.clipboard_monitor.shutdown();
                state.clipboard.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_keeps_stable_ascii_slugs() {
        assert_eq!(slugify("Meu Contexto 01"), "meu-contexto-01");
        assert_eq!(slugify("  A/B/C  "), "a-b-c");
    }

    #[test]
    fn content_hash_changes_with_content() {
        assert_ne!(content_hash("abc"), content_hash("abcd"));
    }

    #[test]
    fn application_id_queries_are_detected_in_english_and_portuguese() {
        assert!(query_requests_application_id(
            "What is the applicationID of app X?"
        ));
        assert!(query_requests_application_id(
            "Qual é o identificador da aplicação X?"
        ));
        assert!(!query_requests_application_id(
            "Show me the most recent text from app X"
        ));
    }

    #[test]
    fn broad_collection_queries_work_in_english_and_portuguese() {
        for query in [
            "all",
            "show me everything I copied",
            "all my contexts",
            "tudo",
            "mostre tudo que copiei",
            "todas as capturas",
        ] {
            assert!(
                is_broad_collection_query(query),
                "expected a full-scope query: {query}"
            );
        }

        for query in ["all news", "everything about Rust", "tudo sobre o projeto"] {
            assert!(
                !is_broad_collection_query(query),
                "expected a subject query: {query}"
            );
        }
    }

    #[test]
    fn secret_redaction_map_restores_document_values_only_after_provider_output() {
        let text_secret = "sk-proj-1234567890abcdef";
        let ocr_secret = "ghp_12345678901234567890";
        let content = format!("Text credential: {text_secret}");
        let ocr = format!("OCR credential: {ocr_secret}");
        let map = SecretRedactionMap::from_texts([content.as_str(), ocr.as_str()]);
        let safe_prompt = map.redact(&format!("{content}\n{ocr}"));

        assert!(!safe_prompt.contains(text_secret));
        assert!(!safe_prompt.contains(ocr_secret));
        assert!(safe_prompt.contains("[SCRYPUPPY_SECRET_"));

        let restored = map.restore_document(&safe_prompt);
        assert!(restored.contains(text_secret));
        assert!(restored.contains(ocr_secret));

        let restored_legacy_mask = map.restore_document(&format!(
            "Credential returned as `{}`",
            mask_secret(text_secret)
        ));
        assert!(restored_legacy_mask.contains(text_secret));
    }

    #[test]
    fn direct_application_id_answer_uses_the_first_matching_source() {
        let evidence = vec![EvidenceItem {
            capture_id: "capture-1".into(),
            captured_at: now(),
            context_names: vec!["Work".into()],
            app_name: Some("App X".into()),
            application_id: Some("com.example.app-x".into()),
            window_title: Some("App X".into()),
            excerpt: "Copied value".into(),
            matched_fields: vec!["application_id".into()],
            asset_paths: Vec::new(),
        }];

        assert_eq!(
            direct_answer_from_evidence("application id of App X", &evidence),
            Some("com.example.app-x".into())
        );
        assert_eq!(direct_answer_from_evidence("copied value", &evidence), None);
    }

    #[test]
    fn context_files_do_not_contain_plaintext() {
        let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let markdown = "# Projeto confidencial\nToken super-secreto";
        let encrypted = encrypt_context_file(markdown, &key).expect("context should encrypt");

        assert!(encrypted.starts_with(crypto::CONTEXT_FILE_MAGIC));
        assert!(!encrypted
            .windows(markdown.len())
            .any(|window| window == markdown.as_bytes()));
    }

    #[test]
    fn sqlcipher_database_does_not_keep_sqlite_header() {
        let path =
            std::env::temp_dir().join(format!("scryppy-sqlcipher-{}.sqlite", Uuid::new_v4()));
        let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let conn = Connection::open(&path).expect("database should open");
        apply_database_key(&conn, &key).expect("key should apply");
        conn.execute("CREATE TABLE protected_data (value TEXT)", [])
            .expect("table should create");
        conn.execute(
            "INSERT INTO protected_data (value) VALUES ('confidencial')",
            [],
        )
        .expect("row should insert");
        drop(conn);

        assert!(!database_is_plaintext(&path).expect("header should read"));
        let encrypted = Connection::open(&path).expect("encrypted database should open");
        apply_database_key(&encrypted, &key).expect("key should reopen database");
        let value: String = encrypted
            .query_row("SELECT value FROM protected_data", [], |row| row.get(0))
            .expect("row should decrypt");
        assert_eq!(value, "confidencial");
        drop(encrypted);
        secure_remove_file(&path).expect("temporary database should be removed");
    }

    #[test]
    fn clipboard_monitor_defaults_are_opt_in() {
        assert!(!default_clipboard_monitor_enabled());
        assert!(!default_clipboard_monitor_capture_screenshots());
        assert!(!default_clipboard_monitor_quick_context_enabled());
    }

    #[test]
    fn settings_without_clipboard_monitor_keys_default_to_false() {
        let conn = Connection::open_in_memory().expect("database should open");
        migrate(&conn).expect("schema should migrate");
        conn.execute(
            "DELETE FROM settings WHERE key IN (
                'clipboard_monitor_enabled',
                'clipboard_monitor_capture_screenshots',
                'clipboard_monitor_quick_context_enabled'
            )",
            [],
        )
        .expect("settings should be removable for upgrade test");

        let settings = settings_from_conn(&conn, &test_state()).expect("settings should load");
        assert!(!settings.clipboard_monitor_enabled);
        assert!(!settings.clipboard_monitor_capture_screenshots);
        assert!(!settings.clipboard_monitor_quick_context_enabled);
    }

    #[test]
    fn clipboard_monitor_settings_round_trip() {
        let conn = Connection::open_in_memory().expect("database should open");
        migrate(&conn).expect("schema should migrate");
        let mut settings = test_settings();
        settings.clipboard_monitor_enabled = true;
        settings.clipboard_monitor_capture_screenshots = true;
        settings.clipboard_monitor_quick_context_enabled = true;
        persist_clipboard_monitor_settings(&conn, &settings).expect("settings should persist");

        let saved = settings_from_conn(&conn, &test_state()).expect("settings should load");
        assert!(saved.clipboard_monitor_enabled);
        assert!(saved.clipboard_monitor_capture_screenshots);
        assert!(saved.clipboard_monitor_quick_context_enabled);
    }

    #[test]
    fn sequence_suppression_is_consumed_once() {
        let mut suppression = SequenceSuppression::default();
        suppression.record(42);
        assert!(suppression.consume(42));
        assert!(!suppression.consume(42));
    }

    #[test]
    fn internal_marker_is_rejected_defensively() {
        assert!(is_internal_clipboard_marker("__CLIPSCRY_COPY_MARKER_abc__"));
        assert!(!is_internal_clipboard_marker("ordinary copied text"));
    }

    #[test]
    fn different_copies_are_not_duplicates() {
        let conn = duplicate_test_connection();
        insert_duplicate_test_capture(&conn, "first", &now(), CaptureOrigin::ClipboardMonitor);
        assert!(recent_duplicate_capture(
            &conn,
            &content_hash("second"),
            &test_window(),
            "second",
            INBOX_CONTEXT_ID,
            "capture",
            CaptureOrigin::ClipboardMonitor,
        )
        .expect("duplicate query should work")
        .is_none());
    }

    #[test]
    fn same_content_same_origin_is_duplicate_within_two_seconds() {
        let conn = duplicate_test_connection();
        insert_duplicate_test_capture(&conn, "same", &now(), CaptureOrigin::ClipboardMonitor);
        assert!(recent_duplicate_capture(
            &conn,
            &content_hash("same"),
            &test_window(),
            "same",
            INBOX_CONTEXT_ID,
            "capture",
            CaptureOrigin::ClipboardMonitor,
        )
        .expect("duplicate query should work")
        .is_some());
    }

    #[test]
    fn same_content_is_accepted_after_duplicate_window() {
        let conn = duplicate_test_connection();
        let old = (Utc::now() - chrono::TimeDelta::seconds(3)).to_rfc3339();
        insert_duplicate_test_capture(&conn, "same", &old, CaptureOrigin::ClipboardMonitor);
        assert!(recent_duplicate_capture(
            &conn,
            &content_hash("same"),
            &test_window(),
            "same",
            INBOX_CONTEXT_ID,
            "capture",
            CaptureOrigin::ClipboardMonitor,
        )
        .expect("duplicate query should work")
        .is_none());
    }

    #[test]
    fn same_content_from_different_origin_is_not_duplicate() {
        let conn = duplicate_test_connection();
        insert_duplicate_test_capture(&conn, "same", &now(), CaptureOrigin::ExplicitHotkey);
        assert!(recent_duplicate_capture(
            &conn,
            &content_hash("same"),
            &test_window(),
            "same",
            INBOX_CONTEXT_ID,
            "capture",
            CaptureOrigin::ClipboardMonitor,
        )
        .expect("duplicate query should work")
        .is_none());
    }

    #[test]
    fn capture_pages_filter_before_counting_and_limiting() {
        let conn = duplicate_test_connection();
        let timestamp = now();
        for index in 0..65 {
            let text = if index % 10 == 0 {
                format!("needle capture {index}")
            } else {
                format!("ordinary capture {index}")
            };
            insert_duplicate_test_capture(
                &conn,
                &text,
                &timestamp,
                CaptureOrigin::ClipboardMonitor,
            );
        }

        let first_page = CaptureFilter {
            context_id: None,
            search: None,
            tag: None,
            limit: Some(50),
            offset: Some(0),
        };
        assert_eq!(
            count_captures_from_conn(&conn, &first_page).expect("capture count should load"),
            65
        );
        assert_eq!(
            list_captures_from_conn(&conn, &first_page)
                .expect("first page should load")
                .len(),
            50
        );

        let second_page = CaptureFilter {
            offset: Some(50),
            ..first_page
        };
        assert_eq!(
            list_captures_from_conn(&conn, &second_page)
                .expect("second page should load")
                .len(),
            15
        );

        let search_page = CaptureFilter {
            context_id: None,
            search: Some("needle".into()),
            tag: None,
            limit: Some(10),
            offset: Some(0),
        };
        assert_eq!(
            count_captures_from_conn(&conn, &search_page)
                .expect("filtered capture count should load"),
            7
        );
        assert_eq!(
            list_captures_from_conn(&conn, &search_page)
                .expect("filtered capture page should load")
                .len(),
            7
        );
    }

    #[test]
    fn finishing_ocr_job_commits_terminal_state() {
        let mut conn = duplicate_test_connection();
        let timestamp = now();
        let capture_id = insert_duplicate_test_capture(
            &conn,
            "Image capture",
            &timestamp,
            CaptureOrigin::ExplicitHotkey,
        );
        let asset_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO capture_assets (id, capture_id, kind, path, status, error, created_at)
             VALUES (?, ?, 'clipboard_image', 'capture.png', 'saved', NULL, ?)",
            params![asset_id, capture_id, timestamp],
        )
        .expect("test asset should insert");
        conn.execute(
            "INSERT INTO capture_ocr (capture_id, status, text, error, updated_at)
             VALUES (?, 'running', NULL, NULL, ?)",
            params![capture_id, timestamp],
        )
        .expect("test OCR state should insert");
        conn.execute(
            "INSERT INTO ocr_jobs (
                capture_id, asset_id, status, attempts, queued_at, started_at
             ) VALUES (?, ?, 'running', 1, ?, ?)",
            params![capture_id, asset_id, timestamp, timestamp],
        )
        .expect("test OCR job should insert");

        finish_ocr_job(&mut conn, &capture_id, Ok("recognized text".into()))
            .expect("OCR result should persist");

        let job_status: String = conn
            .query_row(
                "SELECT status FROM ocr_jobs WHERE capture_id = ?",
                [&capture_id],
                |row| row.get(0),
            )
            .expect("OCR job should remain available");
        let (ocr_status, ocr_text): (String, Option<String>) = conn
            .query_row(
                "SELECT status, text FROM capture_ocr WHERE capture_id = ?",
                [&capture_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("OCR state should remain available");

        assert_eq!(job_status, "done");
        assert_eq!(ocr_status, "done");
        assert_eq!(ocr_text.as_deref(), Some("recognized text"));
    }

    #[test]
    fn screenshot_policy_is_independent_by_origin() {
        let mut settings = test_settings();
        assert!(screenshot_enabled(
            &settings,
            CaptureOrigin::ExplicitHotkey,
            "capture"
        ));
        assert!(!screenshot_enabled(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "capture"
        ));
        settings.clipboard_monitor_capture_screenshots = true;
        assert!(screenshot_enabled(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "capture"
        ));
        assert!(!screenshot_enabled(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "reference"
        ));
    }

    #[test]
    fn quick_context_policy_is_independent_by_origin() {
        let mut settings = test_settings();
        assert!(should_show_quick_context(
            &settings,
            CaptureOrigin::ExplicitHotkey,
            "capture"
        ));
        assert!(!should_show_quick_context(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "capture"
        ));
        settings.clipboard_monitor_quick_context_enabled = true;
        assert!(should_show_quick_context(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "capture"
        ));
        settings.quick_context_enabled = false;
        assert!(!should_show_quick_context(
            &settings,
            CaptureOrigin::ClipboardMonitor,
            "capture"
        ));
    }

    #[test]
    fn quick_context_window_compacts_without_optional_content() {
        let mut settings = test_settings();
        assert_eq!(quick_context_window_height(&settings), 320.0);
        settings.quick_context_show_preview = false;
        settings.quick_context_show_recent = false;
        assert_eq!(quick_context_window_height(&settings), 256.0);
    }

    #[test]
    fn automatic_capture_is_always_inbox_and_origin_serializes() {
        assert_eq!(INBOX_CONTEXT_ID, "inbox");
        assert_eq!(
            serde_json::to_string(&CaptureOrigin::ClipboardMonitor)
                .expect("origin should serialize"),
            "\"clipboard_monitor\""
        );
    }

    #[test]
    fn multi_format_capture_schema_round_trips_representations_and_files() {
        let conn = Connection::open_in_memory().expect("in-memory database");
        migrate(&conn).expect("schema migration");
        let captured_at = now();
        conn.execute(
            "INSERT INTO captures (
                id, context_id, content_text, content_hash, captured_at, platform,
                metadata_json, capture_kind, created_at
             ) VALUES ('multi', 'inbox', 'fallback', 'hash', ?, 'windows', '{}', 'capture', ?)",
            params![captured_at, captured_at],
        )
        .expect("base capture");
        let state = test_state();
        let snapshot = ClipboardSnapshot {
            representations: vec![
                ClipboardRepresentation::Html("<strong>fallback</strong>".into()),
                ClipboardRepresentation::PlainText("fallback".into()),
                ClipboardRepresentation::Files(vec![ClipboardFile::physical(PathBuf::from(
                    r"C:\missing\report.pdf",
                ))]),
            ],
            formats: Vec::new(),
        };
        persist_clipboard_representations(&conn, &state, "multi", &snapshot, &captured_at)
            .expect("representations persist");
        let capture = get_capture_by_id(&conn, "multi").expect("capture hydration");
        assert_eq!(capture.content_kind, "files");
        assert_eq!(capture.representations.len(), 3);
        assert_eq!(capture.files.len(), 1);
        assert_eq!(capture.files[0].availability, "missing");
    }

    fn test_state() -> AppState {
        AppState {
            app_dir: PathBuf::from("test-data"),
            database_key: String::new(),
            context_key: String::new(),
            capture_gate: Arc::new(Mutex::new(CaptureGate { in_progress: false })),
            ignored_clipboard_sequences: Arc::new(Mutex::new(SequenceSuppression::default())),
            clipboard: Arc::new(ClipboardService::start().expect("test clipboard service")),
            clipboard_monitor: ClipboardMonitorHandle::new(),
            ocr_worker_running: Arc::new(Mutex::new(false)),
            paste_target_window: Arc::new(Mutex::new(None)),
        }
    }

    fn test_settings() -> SettingsDto {
        SettingsDto {
            capture_screenshots: true,
            launch_at_startup: false,
            language: "en".into(),
            hotkey: HOTKEY.into(),
            reference_hotkey: REFERENCE_HOTKEY.into(),
            paste_hotkey: PASTE_HOTKEY.into(),
            data_dir: "test-data".into(),
            ai_provider: "deepseek".into(),
            ai_model: "deepseek-v4-flash".into(),
            ai_api_key: String::new(),
            ai_api_key_configured: false,
            quick_context_enabled: true,
            quick_context_after_reference: false,
            quick_context_timeout_seconds: 8,
            quick_context_show_preview: true,
            quick_context_show_recent: true,
            onboarding_completed: false,
            clipboard_monitor_enabled: false,
            clipboard_monitor_capture_screenshots: false,
            clipboard_monitor_quick_context_enabled: false,
        }
    }

    fn test_window() -> ActiveWindowMetadata {
        ActiveWindowMetadata {
            title: Some("Window".into()),
            process_path: Some("editor.exe".into()),
            app_name: Some("Editor".into()),
            window_id: Some("window".into()),
            process_id: Some(1),
            position: None,
            error: None,
        }
    }

    fn duplicate_test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("database should open");
        migrate(&conn).expect("schema should migrate");
        conn
    }

    fn insert_duplicate_test_capture(
        conn: &Connection,
        text: &str,
        captured_at: &str,
        origin: CaptureOrigin,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        let metadata = json!({ "capture_origin": origin }).to_string();
        conn.execute(
            "INSERT INTO captures (
                id, context_id, content_text, content_hash, captured_at,
                source_app_name, source_app_id, source_process_id, source_process_path,
                window_title, window_id, platform, metadata_json, capture_kind, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                INBOX_CONTEXT_ID,
                text,
                content_hash(text),
                captured_at,
                "Editor",
                "editor.exe",
                1i64,
                "editor.exe",
                "Window",
                "window",
                "windows",
                metadata,
                "capture",
                captured_at,
            ],
        )
        .expect("test capture should insert");
        id
    }
}
