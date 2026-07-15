import { invoke } from "@tauri-apps/api/core";
import type {
  AiProviderOption, ApplyContextSuggestion, ApplyContextSuggestionsResult, Capture, CaptureFilter, Category,
  ChatAnswer, ChatRequest, Context, ContextAnalysisResult, LibraryCounts, MagicSearchDocument,
  MagicSearchListItem, MagicSearchPreview, MagicSearchRequest, Settings, TagDocument,
} from "../types";

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
export const getSettings = () => invoke<Settings>("get_settings");
export const getAiProviderOptions = () => invoke<AiProviderOption[]>("get_ai_provider_options");
export const runCapture = () => invoke<Capture>("run_capture");
export const copyTextToClipboard = (text: string) => invoke<void>("copy_text_to_clipboard", { text });
export const analyzeContexts = (days: number, includeAi: boolean) => invoke<ContextAnalysisResult>("analyze_contexts", { request: { days, include_ai: includeAi } });
export const applyContextSuggestions = (suggestions: ApplyContextSuggestion[]) => invoke<ApplyContextSuggestionsResult>("apply_context_suggestions", { suggestions });
export const createContext = (name: string) => invoke<Context>("create_context", { name });
export const renameContext = (id: string, name: string) => invoke<Context>("rename_context", { id, name });
export const deleteContext = (id: string) => invoke<void>("delete_context", { id });
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
export const listPasteItems = (search: string) => listCaptures({
  context_id: null, search: search.trim() || null, tag: null, limit: 60, offset: 0,
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
export const previewMagicSearch = (request: MagicSearchRequest) => invoke<MagicSearchPreview>("preview_magic_search", { request });
export const listMagicSearches = () => invoke<MagicSearchListItem[]>("list_magic_searches");
export const getMagicSearch = (id: string) => invoke<MagicSearchDocument>("get_magic_search", { id });
export const exportMagicSearch = (id: string) => invoke<string>("export_magic_search", { id });
export const updateMagicSearchMarkdown = (id: string, markdown: string) => invoke<MagicSearchDocument>("update_magic_search_markdown", { id, markdown });
export const renameMagicSearch = (id: string, title: string) => invoke<MagicSearchDocument>("rename_magic_search", { id, title });
export const deleteMagicSearch = (rootId: string) => invoke<void>("delete_magic_search", { rootId });
export const deleteOldMagicSearchVersions = (keepId: string) => invoke<MagicSearchDocument>("delete_old_magic_search_versions", { keepId });
export const addMagicSearchEvidence = (id: string, captureId: string) => invoke<MagicSearchDocument>("add_magic_search_evidence", { id, captureId });
export const removeMagicSearchEvidence = (id: string, captureId: string) => invoke<MagicSearchDocument>("remove_magic_search_evidence", { id, captureId });
