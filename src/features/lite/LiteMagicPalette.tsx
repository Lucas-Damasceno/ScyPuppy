import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api/tauri";
import { formatAppError } from "../../appMessages";
import { BrandMark } from "../../components/BrandMark";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { normalizeLanguage, translate, translateLegacyGeneratedContent, type AppLanguage } from "../../i18n";
import type { Capture, Context, DocumentGenerationProgress, EvidenceItem, LocalSearchStatus, MagicSearchDocument, MagicSearchPreview, Settings } from "../../types";
import { CaptureDetailsDialog } from "./CaptureDetailsDialog";
import { formatRelativeDate } from "./formatters";
import { LiteEmpty } from "./LiteEmpty";
import { LiteIcon } from "./LiteIcon";

type MagicPaletteMode = "search" | "document";
type DocumentPeriod = "all" | "7" | "30" | "90";
type MagicSearchOpenPayload = { query: string | null; response_mode: "direct" | "document" | null };

const pageSize = 20;

export function LiteMagicPalette() {
  const docsPreview = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("docs-preview") : null;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MagicPaletteMode>(docsPreview === "ask-document" ? "document" : "search");
  const [results, setResults] = useState<EvidenceItem[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [generatedDocument, setGeneratedDocument] = useState<MagicSearchDocument | null>(null);
  const [contexts, setContexts] = useState<Context[]>([]);
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([]);
  const [includeKnowledgeBase, setIncludeKnowledgeBase] = useState(true);
  const [includeInbox, setIncludeInbox] = useState(true);
  const [period, setPeriod] = useState<DocumentPeriod>("all");
  const [preview, setPreview] = useState<MagicSearchPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [detail, setDetail] = useState<Capture | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalSearchStatus | null>(null);
  const [progress, setProgress] = useState<DocumentGenerationProgress | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextsRef = useRef<Context[]>([]);
  const selectionInitializedRef = useRef(false);
  const searchRequestId = useRef(0);
  const tr = useCallback((english: string, variables?: Record<string, string | number>) => translate(language, english, variables), [language]);

  const refreshContexts = useCallback(async (reset = false) => {
    const nextContexts = await api.listContexts();
    const previousContexts = contextsRef.current;
    contextsRef.current = nextContexts;
    setContexts(nextContexts);
    setSelectedContextIds((current) => {
      const hadAllSelected = previousContexts.length > 0 && current.length === previousContexts.length;
      if (reset || !selectionInitializedRef.current || hadAllSelected) {
        selectionInitializedRef.current = true;
        return nextContexts.map((context) => context.id);
      }
      const available = new Set(nextContexts.map((context) => context.id));
      return current.filter((id) => available.has(id));
    });
  }, []);

  const runSearch = useCallback(async (append = false, queryOverride?: string) => {
    const cleanQuery = (queryOverride ?? query).trim();
    if (!cleanQuery || localStatus?.phase !== "ready") return;
    const requestId = ++searchRequestId.current;
    append ? setIsLoadingMore(true) : setIsLoading(true);
    setError(null);
    if (!append) {
      setResults([]);
      setResultTotal(0);
    }
    try {
      const page = await api.searchMagicItems({ query: cleanQuery, offset: append ? results.length : 0, limit: pageSize });
      if (requestId !== searchRequestId.current) return;
      setResults((current) => append ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.capture_id === item.capture_id))] : page.items);
      setResultTotal(page.total);
      setHasMore(page.has_more);
    } catch (reason) {
      if (requestId === searchRequestId.current) setError(formatAppError(reason, tr));
    } finally {
      if (requestId === searchRequestId.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [localStatus?.phase, query, results.length, tr]);

  const createDocument = useCallback(async () => {
    const cleanQuery = query.trim();
    if (!cleanQuery || !providerConfigured) return;
    const requestId = ++searchRequestId.current;
    setIsLoading(true);
    setError(null);
    setGeneratedDocument(null);
    setProgress({ phase: "preparing", completed: 0, total: preview?.batch_count ?? 0 });
    try {
      const nextDocument = await api.generateMagicSearch(buildDocumentRequest(
        cleanQuery, selectedContextIds, includeKnowledgeBase, includeInbox, period,
      ));
      if (requestId === searchRequestId.current) setGeneratedDocument(nextDocument);
    } catch (reason) {
      if (requestId === searchRequestId.current) setError(formatAppError(reason, tr));
    } finally {
      if (requestId === searchRequestId.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  }, [includeInbox, includeKnowledgeBase, period, preview?.batch_count, providerConfigured, query, selectedContextIds, tr]);

  useEffect(() => {
    document.documentElement.classList.add("lite-magic-window");
    api.getSettings().then((settings) => {
      setLanguage(normalizeLanguage(settings.language));
      setProviderConfigured(settings.ai_api_key_configured);
    }).catch(() => undefined);
    api.getLocalSearchStatus().then(setLocalStatus).catch(() => undefined);
    void refreshContexts(true).catch(() => undefined);
    inputRef.current?.focus();
    return () => document.documentElement.classList.remove("lite-magic-window");
  }, [refreshContexts]);

  useTauriEvent<MagicSearchOpenPayload>("magic-search-opened", ({ payload }) => {
    selectionInitializedRef.current = false;
    void refreshContexts(true).catch(() => undefined);
    setIncludeKnowledgeBase(true);
    setIncludeInbox(true);
    setPeriod("all");
    setMode(payload.response_mode === "document" ? "document" : "search");
    setQuery(payload.query ?? "");
    setResults([]);
    setResultTotal(0);
    setHasMore(false);
    setGeneratedDocument(null);
    setError(null);
    setPreview(null);
    if (payload.query && payload.response_mode !== "document") window.setTimeout(() => void runSearch(false, payload.query!), 0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  });
  useTauriEvent("data-reset", () => void refreshContexts(true).catch(() => undefined));
  useTauriEvent<Settings>("settings-updated", ({ payload }) => {
    setLanguage(normalizeLanguage(payload.language));
    setProviderConfigured(payload.ai_api_key_configured);
  });
  useTauriEvent<LocalSearchStatus>("local-search-status-changed", ({ payload }) => setLocalStatus(payload));
  useTauriEvent<DocumentGenerationProgress>("document-generation-progress", ({ payload }) => setProgress(payload));

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detail) setDetail(null);
      else void api.closeMagicSearchWindow();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [detail]);

  useEffect(() => {
    if (mode !== "document") {
      setPreview(null);
      return;
    }
    let active = true;
    setIsPreviewLoading(true);
    const timer = window.setTimeout(() => {
      api.previewMagicSearch(buildDocumentRequest(query.trim(), selectedContextIds, includeKnowledgeBase, includeInbox, period))
        .then((value) => { if (active) setPreview(value); })
        .catch(() => { if (active) setPreview(null); })
        .finally(() => { if (active) setIsPreviewLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [includeInbox, includeKnowledgeBase, mode, period, query, selectedContextIds]);

  const localUnavailable = mode === "search" && localStatus?.phase !== "ready";
  const allContextsSelected = contexts.length === selectedContextIds.length;
  const selectedSourceCount = selectedContextIds.length + Number(includeKnowledgeBase) + Number(includeInbox);

  async function openEvidence(captureId: string) {
    try {
      const capture = await api.getCapture(captureId);
      if (capture) setDetail(capture);
    } catch (reason) {
      setError(formatAppError(reason, tr));
    }
  }

  function selectMode(nextMode: MagicPaletteMode) {
    searchRequestId.current += 1;
    setMode(nextMode);
    setResults([]);
    setResultTotal(0);
    setGeneratedDocument(null);
    setError(null);
  }

  function toggleContext(contextId: string) {
    setSelectedContextIds((current) => current.includes(contextId) ? current.filter((id) => id !== contextId) : [...current, contextId]);
  }

  const progressText = progress?.phase === "batching"
    ? tr("Processing batch {current} of {total}...", { current: Math.min(progress.completed + 1, progress.total), total: progress.total })
    : progress?.phase === "synthesizing" ? tr("Consolidating the final document...")
      : progress?.phase === "saving" ? tr("Saving the document and its sources...")
        : tr("Preparing selected sources...");

  return (
    <main className="lite-magic-shell">
      <section className="lite-magic-panel">
        <header>
          <span className="lite-brand-mark"><BrandMark /></span>
          <div>
            <strong>{tr("Ask ScryPuppy")} {mode === "search" && <small className="lite-beta-badge">E5</small>}</strong>
            <small>{tr(mode === "document" ? "Create an editable document with your AI provider" : "Find related items by meaning and exact text")}</small>
          </div>
          <button className="lite-icon-button" onClick={() => void api.closeMagicSearchWindow()} aria-label={tr("Close")}><LiteIcon name="close" /></button>
        </header>

        <div className="lite-magic-modes" role="tablist" aria-label={tr("Result format")}>
          <button type="button" role="tab" aria-selected={mode === "search"} className={mode === "search" ? "is-selected" : ""} onClick={() => selectMode("search")}>
            <LiteIcon name="search" />{tr("Search")}
          </button>
          <button type="button" role="tab" aria-selected={mode === "document"} className={mode === "document" ? "is-selected" : ""} onClick={() => selectMode("document")}>
            <LiteIcon name="file" />{tr("Create document")}
          </button>
        </div>

        <form className="lite-magic-form" onSubmit={(event) => { event.preventDefault(); void (mode === "search" ? runSearch() : createDocument()); }}>
          <LiteIcon name="search" />
          <input ref={inputRef} disabled={localUnavailable} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={tr(mode === "document" ? "What should the document summarize?" : "What are you looking for?")} aria-label={tr("Magic Search")} />
          <button type="submit" disabled={localUnavailable || !query.trim() || isLoading || (mode === "document" && (!providerConfigured || preview?.evidence_count === 0))} aria-label={tr(mode === "document" ? "Create document" : "Search")}>
            <LiteIcon name={mode === "document" ? "sparkles" : "search"} size={13} /><span>{tr(mode === "document" ? "Create" : "Search")}</span>
          </button>
        </form>

        {mode === "document" && <div className="lite-document-scope">
          <details className="lite-source-selector">
            <summary><span>{tr("Sources")}</span><strong>{tr("{count} groups selected", { count: selectedSourceCount })}</strong><LiteIcon name="chevron" /></summary>
            <div className="lite-source-selector-menu">
              <label className="lite-source-group-master"><input type="checkbox" checked={allContextsSelected} onChange={(event) => setSelectedContextIds(event.currentTarget.checked ? contexts.map((context) => context.id) : [])} /><span><strong>{tr("All contexts")}</strong><small>{tr("{count} contexts", { count: contexts.length })}</small></span></label>
              <div className="lite-source-contexts">
                {contexts.map((context) => <label key={context.id}><input type="checkbox" checked={selectedContextIds.includes(context.id)} onChange={() => toggleContext(context.id)} /><span>{context.name}</span><small>{context.capture_count}</small></label>)}
              </div>
              <label><input type="checkbox" checked={includeKnowledgeBase} onChange={(event) => setIncludeKnowledgeBase(event.currentTarget.checked)} /><span><strong>{tr("Knowledge Base")}</strong><small>{tr("Durable references")}</small></span></label>
              <label><input type="checkbox" checked={includeInbox} onChange={(event) => setIncludeInbox(event.currentTarget.checked)} /><span><strong>{tr("Inbox")}</strong><small>{tr("Unorganized captures")}</small></span></label>
            </div>
          </details>
          <label>
            <span>{tr("Period")}</span>
            <select value={period} onChange={(event) => setPeriod(event.currentTarget.value as DocumentPeriod)}>
              <option value="all">{tr("All time")}</option><option value="7">{tr("Last 7 days")}</option><option value="30">{tr("Last 30 days")}</option><option value="90">{tr("Last 90 days")}</option>
            </select>
          </label>
          <span className={`lite-document-source-preview ${isPreviewLoading ? "is-loading" : ""}`}>
            <LiteIcon name={isPreviewLoading ? "loader" : "layers"} />
            {isPreviewLoading ? tr("Checking sources...") : preview ? tr("{count} items · {batches} provider batches", { count: preview.evidence_count, batches: preview.batch_count }) : tr("Select sources to preview")}
          </span>
        </div>}

        {mode === "document" && !providerConfigured && <p className="lite-provider-required"><LiteIcon name="info" />{tr("Configure an AI provider key in Settings before creating a document.")}</p>}

        <div className="lite-magic-body">
          {localUnavailable ? <LiteEmpty icon={localStatus?.phase === "downloading" || localStatus?.phase === "indexing" ? "loader" : "info"} title={tr(localStatus?.phase === "indexing" ? "Preparing local search..." : "Local Magic Search is not ready")} description={tr("Download Multilingual E5 Small in Settings, then wait for your library to be indexed.")} />
            : isLoading ? <LiteEmpty icon="loader" title={tr(mode === "document" ? "Creating your document..." : "Searching your captures...")} description={mode === "document" ? progressText : tr("ScryPuppy is ranking matches with E5 and exact text.")} />
              : error ? <LiteEmpty icon="info" title={tr(mode === "document" ? "The document could not be generated" : "No results found")} description={error} />
                : generatedDocument && mode === "document" ? <div className="lite-document-created"><span className="lite-document-created-icon"><LiteIcon name="check" size={22} /></span><div><span className="lite-eyebrow">{tr("Document ready")}</span><h2>{generatedDocument.title}</h2><p>{tr("A cited Markdown document was created from {count} sources.", { count: generatedDocument.evidence_count })}</p></div><button className="lite-primary-button" onClick={() => api.openMagicDocument(generatedDocument.id).catch((reason) => setError(formatAppError(reason, tr)))}><LiteIcon name="file" />{tr("Open document")}</button></div>
                  : mode === "search" && results.length > 0 ? <section className="lite-search-results" aria-labelledby="lite-search-results-title"><div className="lite-direct-sources-title"><span id="lite-search-results-title">{tr("Items found")}</span><small>{resultTotal}</small></div><div className="lite-document-source-list">{results.map((source, index) => <div className="lite-document-source-item" key={source.capture_id}><button className="lite-document-source-open" onClick={() => void openEvidence(source.capture_id)}><span>{index + 1}</span><div><strong>{source.app_name || tr("Unknown application")}</strong><small>{source.window_title || formatRelativeDate(source.captured_at, language)}</small><p>{translateLegacyGeneratedContent(language, source.excerpt)}</p>{source.context_names.length > 0 && <em>{source.context_names.join(" · ")}</em>}</div></button></div>)}</div>{hasMore && <button className="lite-load-more" disabled={isLoadingMore} onClick={() => void runSearch(true)}>{isLoadingMore ? tr("Loading...") : tr("Load more")}</button>}</section>
                    : mode === "document" ? <LiteEmpty icon="file" title={tr("Turn your captures into a useful document")} description={tr("All selected text and safe metadata will be sent to your configured AI provider, in batches when needed.")} />
                      : <LiteEmpty icon="search" title={tr("Search everything you captured")} description={tr("Describe it naturally and ScryPuppy will show a ranked list of matching items.")} />}
        </div>

        <footer><kbd>Esc</kbd><span>{tr("close")}</span><span className="lite-footer-spacer" /><span>{tr(mode === "search" ? "Search stays on this computer · no provider is called" : "Selected text and safe metadata are sent to your AI provider")}</span></footer>
      </section>
      {detail && <CaptureDetailsDialog capture={detail} contexts={[]} language={language} readOnly onClose={() => setDetail(null)} onChanged={async () => undefined} onError={setError} />}
    </main>
  );
}

function buildDocumentRequest(query: string, contextIds: string[], includeKnowledgeBase: boolean, includeInbox: boolean, period: DocumentPeriod) {
  const dateFrom = period === "all" ? null : new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000).toISOString();
  return {
    query,
    context_ids: contextIds,
    include_knowledge_base: includeKnowledgeBase,
    include_inbox: includeInbox,
    tag: null,
    date_from: dateFrom,
    date_to: null,
    limit: 0,
    previous_document_id: null,
    response_mode: "document",
  } as const;
}
