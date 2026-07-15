import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import * as api from "../../api/tauri";
import { MarkdownDocument } from "../../components/MarkdownDocument";
import { translate, type AppLanguage } from "../../i18n";
import type { Capture, MagicSearchDocument, MagicSearchListItem } from "../../types";
import { CaptureDetailsDialog } from "./CaptureDetailsDialog";
import { LiteEmpty } from "./LiteEmpty";
import { LiteIcon } from "./LiteIcon";

type LiteDocumentsWorkspaceProps = {
  language: AppLanguage;
  requestedDocumentId: string | null;
  status: string | null;
  onNewDocument: () => void;
  onClearStatus: () => void;
  onStatus: (message: string) => void;
};

type SaveState = "idle" | "saving" | "saved" | "error";
type PendingConfirmation =
  | { kind: "delete-document" }
  | { kind: "delete-versions" }
  | { kind: "remove-source"; captureId: string; number: number };

export function LiteDocumentsWorkspace({ language, requestedDocumentId, status, onNewDocument, onClearStatus, onStatus }: LiteDocumentsWorkspaceProps) {
  const [history, setHistory] = useState<MagicSearchListItem[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [document, setDocument] = useState<MagicSearchDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isManagingSources, setIsManagingSources] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceCandidates, setSourceCandidates] = useState<Capture[]>([]);
  const [isSourceLoading, setIsSourceLoading] = useState(false);
  const [sourceActionId, setSourceActionId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [detail, setDetail] = useState<Capture | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const tr = useCallback((english: string, variables?: Record<string, string | number>) => translate(language, english, variables), [language]);
  const confirmationCopy = useMemo(() => {
    if (!pendingConfirmation) return null;
    if (pendingConfirmation.kind === "delete-document") return {
      title: tr("Delete this document?"),
      description: tr("This removes the document and every saved version. This action cannot be undone."),
      confirmLabel: tr("Delete document"),
    };
    if (pendingConfirmation.kind === "delete-versions") return {
      title: tr("Delete older versions?"),
      description: tr("Only the current version will be kept. This action cannot be undone."),
      confirmLabel: tr("Delete versions"),
    };
    return {
      title: tr("Remove source [{number}]?", { number: pendingConfirmation.number }),
      description: tr("The source will be removed and the remaining citations will be renumbered."),
      confirmLabel: tr("Remove source"),
    };
  }, [pendingConfirmation, tr]);

  const applyDocument = useCallback((nextDocument: MagicSearchDocument) => {
    setDocument(nextDocument);
    setDraft(nextDocument.markdown);
    setTitleDraft(nextDocument.title);
    setSaveState("idle");
  }, []);

  const openDocument = useCallback(async (id: string) => {
    setIsLoading(true);
    try {
      applyDocument(await api.getMagicSearch(id));
    } catch (error) {
      onStatus(String(error));
    } finally {
      setIsLoading(false);
    }
  }, [applyDocument, onStatus]);

  const refreshHistory = useCallback(async (preferredId?: string | null) => {
    setIsLoading(true);
    try {
      const documents = (await api.listMagicSearches()).filter((item) => item.response_mode === "document");
      setHistory(documents);
      const nextId = preferredId || documents[0]?.id;
      if (nextId) applyDocument(await api.getMagicSearch(nextId));
      else {
        setDocument(null);
        setDraft("");
        setTitleDraft("");
      }
    } catch (error) {
      onStatus(String(error));
    } finally {
      setIsLoading(false);
    }
  }, [applyDocument, onStatus]);

  useEffect(() => {
    void refreshHistory(requestedDocumentId);
  }, [refreshHistory, requestedDocumentId]);

  useEffect(() => {
    if (!document || draft === document.markdown) return;
    setSaveState("saving");
    const markdown = draft;
    const timer = window.setTimeout(() => {
      api.updateMagicSearchMarkdown(document.id, markdown).then((saved) => {
        if (draftRef.current === markdown) {
          setDocument(saved);
          setSaveState("saved");
        }
      }).catch((error) => {
        setSaveState("error");
        onStatus(String(error));
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [document, draft, onStatus]);

  useEffect(() => {
    if (!pendingConfirmation) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isConfirming) setPendingConfirmation(null);
    };
    globalThis.document.addEventListener("keydown", handleEscape);
    return () => globalThis.document.removeEventListener("keydown", handleEscape);
  }, [isConfirming, pendingConfirmation]);

  useEffect(() => {
    if (!isManagingSources) return;
    let active = true;
    setIsSourceLoading(true);
    const timer = window.setTimeout(() => {
      api.listCaptures({ context_id: null, search: sourceSearch.trim() || null, tag: null, limit: 20, offset: 0 })
        .then((captures) => { if (active) setSourceCandidates(captures); })
        .catch((error) => { if (active) onStatus(String(error)); })
        .finally(() => { if (active) setIsSourceLoading(false); });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isManagingSources, onStatus, sourceSearch]);

  const visibleHistory = useMemo(() => {
    const term = historySearch.trim().toLocaleLowerCase();
    if (!term) return history;
    return history.filter((item) => `${item.title} ${item.query}`.toLocaleLowerCase().includes(term));
  }, [history, historySearch]);
  const currentVersionCount = document ? history.filter((item) => item.root_id === document.root_id).length : 0;
  const currentSourceIds = useMemo(() => new Set(document?.evidence.map((item) => item.capture_id) ?? []), [document?.evidence]);
  const availableSourceCandidates = useMemo(() => sourceCandidates.filter((capture) => !currentSourceIds.has(capture.id)), [currentSourceIds, sourceCandidates]);

  async function saveDraftIfNeeded(current: MagicSearchDocument) {
    if (draft === current.markdown) return current;
    const saved = await api.updateMagicSearchMarkdown(current.id, draft);
    applyDocument(saved);
    setSaveState("saved");
    return saved;
  }

  async function updateWithAi() {
    if (!document) return;
    setIsGenerating(true);
    try {
      const current = await saveDraftIfNeeded(document);
      const nextDocument = await api.generateMagicSearch({
        ...current.filters,
        query: current.query,
        limit: 24,
        previous_document_id: current.id,
        response_mode: "document",
      });
      await refreshHistory(nextDocument.id);
    } catch (error) {
      onStatus(String(error));
    } finally {
      setIsGenerating(false);
    }
  }

  async function exportDocument() {
    if (!document) return;
    try {
      const current = await saveDraftIfNeeded(document);
      const destination = await saveFile({
        title: tr("Export Markdown document"),
        defaultPath: markdownFileName(current.title),
        filters: [{ name: tr("Markdown document"), extensions: ["md"] }],
      });
      if (!destination) return;
      const path = await api.exportMagicSearch(current.id, destination);
      onStatus(tr("Document exported to {path}", { path }));
    } catch (error) {
      onStatus(String(error));
    }
  }

  async function saveTitle() {
    if (!document) return;
    const title = titleDraft.trim();
    if (!title || title === document.title) {
      setTitleDraft(document.title);
      setIsRenaming(false);
      return;
    }
    try {
      const renamed = await api.renameMagicSearch(document.id, title);
      applyDocument(renamed);
      setHistory((items) => items.map((item) => item.root_id === renamed.root_id ? { ...item, title: renamed.title } : item));
      setIsRenaming(false);
    } catch (error) {
      onStatus(String(error));
    }
  }

  async function deleteDocument() {
    if (!document) return;
    try {
      await api.deleteMagicSearch(document.root_id);
      await refreshHistory(null);
      onStatus(tr("Document deleted."));
    } catch (error) {
      onStatus(String(error));
    }
  }

  async function deleteOldVersions() {
    if (!document || currentVersionCount < 2) return;
    try {
      const cleaned = await api.deleteOldMagicSearchVersions(document.id);
      await refreshHistory(cleaned.id);
      onStatus(tr("Old versions deleted."));
    } catch (error) {
      onStatus(String(error));
    }
  }

  async function addSource(captureId: string) {
    if (!document) return;
    setSourceActionId(captureId);
    try {
      const current = await saveDraftIfNeeded(document);
      const updated = await api.addMagicSearchEvidence(current.id, captureId);
      applyDocument(updated);
      setHistory((items) => items.map((item) => item.id === updated.id ? { ...item, evidence_count: updated.evidence_count } : item));
      onStatus(tr("Source added as reference [{number}].", { number: updated.evidence.length }));
    } catch (error) {
      onStatus(String(error));
    } finally {
      setSourceActionId(null);
    }
  }

  async function removeSource(captureId: string) {
    if (!document) return;
    setSourceActionId(captureId);
    try {
      const current = await saveDraftIfNeeded(document);
      const updated = await api.removeMagicSearchEvidence(current.id, captureId);
      applyDocument(updated);
      setHistory((items) => items.map((item) => item.id === updated.id ? { ...item, evidence_count: updated.evidence_count } : item));
      onStatus(tr("Source removed and citations renumbered."));
    } catch (error) {
      onStatus(String(error));
    } finally {
      setSourceActionId(null);
    }
  }

  async function confirmPendingAction() {
    const action = pendingConfirmation;
    if (!action || isConfirming) return;
    setIsConfirming(true);
    try {
      if (action.kind === "delete-document") await deleteDocument();
      else if (action.kind === "delete-versions") await deleteOldVersions();
      else await removeSource(action.captureId);
    } finally {
      setIsConfirming(false);
      setPendingConfirmation(null);
    }
  }

  async function openSource(captureId: string) {
    try {
      setDetail(await api.getCapture(captureId));
    } catch (error) {
      onStatus(String(error));
    }
  }

  if (isLoading && !document) return <section className="lite-documents-workspace"><LiteEmpty icon="loader" title={tr("Loading documents...")} /></section>;

  if (!document) {
    return <section className="lite-documents-workspace is-empty">
      <LiteEmpty icon="file" title={tr("No documents yet")} description={tr("Create a cited Markdown document from a subject in your clipboard history.")} />
      <button className="lite-primary-button" onClick={onNewDocument}><LiteIcon name="plus" />{tr("Create document")}</button>
    </section>;
  }

  return <section className="lite-documents-workspace">
    <header className="lite-document-header">
      <div className="lite-document-heading">
        <span className="lite-eyebrow">{tr("Documents")}</span>
        <div className="lite-document-title-row">
          {isRenaming ? <input autoFocus value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.currentTarget.value)} onBlur={() => void saveTitle()} onKeyDown={(event) => {
            if (event.key === "Enter") void saveTitle();
            if (event.key === "Escape") { setTitleDraft(document.title); setIsRenaming(false); }
          }} /> : <h1>{document.title}</h1>}
          {!isRenaming && <button className="lite-icon-button" onClick={() => setIsRenaming(true)} aria-label={tr("Rename document")} title={tr("Rename document")}><LiteIcon name="edit" /></button>}
        </div>
        <p>{tr("Version {version} · {count} sources", { version: document.version, count: document.evidence_count })}</p>
      </div>
      <div className="lite-document-actions">
        <button onClick={onNewDocument}><LiteIcon name="plus" />{tr("New document")}</button>
        <button disabled={isGenerating} onClick={() => void updateWithAi()}><LiteIcon name={isGenerating ? "loader" : "refresh"} />{tr(isGenerating ? "Updating..." : "Update with AI")}</button>
        {currentVersionCount > 1 && <button onClick={() => setPendingConfirmation({ kind: "delete-versions" })}><LiteIcon name="layers" />{tr("Clean versions")}</button>}
        <button className="is-danger" onClick={() => setPendingConfirmation({ kind: "delete-document" })}><LiteIcon name="trash" />{tr("Delete")}</button>
        <button className="is-primary" onClick={() => void exportDocument()}><LiteIcon name="export" />{tr("Export .md")}</button>
      </div>
    </header>

    {status && <div className="lite-status"><LiteIcon name="info" /><span>{status}</span><button onClick={onClearStatus}><LiteIcon name="close" /></button></div>}

    <div className={`lite-document-layout ${isManagingSources ? "is-managing-sources" : ""}`}>
      <aside className="lite-document-history" aria-label={tr("Document history")}>
        <div className="lite-document-panel-title"><span>{tr("History")}</span><small>{visibleHistory.length}</small></div>
        <div className="lite-document-panel-search"><LiteIcon name="search" /><input value={historySearch} onChange={(event) => setHistorySearch(event.currentTarget.value)} placeholder={tr("Search documents...")} /></div>
        <div className="lite-document-history-list">
          {visibleHistory.map((item) => <button className={item.id === document.id ? "is-selected" : ""} key={item.id} onClick={() => void openDocument(item.id)}>
            <strong>{item.title}</strong>
            <span>{tr("Version")} {item.version} · {formatDocumentDate(item.created_at, language)}</span>
          </button>)}
          {visibleHistory.length === 0 && <p className="lite-document-no-results">{tr("No documents found")}</p>}
        </div>
      </aside>

      <div className="lite-document-editor">
        <div className="lite-document-editor-toolbar">
          <div className="lite-document-view-modes" role="tablist" aria-label={tr("Document view")}>
            <button role="tab" aria-selected={view === "edit"} className={view === "edit" ? "is-selected" : ""} onClick={() => setView("edit")}><LiteIcon name="edit" />{tr("Edit")}</button>
            <button role="tab" aria-selected={view === "preview"} className={view === "preview" ? "is-selected" : ""} onClick={() => setView("preview")}><LiteIcon name="eye" />{tr("Preview")}</button>
          </div>
          <span className={`lite-document-save is-${saveState}`}><LiteIcon name={saveState === "saving" ? "loader" : saveState === "error" ? "info" : "check"} />{tr(saveState === "saving" ? "Saving..." : saveState === "error" ? "Could not save" : "Saved locally")}</span>
        </div>
        {view === "edit" ? <textarea className="lite-document-textarea" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} spellCheck /> : <div className="lite-document-preview"><MarkdownDocument source={draft} /></div>}
      </div>

      <aside className="lite-document-sources" aria-label={tr("Sources")}>
        <div className="lite-document-panel-title">
          <span>{tr(isManagingSources ? "Add sources" : "Sources")}</span>
          <button onClick={() => setIsManagingSources((value) => !value)}><LiteIcon name={isManagingSources ? "close" : "plus"} />{tr(isManagingSources ? "Done" : "Manage")}</button>
        </div>
        {isManagingSources ? <>
          <div className="lite-document-panel-search"><LiteIcon name="search" /><input autoFocus value={sourceSearch} onChange={(event) => setSourceSearch(event.currentTarget.value)} placeholder={tr("Search captures...")} /></div>
          <p>{tr("Add a capture as a numbered source. Then cite its number in the editor.")}</p>
          <div className="lite-source-candidates">
            {isSourceLoading && <span className="lite-source-loading"><LiteIcon name="loader" />{tr("Searching...")}</span>}
            {!isSourceLoading && availableSourceCandidates.map((capture) => <button key={capture.id} disabled={sourceActionId === capture.id} onClick={() => void addSource(capture.id)}>
              <span><LiteIcon name={sourceActionId === capture.id ? "loader" : "plus"} /></span>
              <div><strong>{capture.source_app_name || tr("Unknown application")}</strong><p>{compactSource(capture.content_text)}</p></div>
            </button>)}
            {!isSourceLoading && availableSourceCandidates.length === 0 && <span className="lite-source-loading">{tr("No available captures found.")}</span>}
          </div>
        </> : <>
          <p>{tr("Select a source to view the original capture.")}</p>
          <div className="lite-document-source-list">
            {document.evidence.map((source, index) => <div className="lite-document-source-item" key={source.capture_id}>
              <button className="lite-document-source-open" onClick={() => void openSource(source.capture_id)}>
                <span>{index + 1}</span>
                <div><strong>{source.app_name || tr("Unknown application")}</strong><small>{source.window_title || formatDocumentDate(source.captured_at, language)}</small><p>{source.excerpt}</p></div>
              </button>
              <button className="lite-document-source-remove" disabled={sourceActionId === source.capture_id} onClick={() => setPendingConfirmation({ kind: "remove-source", captureId: source.capture_id, number: index + 1 })} aria-label={tr("Remove source [{number}]", { number: index + 1 })}><LiteIcon name={sourceActionId === source.capture_id ? "loader" : "close"} /></button>
            </div>)}
          </div>
        </>}
      </aside>
    </div>

    {document.generation_warning && <div className="lite-document-warning"><LiteIcon name="info" />{document.generation_warning}</div>}
    {detail && <CaptureDetailsDialog capture={detail} contexts={[]} language={language} readOnly onClose={() => setDetail(null)} onChanged={async () => undefined} onError={onStatus} />}
    {pendingConfirmation && confirmationCopy && <div className="lite-modal-backdrop" onMouseDown={(event) => {
      if (!isConfirming && event.currentTarget === event.target) setPendingConfirmation(null);
    }}>
      <section className="lite-modal-surface lite-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="lite-confirm-title" aria-describedby="lite-confirm-description">
        <header>
          <span className="lite-confirm-icon"><LiteIcon name="trash" /></span>
          <div>
            <span className="lite-eyebrow">{tr("Permanent action")}</span>
            <h2 id="lite-confirm-title">{confirmationCopy.title}</h2>
            <p id="lite-confirm-description">{confirmationCopy.description}</p>
          </div>
        </header>
        <footer>
          <button autoFocus className="lite-confirm-cancel" disabled={isConfirming} onClick={() => setPendingConfirmation(null)}>{tr("Cancel")}</button>
          <button className="lite-confirm-danger" disabled={isConfirming} onClick={() => void confirmPendingAction()}>
            <LiteIcon name={isConfirming ? "loader" : "trash"} />{isConfirming ? tr("Working...") : confirmationCopy.confirmLabel}
          </button>
        </footer>
      </section>
    </div>}
  </section>;
}

function markdownFileName(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "scrypuppy-document"}.md`;
}

function compactSource(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function formatDocumentDate(value: string, language: AppLanguage) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "pt-BR" ? "pt-BR" : "en-US", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}
