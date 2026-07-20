import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { normalizeCommandError } from "../appMessages";
import type {
  AiProviderOption, ApplyContextSuggestion, ApplyContextSuggestionsResult, Capture, CaptureFilter, CapturePage, Category,
  ChatAnswer, ChatRequest, Context, ContextAnalysisResult, DataCleanupFilter, DataCleanupPreview, DataCleanupResult,
  LibraryCounts, LocalSearchStatus, MagicSearchDocument, MagicSearchItemsPage, MagicSearchItemsRequest, MagicSearchListItem, MagicSearchPreview, MagicSearchRequest,
  RetentionApplyResult, RetentionPolicy, RetentionPreview, SaveSmartContextRuleResult, Settings, SmartContextRule, SmartContextRulePreview, TagDocument,
} from "../types";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeCommandError(error);
  }
}

export async function loadWorkspace(filter: CaptureFilter) {
  const [contexts, categories, counts, captures] = await Promise.all([
    listContexts(),
    invoke<Category[]>("list_categories"),
    getLibraryCounts(),
    listCaptures(filter),
  ]);
  return { contexts, categories, counts, captures };
}

export const listContexts = () => invoke<Context[]>("list_contexts");
export const getLibraryCounts = () => invoke<LibraryCounts>("get_library_counts");
export const listCaptures = (filter: CaptureFilter) => invoke<Capture[]>("list_captures", { filter });
export const listCapturePage = (filter: CaptureFilter) => invoke<CapturePage>("list_capture_page", { filter });
export const getSettings = () => invoke<Settings>("get_settings");
export const getAiProviderOptions = () => invoke<AiProviderOption[]>("get_ai_provider_options");
export const getLocalSearchStatus = () => invoke<LocalSearchStatus>("get_local_search_status");
export const prepareLocalSearch = () => invoke<LocalSearchStatus>("prepare_local_search");
export const removeLocalSearchModel = () => invoke<LocalSearchStatus>("remove_local_search_model");
export const runCapture = () => invoke<Capture>("run_capture");
export const copyTextToClipboard = (text: string) => invoke<void>("copy_text_to_clipboard", { text });
export const copyCaptureToClipboard = (id: string) => invoke<void>("copy_capture_to_clipboard", { id });
export const analyzeContexts = (days: number, includeAi: boolean) => invoke<ContextAnalysisResult>("analyze_contexts", { request: { days, include_ai: includeAi } });
export const applyContextSuggestions = (suggestions: ApplyContextSuggestion[]) => invoke<ApplyContextSuggestionsResult>("apply_context_suggestions", { suggestions });
export const createContext = (name: string) => invoke<Context>("create_context", { name });
export const renameContext = (id: string, name: string) => invoke<Context>("rename_context", { id, name });
export const deleteContext = (id: string) => invoke<void>("delete_context", { id });
export const listContextRules = (contextId: string) => invoke<SmartContextRule[]>("list_context_rules", { contextId });
export const previewContextRule = (rule: SmartContextRule) => invoke<SmartContextRulePreview>("preview_context_rule", { rule });
export const saveContextRule = (rule: SmartContextRule, applyToExisting: boolean) => invoke<SaveSmartContextRuleResult>("save_context_rule", { rule, applyToExisting });
export const deleteContextRule = (ruleId: string) => invoke<void>("delete_context_rule", { ruleId });
export const addCaptureContexts = (captureId: string, contextIds: string[]) => invoke<void>("add_capture_contexts", { captureId, contextIds });
export const addCapturesToContext = (captureIds: string[], contextId: string) => invoke<number>("add_captures_to_context", { captureIds, contextId });
export const removeCaptureContext = (captureId: string, contextId: string) => invoke<void>("remove_capture_context", { captureId, contextId });
export const recentContexts = () => invoke<Context[]>("list_recent_contexts");
export const getCapture = (id: string) => invoke<Capture | null>("get_capture", { id });
export const deleteCapture = (id: string) => invoke<void>("delete_capture", { id });
export const resyncContexts = () => invoke<void>("resync_markdown");
export const saveSettings = (settings: Settings) => invoke<Settings>("update_settings", { settings });
export const askChat = (request: ChatRequest) => invoke<ChatAnswer>("ask_chat", { request });
export const clearAiApiKey = () => invoke<Settings>("clear_ai_api_key");
export const deleteAllData = () => invoke<void>("delete_all_data");
export const previewDataCleanup = (filter: DataCleanupFilter) => invoke<DataCleanupPreview>("preview_data_cleanup", { filter });
export const deleteDataByFilter = (filter: DataCleanupFilter, selectionToken: string) => invoke<DataCleanupResult>("delete_data_by_filter", { filter, selectionToken });
export const previewRetentionChange = (policy: RetentionPolicy) => invoke<RetentionPreview>("preview_retention_change", { policy });
export const applyRetentionChange = (policy: RetentionPolicy, existingAction: "delete" | "keep", selectionToken: string) => invoke<RetentionApplyResult>("apply_retention_change", { policy, existingAction, selectionToken });
export const listPasteItems = (search: string, page: number, pageSize = 10) => invoke<CapturePage>("list_paste_page", {
  search: search.trim() || null,
  limit: pageSize,
  offset: Math.max(0, page) * pageSize,
});
export const pasteCapture = (id: string) => invoke<void>("paste_capture", { id });
export const closePastePalette = () => invoke<void>("close_paste_palette");
export const closeQuickContext = () => invoke<void>("close_quick_context");
export const openMagicSearchWindow = (query?: string, responseMode?: "direct" | "document") => invoke<void>("open_magic_search", {
  query: query?.trim() || null,
  responseMode: responseMode ?? null,
});
export const closeMagicSearchWindow = () => invoke<void>("close_magic_search");
export const openMagicDocument = (id: string) => invoke<void>("open_magic_document", { id });
export const getTagDocument = (tag: string) => invoke<TagDocument>("get_tag_document", { tag });
export const exportTagDocument = (tag: string) => invoke<string>("export_tag_document", { tag });
export const generateMagicSearch = (request: MagicSearchRequest) => invoke<MagicSearchDocument>("generate_magic_search", { request });
export const searchMagicItems = (request: MagicSearchItemsRequest) => invoke<MagicSearchItemsPage>("search_magic_items", { request });
export const previewMagicSearch = (request: MagicSearchRequest) => invoke<MagicSearchPreview>("preview_magic_search", { request });
export const listMagicSearches = () => invoke<MagicSearchListItem[]>("list_magic_searches");
export const getMagicSearch = (id: string) => invoke<MagicSearchDocument>("get_magic_search", { id });
export const exportMagicSearch = (id: string, path?: string) => invoke<string>("export_magic_search", { id, path: path ?? null });
export const updateMagicSearchMarkdown = (id: string, markdown: string) => invoke<MagicSearchDocument>("update_magic_search_markdown", { id, markdown });
export const renameMagicSearch = (id: string, title: string) => invoke<MagicSearchDocument>("rename_magic_search", { id, title });
export const deleteMagicSearch = (rootId: string) => invoke<void>("delete_magic_search", { rootId });
export const deleteOldMagicSearchVersions = (keepId: string) => invoke<MagicSearchDocument>("delete_old_magic_search_versions", { keepId });
export const addMagicSearchEvidence = (id: string, captureId: string) => invoke<MagicSearchDocument>("add_magic_search_evidence", { id, captureId });
export const removeMagicSearchEvidence = (id: string, captureId: string) => invoke<MagicSearchDocument>("remove_magic_search_evidence", { id, captureId });
