import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api/tauri";
import { formatAppError, formatAppMessage } from "../../appMessages";
import { BrandMark } from "../../components/BrandMark";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { normalizeLanguage, translate, translateLegacyGeneratedContent, type AppLanguage } from "../../i18n";
import type { Capture, Context, LocalSearchStatus, MagicSearchDocument, MagicSearchPreview, Settings } from "../../types";
import { CaptureDetailsDialog } from "./CaptureDetailsDialog";
import { cleanMagicAnswer, formatRelativeDate, maskSensitive } from "./formatters";
import { LiteEmpty } from "./LiteEmpty";
import { LiteIcon } from "./LiteIcon";

type MagicPaletteMode = "direct" | "document";
type DocumentPeriod = "all" | "7" | "30" | "90";
type MagicSearchOpenPayload = { query: string | null; response_mode: MagicPaletteMode | null };

export function LiteMagicPalette() {
  const docsPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("docs-preview")
    : null;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MagicPaletteMode>(docsPreview === "ask-document" ? "document" : "direct");
  const [document, setDocument] = useState<MagicSearchDocument | null>(null);
  const [contexts, setContexts] = useState<Context[]>([]);
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
  const [period, setPeriod] = useState<DocumentPeriod>("all");
  const [preview, setPreview] = useState<MagicSearchPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [detail, setDetail] = useState<Capture | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const [magicEngine, setMagicEngine] = useState<"local" | "provider">("local");
  const [localStatus, setLocalStatus] = useState<LocalSearchStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const modeRef = useRef(mode);
  const contextRef = useRef(selectedContextId);
  const periodRef = useRef(period);
  const searchRequestId = useRef(0);
  const magicEngineRef = useRef(magicEngine);
  const localStatusRef = useRef(localStatus);
  queryRef.current = query;
  modeRef.current = mode;
  contextRef.current = selectedContextId;
  periodRef.current = period;
  magicEngineRef.current = magicEngine;
  localStatusRef.current = localStatus;
  const tr = useCallback((english: string, variables?: Record<string, string | number>) => translate(language, english, variables), [language]);

  const refreshContexts = useCallback(async () => {
    const nextContexts = await api.listContexts();
    setContexts(nextContexts);

    const currentContextId = contextRef.current;
    if (currentContextId && !nextContexts.some((context) => context.id === currentContextId)) {
      contextRef.current = null;
      setSelectedContextId(null);
    }
  }, []);

  const runSearch = useCallback(async (queryOverride?: string, modeOverride?: MagicPaletteMode) => {
    const cleanQuery = (queryOverride ?? queryRef.current).trim();
    if (!cleanQuery) return;
    if (magicEngineRef.current === "local" && localStatusRef.current?.phase !== "ready") return;
    const selectedMode = modeOverride ?? modeRef.current;
    const currentRequest = ++searchRequestId.current;
    setIsLoading(true);
    setError(null);
    setDocument(null);
    setRevealed(false);
    try {
      const nextDocument = await api.generateMagicSearch(buildMagicRequest(
        cleanQuery,
        selectedMode,
        selectedMode === "document" ? contextRef.current : null,
        selectedMode === "document" ? periodRef.current : "all",
      ));
      if (currentRequest === searchRequestId.current) setDocument(nextDocument);
    } catch (reason) {
      if (currentRequest === searchRequestId.current) setError(formatAppError(reason, tr));
    } finally {
      if (currentRequest === searchRequestId.current) setIsLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    globalThis.document.documentElement.classList.add("lite-magic-window");
    api.getSettings().then((settings) => {
      setLanguage(normalizeLanguage(settings.language));
      setMagicEngine(settings.magic_search_engine);
    }).catch(() => undefined);
    api.getLocalSearchStatus().then(setLocalStatus).catch(() => undefined);
    void refreshContexts().catch(() => undefined);
    inputRef.current?.focus();
    return () => globalThis.document.documentElement.classList.remove("lite-magic-window");
  }, [refreshContexts]);

  useTauriEvent<MagicSearchOpenPayload>("magic-search-opened", ({ payload }) => {
    void refreshContexts().catch(() => undefined);
    const nextMode = payload.response_mode === "document" ? "document" : "direct";
    setSelectedContextId(null);
    contextRef.current = null;
    setPeriod("all");
    periodRef.current = "all";
    setMode(nextMode);
    modeRef.current = nextMode;
    setDocument(null);
    setError(null);
    setPreview(null);
    if (payload.query) {
      setQuery(payload.query);
      void runSearch(payload.query, nextMode);
    } else {
      setQuery("");
    }
    window.setTimeout(() => inputRef.current?.focus(), 0);
  });

  useTauriEvent("data-reset", () => void refreshContexts().catch(() => undefined));
  useTauriEvent<Settings>("settings-updated", ({ payload }) => {
    setLanguage(normalizeLanguage(payload.language));
    setMagicEngine(payload.magic_search_engine);
  });
  useTauriEvent<LocalSearchStatus>("local-search-status-changed", ({ payload }) => setLocalStatus(payload));

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detail) setDetail(null);
      else void api.closeMagicSearchWindow();
    };
    globalThis.document.addEventListener("keydown", handleEscape);
    return () => globalThis.document.removeEventListener("keydown", handleEscape);
  }, [detail]);

  useEffect(() => {
    if (mode !== "document" || !query.trim() || (magicEngine === "local" && localStatus?.phase !== "ready")) {
      setPreview(null);
      setIsPreviewLoading(false);
      return;
    }
    let active = true;
    setIsPreviewLoading(true);
    const timer = window.setTimeout(() => {
      api.previewMagicSearch(buildMagicRequest(query.trim(), "document", selectedContextId, period))
        .then((result) => { if (active) setPreview(result); })
        .catch(() => { if (active) setPreview(null); })
        .finally(() => { if (active) setIsPreviewLoading(false); });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [localStatus?.phase, magicEngine, mode, period, query, selectedContextId]);

  const localUnavailable = magicEngine === "local" && localStatus?.phase !== "ready";

  const answer = document?.answer_value ?? cleanMagicAnswer(document?.markdown ?? "");
  const visibleAnswer = document?.sensitive_value && !revealed
    ? maskSensitive(document.sensitive_value)
    : document?.sensitive_value ?? answer;
  const copyAnswer = document?.sensitive_value ?? answer;

  async function openEvidence(captureId: string) {
    try {
      setDetail(await api.getCapture(captureId));
    } catch (reason) {
      setError(formatAppError(reason, tr));
    }
  }

  function selectMode(nextMode: MagicPaletteMode) {
    setMode(nextMode);
    setDocument(null);
    setError(null);
    setPreview(null);
  }

  return (
    <main className="lite-magic-shell">
      <section className="lite-magic-panel">
        <header>
          <span className="lite-brand-mark"><BrandMark /></span>
          <div>
            <strong>{tr("Ask ScryPuppy")} {magicEngine === "local" && <small className="lite-beta-badge">{tr("Local beta")}</small>}</strong>
            <small>{tr(mode === "document" ? "Condense a subject into an editable document" : "Get only the answer you need")}</small>
          </div>
          <button className="lite-icon-button" onClick={() => void api.closeMagicSearchWindow()} aria-label={tr("Close")}><LiteIcon name="close" /></button>
        </header>

        <div className="lite-magic-modes" role="tablist" aria-label={tr("Result format")}>
          <button type="button" role="tab" aria-selected={mode === "direct"} className={mode === "direct" ? "is-selected" : ""} onClick={() => selectMode("direct")}>
            <LiteIcon name="sparkles" />{tr("Quick answer")}
          </button>
          <button type="button" role="tab" aria-selected={mode === "document"} className={mode === "document" ? "is-selected" : ""} onClick={() => selectMode("document")}>
            <LiteIcon name="file" />{tr("Create document")}
          </button>
        </div>

        <form className="lite-magic-form" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
          <LiteIcon name="search" />
          <input ref={inputRef} disabled={localUnavailable} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={tr(mode === "document" ? "What subject should be condensed?" : "What are you looking for?")} aria-label={tr("Magic Search")} />
          <button type="submit" disabled={localUnavailable || !query.trim() || isLoading || (mode === "document" && preview?.evidence_count === 0)} aria-label={tr("Ask ScryPuppy")}>
            <LiteIcon name="sparkles" size={13} /><span>{tr("Ask")}</span>
          </button>
        </form>

        {mode === "document" && <div className="lite-document-scope">
          <label>
            <span>{tr("Context")}</span>
            <select value={selectedContextId ?? ""} onChange={(event) => setSelectedContextId(event.currentTarget.value || null)}>
              <option value="">{tr("All contexts")}</option>
              {contexts.map((context) => <option value={context.id} key={context.id}>{context.name}</option>)}
            </select>
          </label>
          <label>
            <span>{tr("Period")}</span>
            <select value={period} onChange={(event) => setPeriod(event.currentTarget.value as DocumentPeriod)}>
              <option value="all">{tr("All time")}</option>
              <option value="7">{tr("Last 7 days")}</option>
              <option value="30">{tr("Last 30 days")}</option>
              <option value="90">{tr("Last 90 days")}</option>
            </select>
          </label>
          <span className={`lite-document-source-preview ${isPreviewLoading ? "is-loading" : ""}`}>
            <LiteIcon name={isPreviewLoading ? "loader" : "layers"} />
            {isPreviewLoading
              ? tr("Checking sources...")
              : preview
                ? tr("{count} captures will be used", { count: preview.evidence_count })
                : tr("Enter a subject to preview sources")}
          </span>
        </div>}

        <div className="lite-magic-body">
          {localUnavailable ? (
            <LiteEmpty
              icon={localStatus?.phase === "downloading" || localStatus?.phase === "indexing" ? "loader" : "info"}
              title={tr(localStatus?.phase === "indexing" ? "Preparing local search..." : localStatus?.phase === "downloading" ? "Downloading the local model..." : "Local Magic Search is not ready")}
              description={localStatus?.phase === "indexing"
                ? tr("Indexed {indexed} of {total} captures.", { indexed: localStatus.indexed_count, total: localStatus.total_count })
                : tr("Download Multilingual E5 Small in Settings, then wait for your library to be indexed.")}
            />
          ) : isLoading ? (
            <LiteEmpty icon="loader" title={tr(mode === "document" ? "Gathering and condensing evidence..." : "Searching your captures...")} description={tr("ScryPuppy is checking the most relevant evidence.")} />
          ) : error ? (
            <LiteEmpty icon="info" title={tr("No answer found")} description={error} />
          ) : document && mode === "document" ? (
            <div className="lite-document-created">
              <span className="lite-document-created-icon"><LiteIcon name="check" size={22} /></span>
              <div>
                <span className="lite-eyebrow">{tr("Document ready")}</span>
                <h2>{document.title}</h2>
                <p>{tr("A cited Markdown document was created from {count} sources.", { count: document.evidence_count })}</p>
              </div>
              {document.generation_warning && <p className="lite-answer-warning"><LiteIcon name="info" />{formatAppMessage(document.generation_warning, tr)}</p>}
              <button className="lite-primary-button" onClick={() => api.openMagicDocument(document.id).catch((reason) => setError(formatAppError(reason, tr)))}>
                <LiteIcon name="file" />{tr("Open document")}
              </button>
            </div>
          ) : document ? (
            <div className="lite-direct-answer">
              <span className="lite-eyebrow">{tr("Answer")}</span>
              <div className="lite-direct-value">{visibleAnswer}</div>
              {document.generation_warning && <p className="lite-answer-warning"><LiteIcon name="info" />{formatAppMessage(document.generation_warning, tr)}</p>}
              <div className="lite-direct-actions">
                {document.sensitive_value && <button onClick={() => setRevealed((value) => !value)}><LiteIcon name="eye" />{tr(revealed ? "Hide" : "Reveal")}</button>}
                <button className="is-primary" onClick={() => api.copyTextToClipboard(copyAnswer).catch((reason) => setError(formatAppError(reason, tr)))}><LiteIcon name="copy" />{tr("Copy")}</button>
              </div>
              <section className="lite-direct-sources" aria-labelledby="lite-direct-sources-title">
                <div className="lite-direct-sources-title">
                  <span id="lite-direct-sources-title">{tr("Evidence used")}</span>
                  <small>{Math.min(document.evidence.length, 5)}</small>
                </div>
                <div className="lite-document-source-list">
                  {document.evidence.slice(0, 5).map((source, index) => <div className="lite-document-source-item" key={source.capture_id}>
                    <button className="lite-document-source-open" onClick={() => void openEvidence(source.capture_id)}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{source.app_name || tr("Unknown application")}</strong>
                        <small>{source.window_title || formatRelativeDate(source.captured_at, language)}</small>
                        <p>{translateLegacyGeneratedContent(language, source.excerpt)}</p>
                      </div>
                    </button>
                  </div>)}
                </div>
              </section>
            </div>
          ) : mode === "document" ? (
            <LiteEmpty icon="file" title={tr("Turn your captures into a useful document")} description={tr("Describe a subject and ScryPuppy will organize the related information with numbered sources.")} />
          ) : (
            <LiteEmpty icon="sparkles" title={tr("Ask about anything you copied")} description={tr("For example: What is the application ID for application X?")} />
          )}
        </div>

        <footer><kbd>Esc</kbd><span>{tr("close")}</span><span className="lite-footer-spacer" /><span>{tr(magicEngine === "local" ? "Processed on this computer · captures are not sent" : "Selected evidence may be sent to your AI provider")}</span></footer>
      </section>

      {detail && <CaptureDetailsDialog capture={detail} contexts={[]} language={language} readOnly onClose={() => setDetail(null)} onChanged={async () => undefined} onError={setError} />}
    </main>
  );
}

function buildMagicRequest(query: string, mode: MagicPaletteMode, contextId: string | null, period: DocumentPeriod) {
  const dateFrom = period === "all"
    ? null
    : new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000).toISOString();
  return {
    query,
    context_id: contextId,
    tag: null,
    date_from: dateFrom,
    date_to: null,
    limit: mode === "document" ? 24 : 5,
    previous_document_id: null,
    response_mode: mode,
  } as const;
}
