import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../../api/tauri";
import { BrandMark } from "../../components/BrandMark";
import { OnboardingTutorial } from "../../components/OnboardingTutorial";
import { liteDefaultSettings } from "../../config/defaultSettings";
import { useLiteWorkspace } from "../../hooks/useLiteWorkspace";
import { useSettingsCoordinator } from "../../hooks/useSettingsCoordinator";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { normalizeLanguage, translate } from "../../i18n";
import type { AiProviderOption, Capture } from "../../types";
import { AddItemsToContextDialog } from "./AddItemsToContextDialog";
import { CaptureDetailsDialog } from "./CaptureDetailsDialog";
import { appInitial, compactContent, formatHotkey, formatRelativeDate } from "./formatters";
import { LiteEmpty } from "./LiteEmpty";
import { LiteDocumentsWorkspace } from "./LiteDocumentsWorkspace";
import { LiteIcon } from "./LiteIcon";
import { LiteSettingsDialog } from "./LiteSettingsDialog";

export function LiteMainApp() {
  const docsPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("docs-preview")
    : null;
  const [activeView, setActiveView] = useState<"captures" | "documents">(
    docsPreview === "documents" ? "documents" : "captures",
  );
  const [requestedDocumentId, setRequestedDocumentId] = useState<string | null>(null);
  const [selectedContextId, setSelectedContextId] = useState<string | null>(
    docsPreview === "context-picker" ? "product-launch" : null,
  );
  const [search, setSearch] = useState("");
  const [magicQuery, setMagicQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"local" | "magic">("local");
  const [detail, setDetail] = useState<Capture | null>(null);
  const [isContextPickerOpen, setIsContextPickerOpen] = useState(docsPreview === "context-picker");
  const [newContextName, setNewContextName] = useState("");
  const [isNewContextOpen, setIsNewContextOpen] = useState(false);
  const [isCreatingContext, setIsCreatingContext] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(docsPreview === "settings");
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("onboarding"),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [aiOptions, setAiOptions] = useState<AiProviderOption[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { captures, contexts, counts, isLoading, refreshAll } = useLiteWorkspace(
    { contextId: selectedContextId, search },
    setStatus,
  );
  const {
    settings,
    patchSettings,
    loadPersisted,
    setPersisted,
    saveState,
    saveError,
    retrySettings,
    awaitPendingSettings,
  } = useSettingsCoordinator(liteDefaultSettings);
  const language = normalizeLanguage(settings.language);
  const selectedContext = contexts.find((context) => context.id === selectedContextId) ?? null;
  const tr = useCallback(
    (english: string, variables?: Record<string, string | number>) => translate(language, english, variables),
    [language],
  );

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    api.getSettings().then((persisted) => {
      loadPersisted(persisted);
      if (!persisted.onboarding_completed) setIsOnboardingOpen(true);
    }).catch((error) => setStatus(String(error)));
    api.getAiProviderOptions().then(setAiOptions).catch((error) => setStatus(String(error)));
  }, [loadPersisted]);

  useEffect(() => {
    setDetail((current) => current
      ? captures.find((capture) => capture.id === current.id) ?? current
      : null);
  }, [captures]);

  useTauriEvent<string>("magic-document-opened", ({ payload }) => {
    setRequestedDocumentId(payload);
    setActiveView("documents");
  });

  async function createContext() {
    const name = newContextName.trim();
    if (!name || isCreatingContext) return;
    setIsCreatingContext(true);
    try {
      const context = await api.createContext(name);
      setNewContextName("");
      setIsNewContextOpen(false);
      setActiveView("captures");
      setSelectedContextId(context.id);
      await refreshAll({ contextId: context.id, search });
    } catch (error) {
      setStatus(String(error));
    } finally {
      setIsCreatingContext(false);
    }
  }

  function cancelCreateContext() {
    if (isCreatingContext) return;
    setNewContextName("");
    setIsNewContextOpen(false);
  }

  async function openDetails(capture: Capture) {
    try {
      setDetail(await api.getCapture(capture.id) ?? capture);
    } catch (error) {
      setStatus(String(error));
    }
  }

  function selectSearchMode(mode: "local" | "magic") {
    setSearchMode(mode);
    if (mode === "local") setActiveView("captures");
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  async function submitSearch() {
    if (searchMode !== "magic" || !magicQuery.trim()) return;
    try {
      await api.openMagicSearchWindow(magicQuery);
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function openNewDocument() {
    try {
      await api.openMagicSearchWindow(undefined, "document");
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function clearAiApiKey() {
    if (!window.confirm(tr("Remove the AI key?"))) return;
    try {
      setPersisted(await api.clearAiApiKey());
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function deleteAllData() {
    if (!window.confirm(tr("Delete all data?"))) return;
    try {
      await api.deleteAllData();
      setDetail(null);
      setSelectedContextId(null);
      setSearch("");
      await refreshAll({ contextId: null, search: "" });
    } catch (error) {
      setStatus(String(error));
    }
  }

  return (
    <main className="lite-app-shell">
      <header className="lite-app-header">
        <div className="lite-header-brand">
          <span className="lite-brand-mark"><BrandMark /></span>
          <span><strong>ScryPuppy</strong><small>{tr("Your useful clipboard")}</small></span>
        </div>

        <form className={`lite-header-search lite-unified-search is-${searchMode}`} onSubmit={(event) => { event.preventDefault(); void submitSearch(); }}>
          <div className="lite-search-modes" role="tablist" aria-label={tr("Search mode")}>
            <button type="button" role="tab" aria-selected={searchMode === "local"} className={searchMode === "local" ? "is-selected" : ""} onClick={() => selectSearchMode("local")}>
              <span>{tr("Local")}</span>
            </button>
            <button type="button" role="tab" aria-selected={searchMode === "magic"} className={searchMode === "magic" ? "is-selected" : ""} onClick={() => selectSearchMode("magic")}>
              <LiteIcon name="sparkles" /><span>Magic Search</span>
            </button>
          </div>
          <div className="lite-search-row">
            <LiteIcon name={searchMode === "magic" ? "sparkles" : "search"} />
            <input
              ref={searchInputRef}
              value={searchMode === "magic" ? magicQuery : search}
              onChange={(event) => {
                if (searchMode === "magic") {
                  setMagicQuery(event.currentTarget.value);
                } else {
                  setActiveView("captures");
                  setSearch(event.currentTarget.value);
                }
              }}
              placeholder={searchMode === "magic" ? tr("What are you looking for?") : tr("Find something you copied...")}
              aria-label={searchMode === "magic" ? tr("Magic Search") : tr("Search history")}
            />
            {(searchMode === "magic" ? magicQuery : search) && <button type="button" onClick={() => searchMode === "magic" ? setMagicQuery("") : setSearch("")} aria-label={tr("Clear search")}><LiteIcon name="close" /></button>}
            {searchMode === "magic" && <button className="lite-search-submit" type="submit" disabled={!magicQuery.trim()} aria-label={tr("Ask ScryPuppy")}>
              <LiteIcon name="sparkles" size={13} /><span>{tr("Ask")}</span>
            </button>}
          </div>
        </form>

        <div className="lite-header-actions">
          <div className="lite-save-state">
            <span aria-hidden="true" />
            <span>{tr("Everything saved")}</span>
          </div>
          <button className="lite-header-settings" onClick={() => setIsSettingsOpen(true)} aria-label={tr("Open settings")} title={tr("Settings")}>
            <LiteIcon name="settings" />
          </button>
        </div>
      </header>

      <aside className="lite-sidebar">
        <nav aria-label={tr("Contexts")}>
          <button className={activeView === "captures" && !selectedContextId ? "is-selected" : ""} onClick={() => { setActiveView("captures"); setSelectedContextId(null); }}>
            <LiteIcon name="layers" /><span>{tr("Everything")}</span><small>{counts.all}</small>
          </button>
          <p>{tr("Contexts")}</p>
          {contexts.map((context) => (
            <button key={context.id} className={activeView === "captures" && selectedContextId === context.id ? "is-selected" : ""} onClick={() => { setActiveView("captures"); setSelectedContextId(context.id); }}>
              <LiteIcon name="folder" /><span>{context.name}</span><small>{context.capture_count}</small>
            </button>
          ))}
        </nav>

        {isNewContextOpen ? <form className="lite-new-context" onSubmit={(event) => { event.preventDefault(); void createContext(); }}>
          <label className="lite-new-context-field">
            <LiteIcon name="folder" size={15} />
            <input
              autoFocus
              value={newContextName}
              disabled={isCreatingContext}
              onChange={(event) => setNewContextName(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Escape") cancelCreateContext(); }}
              placeholder={tr("New context")}
              aria-label={tr("New context name")}
            />
          </label>
          <span className="lite-new-context-actions">
            <button type="button" disabled={isCreatingContext} onClick={cancelCreateContext}>
              {tr("Cancel")}
            </button>
            <button className="is-create" type="submit" disabled={!newContextName.trim() || isCreatingContext}>
              {isCreatingContext && <LiteIcon name="loader" size={13} />}{tr("Create")}
            </button>
          </span>
        </form> : <button className="lite-new-context-trigger" type="button" onClick={() => setIsNewContextOpen(true)}>
          <LiteIcon name="plus" /><span>{tr("New context")}</span>
        </button>}

        <nav className="lite-sidebar-documents" aria-label={tr("Documents")}>
          <p>{tr("Workspace")}</p>
          <button className={activeView === "documents" ? "is-selected" : ""} onClick={() => setActiveView("documents")}>
            <LiteIcon name="file" /><span>{tr("Documents")}</span>
          </button>
        </nav>

      </aside>

      {activeView === "documents" ? <LiteDocumentsWorkspace
        language={language}
        requestedDocumentId={requestedDocumentId}
        status={status}
        onNewDocument={() => void openNewDocument()}
        onStatus={setStatus}
        onClearStatus={() => setStatus(null)}
      /> : <section className="lite-workspace">
        <header className="lite-topbar">
          <div>
            <span className="lite-eyebrow">{selectedContextId ? tr("Context") : tr("Clipboard history")}</span>
            <h1>{selectedContext?.name ?? tr("Everything you copied")}</h1>
          </div>
          {selectedContext && <button className="lite-context-add-button" onClick={() => setIsContextPickerOpen(true)}>
            <LiteIcon name="plus" />{tr("Add items")}
          </button>}
        </header>

        {status && <div className="lite-status"><LiteIcon name="info" /><span>{status}</span><button onClick={() => setStatus(null)}><LiteIcon name="close" /></button></div>}

        <div className={`lite-capture-list ${isLoading ? "is-loading" : ""}`} aria-live="polite">
          {isLoading && captures.length === 0 ? (
            <LiteEmpty icon="loader" title={tr("Loading your history...")} />
          ) : captures.length === 0 ? (
            <LiteEmpty icon="copy" title={tr("Nothing found")} description={tr("Copy something with Ctrl + Shift + C or try another search.")} />
          ) : captures.map((capture) => {
            const imageAsset = capture.assets.find((asset) =>
              asset.path && ["clipboard_image", "imported_image"].includes(asset.kind),
            );
            return <article className={`lite-capture-row ${imageAsset ? "has-image" : ""}`} key={capture.id}>
              {imageAsset?.path ? <button
                className="lite-capture-thumbnail"
                onClick={() => void openDetails(capture)}
                aria-label={tr("View image details")}
                title={tr("View details")}
              >
                <img src={convertFileSrc(imageAsset.path)} alt="" loading="lazy" />
              </button> : <span className="lite-capture-app">{appInitial(capture.source_app_name)}</span>}
              <div className="lite-capture-main">
                <button className="lite-capture-content" onClick={() => api.copyTextToClipboard(capture.content_text).catch((error) => setStatus(String(error)))} title={tr("Copy")}>
                  <strong>{compactContent(capture.content_text)}</strong>
                  <small>{formatRelativeDate(capture.captured_at, language)}</small>
                </button>
                {capture.contexts.length > 0 && <div className="lite-capture-categories" title={capture.contexts.map((context) => context.name).join(", ")}>
                  {capture.contexts.map((context) => <span key={context.id}>{context.name}</span>)}
                </div>}
              </div>
              <button className="lite-icon-button" onClick={() => api.copyTextToClipboard(capture.content_text).catch((error) => setStatus(String(error)))} aria-label={tr("Copy")} title={tr("Copy")}>
                <LiteIcon name="copy" />
              </button>
              <button className="lite-icon-button" onClick={() => void openDetails(capture)} aria-label={tr("View details")} title={tr("View details")}>
                <LiteIcon name="info" />
              </button>
            </article>;
          })}
        </div>
      </section>}

      {detail && <CaptureDetailsDialog capture={detail} contexts={contexts} language={language} onClose={() => setDetail(null)} onChanged={async () => {
        const updated = await api.getCapture(detail.id);
        if (updated) setDetail(updated);
        await refreshAll();
      }} onError={setStatus} />}

      {isContextPickerOpen && selectedContext && <AddItemsToContextDialog
        context={selectedContext}
        language={language}
        totalCaptureCount={counts.all}
        onClose={() => setIsContextPickerOpen(false)}
        onAdded={async (count) => {
          setStatus(tr("Added {count} items to {name}.", { count, name: selectedContext.name }));
          await refreshAll({ contextId: selectedContext.id, search });
        }}
        onError={setStatus}
      />}

      {isOnboardingOpen && <OnboardingTutorial
        tr={tr}
        settings={settings}
        aiOptions={aiOptions}
        captureHotkey={formatHotkey(settings.hotkey)}
        pasteHotkey={formatHotkey(settings.paste_hotkey)}
        onPatch={patchSettings}
        onSaveCredential={(value) => patchSettings({ ai_api_key: value })}
        onClearCredential={clearAiApiKey}
        saveState={saveState}
        saveError={saveError}
        onRetry={retrySettings}
        awaitPending={awaitPendingSettings}
        onFinish={() => setIsOnboardingOpen(false)}
      />}

      {isSettingsOpen && <LiteSettingsDialog
        settings={settings}
        aiOptions={aiOptions}
        language={language}
        saveState={saveState}
        saveError={saveError}
        onPatch={patchSettings}
        onClearCredential={clearAiApiKey}
        onRetry={() => void retrySettings()}
        onDeleteAll={deleteAllData}
        onClose={() => setIsSettingsOpen(false)}
        onOpenTutorial={() => { setIsSettingsOpen(false); setIsOnboardingOpen(true); }}
        onStatus={setStatus}
      />}
    </main>
  );
}
