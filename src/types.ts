export type Context = {
  id: string;
  name: string;
  normalized_name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  capture_count: number;
};
export type ContextAssignment = Context & {
  assignment_origin: "manual" | "automatic";
  confidence: number | null;
  assigned_at: string;
};
export type Category = { tag: string; capture_count: number };
export type LibraryCounts = { all: number; inbox: number; content_base: number };
export type CaptureAsset = { id: string; kind: string; path: string | null; status: string; error: string | null; created_at: string };
export type CaptureEntity = { id: string; kind: string; value: string; source: string; confidence: number };
export type CaptureOcr = { status: string; text: string | null; error: string | null; updated_at: string };
export type Capture = {
  id: string; content_text: string; captured_at: string;
  source_app_name: string | null; source_app_id: string | null; source_process_id: number | null;
  source_process_path: string | null; window_title: string | null; window_id: string | null;
  platform: string; kind: string; metadata: unknown; assets: CaptureAsset[]; tags: string[];
  entities: CaptureEntity[]; ocr: CaptureOcr | null; contexts: ContextAssignment[];
};
export type Settings = {
  capture_screenshots: boolean; launch_at_startup: boolean; language: "en" | "pt-BR"; hotkey: string; reference_hotkey: string; paste_hotkey: string; data_dir: string;
  ai_provider: string; ai_model: string; ai_api_key: string; ai_api_key_configured: boolean;
  clipboard_monitor_enabled: boolean; clipboard_monitor_capture_screenshots: boolean; clipboard_monitor_quick_context_enabled: boolean;
  quick_context_enabled: boolean; quick_context_after_reference: boolean; quick_context_timeout_seconds: number;
  quick_context_show_preview: boolean; quick_context_show_recent: boolean;
  onboarding_completed: boolean;
};
export type AiProviderOption = { id: string; name: string; models: AiModelOption[] };
export type AiModelOption = { id: string; name: string };
export type EvidenceItem = {
  capture_id: string; captured_at: string; context_names: string[]; app_name: string | null;
  application_id: string | null; window_title: string | null; excerpt: string;
  matched_fields: string[]; asset_paths: string[];
};
export type SuggestedAction = { label: string; action: string; payload: unknown };
export type ChatAnswer = { answer: string; confidence: "high" | "medium" | "low"; evidence: EvidenceItem[]; suggested_actions: SuggestedAction[] };
export type CaptureOrigin = "explicit_hotkey" | "clipboard_monitor" | "file_import";
export type CaptureCreatedEvent = { capture: Capture; origin: CaptureOrigin };
export type CaptureUpdatedEvent = { capture: Capture };
export type CaptureErrorEvent = { error: AppMessagePayload };
export type ContextSuggestion = {
  id: string; name: string; existing_context_id: string | null; capture_ids: string[];
  reason: string; confidence: number; source: "local" | "ai";
};
export type ContextAnalysisResult = {
  scanned_count: number; contextualized_count: number; suggestions: ContextSuggestion[];
  unmatched_capture_ids: string[]; ai_message: AppMessagePayload | null;
};
export type ApplyContextSuggestion = {
  suggestion_id: string; name: string; existing_context_id: string | null;
  capture_ids: string[]; confidence: number;
};
export type ApplyContextSuggestionsResult = { contexts_created: number; associations_added: number };
export type CaptureFilter = { context_id: string | null; search: string | null; tag: string | null; limit: number; offset: number };
export type CapturePage = { items: Capture[]; total: number };
export type ChatRequest = { query: string; context_id: string | null; app: string | null; date_from: string | null; date_to: string | null; limit: number };
export type TagDocument = {
  tag: string; markdown: string; capture_count: number; app_count: number; context_count: number;
  period_start: string | null; period_end: string | null;
};
export type MagicSearchRequest = {
  query: string; context_id: string | null; tag: string | null;
  date_from: string | null; date_to: string | null; limit: number; previous_document_id: string | null;
  response_mode?: "direct" | "brief" | "document";
};
export type MagicSearchPreview = { evidence_count: number; available_count: number };
export type MagicSearchDocument = {
  id: string; root_id: string; previous_document_id: string | null; version: number;
  title: string; query: string; markdown: string; provider: string; model: string;
  filters: MagicSearchRequest; generation_warning: AppMessagePayload | null;
  evidence_count: number; created_at: string; evidence: EvidenceItem[];
  response_mode: "direct" | "brief" | "document"; sensitive_value: string | null;
  answer_value: string | null;
};
export type MagicSearchListItem = {
  id: string; root_id: string; version: number; title: string; query: string; provider: string;
  model: string; evidence_count: number; created_at: string; response_mode: "direct" | "brief" | "document";
};
import type { AppMessagePayload } from "./appMessages";
