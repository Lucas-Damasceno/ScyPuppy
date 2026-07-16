import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "./api/tauri";
import { formatAppError, formatAppMessage } from "./appMessages";
import { MarkdownDocument } from "./components/MarkdownDocument";
import { OnboardingTutorial } from "./components/OnboardingTutorial";
import { BrandMark } from "./components/BrandMark";
import { AiControls, ClipboardCaptureControls, QuickContextControls, SettingsSaveFeedback, StartupAndShortcutsControls } from "./components/SettingsControls";
import { useAutoCloseTimer } from "./hooks/useAutoCloseTimer";
import { useSettingsCoordinator } from "./hooks/useSettingsCoordinator";
import { captureDisplayText, normalizeLanguage, translate, translateLegacyGeneratedContent, type AppLanguage } from "./i18n";
import { LiteMagicPalette, LiteMainApp } from "./LiteApp";
import { appDefaultSettings } from "./config/defaultSettings";
import type {
  AiProviderOption, Capture, CaptureAsset, CaptureCreatedEvent, CaptureErrorEvent,
  CaptureUpdatedEvent,
  ApplyContextSuggestion, Category, ChatAnswer, Context, ContextAnalysisResult, LibraryCounts,
  MagicSearchDocument, MagicSearchListItem, MagicSearchRequest, Settings, TagDocument,
} from "./types";
import "./App.css";

const inboxId = "inbox";
const contentBaseId = "content-base";
const pastePageSize = 10;

type ConfirmationOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  eyebrow?: string;
};

function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const isPreview = searchParams.has("paste-preview");
  const label = "__TAURI_INTERNALS__" in window
    ? getCurrentWindow().label
    : searchParams.get("window-label") ?? "main";
  if (label === "quick-context") return <QuickContextPanel />;
  if (label === "magic-search") return <LiteMagicPalette />;
  if (label === "paste" || isPreview) return <PastePalette preview={isPreview} />;
  if (import.meta.env.DEV && searchParams.has("legacy")) return <MainApp />;
  return <LiteMainApp />;
}

function PastePalette({ preview = false }: { preview?: boolean }) {
  const [items, setItems] = useState<Capture[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isPasting, setIsPasting] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const tr = (english: string, variables?: Record<string, string | number>) => translate(language, english, variables);
  const pageCount = Math.max(1, Math.ceil(total / pastePageSize));
  const rangeStart = total === 0 ? 0 : (page * pastePageSize) + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(rangeStart + items.length - 1, total);

  const loadItems = useCallback(async (query: string, pageIndex: number) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const nextPage = preview
        ? (() => {
            const matches = pastePreviewItems.filter((item) =>
              item.content_text.toLowerCase().includes(query.toLowerCase()),
            );
            const offset = pageIndex * pastePageSize;
            return { items: matches.slice(offset, offset + pastePageSize), total: matches.length };
          })()
        : await api.listPasteItems(query, pageIndex, pastePageSize);
      if (requestId !== requestIdRef.current) return;
      setItems(nextPage.items);
      setTotal(nextPage.total);
      setSelectedIndex((current) => Math.min(current, Math.max(0, nextPage.items.length - 1)));
    } catch {
      if (requestId !== requestIdRef.current) return;
      setItems([]);
      setTotal(0);
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [preview]);

  const chooseItem = useCallback(async (item: Capture | undefined) => {
    if (!item || isPasting || preview) return;
    setIsPasting(true);
    try {
      await api.pasteCapture(item.id);
      setSearch("");
    } finally {
      setIsPasting(false);
    }
  }, [isPasting, preview]);

  useEffect(() => {
    document.documentElement.classList.add("paste-window");
    api.getSettings().then((value) => setLanguage(normalizeLanguage(value.language))).catch(() => undefined);
    searchRef.current?.focus();
    return () => document.documentElement.classList.remove("paste-window");
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadItems(search, page), 90);
    return () => window.clearTimeout(timeout);
  }, [loadItems, page, search]);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  useEffect(() => {
    resultsRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [page, search]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listen("paste-palette-opened", () => {
      setSearch("");
      setPage(0);
      setSelectedIndex(0);
      void loadItems("", 0);
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }).then((unlisten) => unlisteners.push(unlisten));
    if (!preview) getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) api.closePastePalette();
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [loadItems, preview]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(current + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(current - 1, 0));
      } else if (event.key === "PageDown" && page < pageCount - 1) {
        event.preventDefault();
        setPage((current) => current + 1);
        setSelectedIndex(0);
      } else if (event.key === "PageUp" && page > 0) {
        event.preventDefault();
        setPage((current) => current - 1);
        setSelectedIndex(0);
      } else if (event.key === "ArrowRight" && pageCount > 1) {
        event.preventDefault();
        if (page < pageCount - 1) {
          setPage((current) => current + 1);
          setSelectedIndex(0);
        }
      } else if (event.key === "ArrowLeft" && pageCount > 1) {
        event.preventDefault();
        if (page > 0) {
          setPage((current) => current - 1);
          setSelectedIndex(0);
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        chooseItem(items[selectedIndex]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        api.closePastePalette();
      } else if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const index = Number(event.key) - 1;
        chooseItem(items[index]);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [chooseItem, items, page, pageCount, selectedIndex]);

  useEffect(() => {
    document.querySelector(".paste-result.is-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <main className="paste-palette-shell">
      <section className="paste-palette" aria-label={tr("Quick paste history")}>
        <header className="paste-palette-header">
          <div className="paste-brand-mark"><BrandMark /></div>
          <div className="paste-search-wrap">
            <Icon name="search" size={15} />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => { setSearch(event.currentTarget.value); setPage(0); setSelectedIndex(0); }}
              placeholder={tr("Search history...")}
              aria-label={tr("Search history")}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <kbd>Esc</kbd>
        </header>

        <div ref={resultsRef} className="paste-results" role="listbox" aria-label={tr("Recent items")} aria-busy={isLoading}>
          {!isLoading && items.length === 0 ? (
            <div className="paste-empty"><Icon name="copy" size={22} /><strong>{tr("No items found")}</strong><span>{tr("Try another search.")}</span></div>
          ) : items.map((item, index) => {
            const imageAsset = item.assets.find((asset) => ["clipboard_image", "imported_image"].includes(asset.kind) && asset.path);
            const contentIcon: IconName | null = item.content_kind === "files"
              ? "folder"
              : item.content_kind === "url"
                ? "link"
                : item.content_kind === "html" || item.content_kind === "rich_text"
                  ? "layers"
                  : null;
            return (
              <button
                className={`paste-result ${index === selectedIndex ? "is-selected" : ""}`}
                key={item.id}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => chooseItem(item)}
                disabled={isPasting || isLoading}
              >
                <span className="paste-result-index">{index + 1}</span>
                {imageAsset?.path ? (
                  <img className="paste-result-image" src={convertFileSrc(imageAsset.path)} alt="" />
                ) : (
                  <span className="paste-result-app">{contentIcon ? <Icon name={contentIcon} size={16} /> : appInitial(item.source_app_name)}</span>
                )}
                <span className="paste-result-copy">
                  <strong>{captureDisplayText(language, item).replace(/\s+/g, " ").trim()}</strong>
                  <span>{item.source_app_name ?? tr("Unknown application")} · {formatListDate(item.captured_at)}</span>
                </span>
                <span className="paste-result-kind">{tr(
                  item.kind === "reference"
                    ? "Reference"
                    : item.content_kind === "files"
                      ? "Files"
                      : item.content_kind === "url"
                        ? "Link"
                        : item.content_kind === "html" || item.content_kind === "rich_text"
                          ? "Rich content"
                          : item.content_kind === "image"
                            ? "Image capture"
                            : "Capture",
                )}</span>
              </button>
            );
          })}
        </div>

        <footer className={`paste-palette-footer ${pageCount > 1 ? "has-pagination" : ""}`}>
          {pageCount > 1 ? (
            <nav className="paste-pagination" aria-label={tr("Pagination")}>
              <button
                type="button"
                className="is-previous"
                disabled={page === 0 || isLoading}
                onClick={() => { setPage((current) => current - 1); setSelectedIndex(0); }}
                aria-label={tr("Previous page")}
                title={tr("Previous page")}
              >
                <Icon name="chevron" size={12} />
              </button>
              <span aria-label={tr("Showing {start}-{end} of {total}", { start: rangeStart, end: rangeEnd, total })}>
                {rangeStart}-{rangeEnd} / {total}
              </span>
              <button
                type="button"
                disabled={page >= pageCount - 1 || isLoading}
                onClick={() => { setPage((current) => current + 1); setSelectedIndex(0); }}
                aria-label={tr("Next page")}
                title={tr("Next page")}
              >
                <Icon name="chevron" size={12} />
              </button>
            </nav>
          ) : null}
          <div className="paste-shortcuts">
            <span><kbd>↑</kbd><kbd>↓</kbd> {tr("navigate")}</span>
            <span><kbd>Enter</kbd> {tr("paste")}</span>
            {pageCount > 1
              ? <span><kbd>←</kbd><kbd>→</kbd> {tr("pages")}</span>
              : <span><kbd>Ctrl</kbd><kbd>1–9</kbd> {tr("quick access")}</span>}
          </div>
        </footer>
      </section>
    </main>
  );
}

const pastePreviewItems = [
  { id: "preview-1", content_text: "https://github.com/Lucas-Damasceno/DamascDoc", source_app_name: "Google Chrome", captured_at: new Date().toISOString(), kind: "capture", assets: [] },
  { id: "preview-2", content_text: "Refactor the capture flow and review the database migrations", source_app_name: "Visual Studio Code", captured_at: new Date(Date.now() - 420_000).toISOString(), kind: "capture", assets: [] },
  { id: "preview-3", content_text: "Ctrl + Shift + V opens ScryPuppy's quick history", source_app_name: "ScryPuppy", captured_at: new Date(Date.now() - 3_600_000).toISOString(), kind: "reference", assets: [] },
] as unknown as Capture[];

const defaultSettings = appDefaultSettings;

function QuickContextPanel() {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [contexts, setContexts] = useState<Context[]>([]);
  const [recentContexts, setRecentContexts] = useState<Context[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const [search, setSearch] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [autoCloseCycle, setAutoCloseCycle] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [savingContextId, setSavingContextId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef<string | null>(null);
  const tr = (english: string) => translate(language, english);

  const reloadChoices = useCallback(async () => {
    const [workspace, recent] = await Promise.all([
      api.loadWorkspace({ context_id: null, search: null, tag: null, limit: 1, offset: 0 }),
      api.recentContexts().catch(() => []),
    ]);
    setContexts(workspace.contexts);
    setRecentContexts(recent);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("quick-context-window");
    api.getSettings().then((value) => { setSettings(value); setLanguage(normalizeLanguage(value.language)); }).catch(() => undefined);
    reloadChoices().catch(() => undefined);
    const unlisteners: Array<() => void> = [];
    listen<CaptureCreatedEvent>("quick-context-capture", ({ payload }) => {
      generation.current = payload.capture.id;
      setCapture(payload.capture);
      setSearch("");
      setActiveOption(0);
      setSavingContextId(null);
      setError(null);
      api.getSettings().then((value) => { setSettings(value); setLanguage(normalizeLanguage(value.language)); }).catch(() => undefined);
      reloadChoices().catch(() => undefined);
    }).then((unlisten) => unlisteners.push(unlisten));
    listen<Settings>("settings-updated", ({ payload }) => {
      setSettings(payload);
      setLanguage(normalizeLanguage(payload.language));
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => { document.documentElement.classList.remove("quick-context-window"); unlisteners.forEach((unlisten) => unlisten()); };
  }, [reloadChoices]);

  const captureId = capture?.id ?? null;
  const registerInteraction = useCallback(() => {
    setAutoCloseCycle((current) => current + 1);
  }, []);
  const closeAfterDelay = useCallback(() => {
    if (captureId && generation.current === captureId) {
      void api.closeQuickContext();
    }
  }, [captureId]);
  useAutoCloseTimer({
    enabled: Boolean(captureId),
    delaySeconds: settings.quick_context_timeout_seconds,
    paused: Boolean(savingContextId),
    resetKey: autoCloseCycle,
    onElapsed: closeAfterDelay,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") api.closeQuickContext(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function toggleContext(context: Context) {
    const currentId = capture?.id;
    if (!currentId || savingContextId) return;
    const assigned = capture.contexts.some((item) => item.id === context.id);
    setSavingContextId(context.id);
    setError(null);
    try {
      if (assigned) await api.removeCaptureContext(currentId, context.id);
      else await api.addCaptureContexts(currentId, [context.id]);
      if (generation.current !== currentId) return;
      const updated = await api.getCapture(currentId);
      if (updated && generation.current === currentId) setCapture(updated);
      reloadChoices().catch(() => undefined);
    } catch (reason) { if (generation.current === currentId) setError(formatAppError(reason, tr)); }
    finally { if (generation.current === currentId) setSavingContextId(null); }
  }

  async function createInline() {
    const name = search.trim();
    if (!name || !capture || savingContextId) return;
    setSavingContextId("create");
    setError(null);
    try {
      const context = await api.createContext(name);
      await api.addCaptureContexts(capture.id, [context.id]);
      const updated = await api.getCapture(capture.id);
      if (updated && generation.current === capture.id) setCapture(updated);
      setSearch("");
      setActiveOption(0);
      await reloadChoices();
    } catch (reason) { setError(formatAppError(reason, tr)); }
    finally { setSavingContextId(null); }
  }

  if (!capture) return <main className="quick-context-shell" />;
  const normalizedSearch = search.trim().toLowerCase();
  const defaultChoices = settings.quick_context_show_recent && recentContexts.length > 0
    ? [...capture.contexts, ...recentContexts].filter((context, index, values) => values.findIndex((item) => item.id === context.id) === index)
    : contexts;
  const choicePool = normalizedSearch ? contexts : defaultChoices;
  const filtered = choicePool.filter((context) => context.name.toLowerCase().includes(normalizedSearch));
  const visibleContexts = filtered.slice(0, settings.quick_context_show_preview ? 4 : 6);
  const canCreate = Boolean(search.trim()) && !contexts.some((context) => context.normalized_name === search.trim().toLowerCase());
  const optionCount = visibleContexts.length + (canCreate ? 1 : 0);
  const isImageCapture = capture.content_kind === "image" || capture.assets.some((asset) => ["clipboard_image", "imported_image"].includes(asset.kind));
  const isFileCapture = capture.content_kind === "files";

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!optionCount) return;
      setActiveOption((current) => event.key === "ArrowDown" ? (current + 1) % optionCount : (current - 1 + optionCount) % optionCount);
    } else if (event.key === "Enter" && optionCount) {
      event.preventDefault();
      if (activeOption < visibleContexts.length) toggleContext(visibleContexts[activeOption]);
      else createInline();
    }
  }

  return (
    <main className="quick-context-shell">
      <section className="quick-context-panel" aria-label={tr("Quick context panel")} onPointerDownCapture={registerInteraction} onKeyDownCapture={registerInteraction} onFocusCapture={registerInteraction}>
        <header>
          <div className="quick-context-brand"><BrandMark /></div>
          <div className="quick-context-title"><span><Icon name="check" size={11} />{tr("Capture saved")}</span><strong>{capture.source_app_name ?? tr("Unknown application")}</strong></div>
          <button className="quick-context-close" onClick={() => api.closeQuickContext()} aria-label={tr("Close")}><Icon name="close" size={14} /></button>
        </header>
        <div className="quick-context-body">
          {settings.quick_context_show_preview && <div className="quick-context-preview">
            <span className="quick-context-preview-icon"><Icon name={isImageCapture ? "image" : isFileCapture ? "folder" : "copy"} size={15} /></span>
            <span className="quick-context-preview-copy"><strong>{tr(isImageCapture ? "Image capture" : isFileCapture ? "Captured files" : "Capture")}</strong><small>{captureDisplayText(language, capture).replace(/^\[|\]$/g, "")}</small></span>
          </div>}
          <div className="quick-context-search"><Icon name="search" size={14} /><input value={search} onChange={(event) => { setSearch(event.currentTarget.value); setActiveOption(0); }} onKeyDown={handleSearchKeyDown} onFocus={() => setIsSearching(true)} onBlur={() => setIsSearching(false)} placeholder={tr("Search or create a context")} aria-label={tr("Search contexts")} aria-controls="quick-context-options" aria-expanded={Boolean(search.trim() || isSearching)} autoComplete="off" spellCheck={false} />{search && <button onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearch(""); setActiveOption(0); }} aria-label={tr("Clear search")}><Icon name="close" size={12} /></button>}</div>
          <div className="quick-context-section-label"><span>{tr(normalizedSearch ? "Available contexts" : settings.quick_context_show_recent ? "Recent contexts" : "Contexts")}</span>{capture.contexts.length > 0 && <small>{capture.contexts.length} {tr("Assigned contexts").toLowerCase()}</small>}</div>
          <div id="quick-context-options" className="quick-context-options" role="listbox">
            {visibleContexts.map((context, index) => {
              const assigned = capture.contexts.some((item) => item.id === context.id);
              return <button key={context.id} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveOption(index)} onClick={() => toggleContext(context)} disabled={Boolean(savingContextId)} className={`${assigned ? "is-selected" : ""} ${activeOption === index ? "is-active" : ""}`} role="option" aria-selected={assigned} aria-label={`${tr(assigned ? "Remove context" : "Add to this capture")}: ${context.name}`}><span className="quick-context-option-name"><Icon name="folder" size={13} /><span>{context.name}</span></span><span className="quick-context-option-action" aria-hidden="true">{savingContextId === context.id ? <Icon name="loader" size={13} /> : <Icon name={assigned ? "check" : "plus"} size={13} />}</span></button>;
            })}
            {canCreate && <button onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveOption(visibleContexts.length)} onClick={createInline} disabled={Boolean(savingContextId)} className={`quick-context-create ${activeOption === visibleContexts.length ? "is-active" : ""}`} role="option" aria-selected={false}><span className="quick-context-option-name"><Icon name="plus" size={13} /><span>{tr("Create context")} <strong>{search.trim()}</strong></span></span><Icon name="arrow" size={13} /></button>}
            {!optionCount && <p className="quick-context-empty">{tr("No matching contexts")}</p>}
          </div>
          {error && <p className="quick-context-error" role="alert"><Icon name="info" size={12} />{tr(error)}</p>}
        </div>
        <footer><span className="quick-context-save-state" aria-live="polite">{savingContextId ? <Icon name="loader" size={12} /> : <Icon name="check" size={12} />} {tr(savingContextId ? "Saving..." : "Saved locally")}</span><button onClick={() => api.closeQuickContext()} disabled={Boolean(savingContextId)}>{tr("Done")}</button></footer>
      </section>
    </main>
  );
}

function MainApp() {
  const [contexts, setContexts] = useState<Context[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [counts, setCounts] = useState<LibraryCounts>({ all: 0, inbox: 0, content_base: 0 });
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedContextId, setSelectedContextId] = useState<string>(inboxId);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const {
    settings,
    patchSettings,
    loadPersisted,
    setPersisted,
    saveState,
    saveError,
    retrySettings,
    awaitPendingSettings,
  } = useSettingsCoordinator(defaultSettings);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<"local" | "ai">("local");
  const [newContextName, setNewContextName] = useState("");
  const [status, setStatus] = useState("Initializing...");
  const [aiOptions, setAiOptions] = useState<AiProviderOption[]>([]);
  const [chatQuery, setChatQuery] = useState("");
  const [chatAnswer, setChatAnswer] = useState<ChatAnswer | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);
  const [isOrganizeOpen, setIsOrganizeOpen] = useState(false);
  const [organizeDays, setOrganizeDays] = useState(30);
  const [organizeWithAi, setOrganizeWithAi] = useState(false);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizeResult, setOrganizeResult] = useState<ContextAnalysisResult | null>(null);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());
  const [organizeCaptureMap, setOrganizeCaptureMap] = useState<Record<string, Capture>>({});
  const [sidebarContextSearch, setSidebarContextSearch] = useState("");
  const [contextPickerSearch, setContextPickerSearch] = useState("");
  const [isContextPickerOpen, setIsContextPickerOpen] = useState(false);
  const [isDeletingAllData, setIsDeletingAllData] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<CaptureAsset | null>(null);
  const [tagViewMode, setTagViewMode] = useState<"simple" | "document">("simple");
  const [tagDocument, setTagDocument] = useState<TagDocument | null>(null);
  const [isTagDocumentLoading, setIsTagDocumentLoading] = useState(false);
  const [magicDocument, setMagicDocument] = useState<MagicSearchDocument | null>(null);
  const [magicHistory, setMagicHistory] = useState<MagicSearchListItem[]>([]);
  const [isMagicOpen, setIsMagicOpen] = useState(false);
  const [isMagicGenerating, setIsMagicGenerating] = useState(false);
  const [isSensitiveValueRevealed, setIsSensitiveValueRevealed] = useState(false);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationOptions | null>(null);
  const confirmationResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const refreshRequestId = useRef(0);
  const tagDocumentRequestId = useRef(0);
  const magicRequestId = useRef(0);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const language = normalizeLanguage(settings?.language);
  const tr = (english: string, variables?: Record<string, string | number>) => translate(language, english, variables);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const requestConfirmation = useCallback((options: ConfirmationOptions) => {
    confirmationResolver.current?.(false);
    setConfirmation(options);
    return new Promise<boolean>((resolve) => {
      confirmationResolver.current = resolve;
    });
  }, []);

  const closeConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => () => confirmationResolver.current?.(false), []);

  const selectedCapture = useMemo(
    () => captures.find((capture) => capture.id === selectedCaptureId) ?? captures[0] ?? null,
    [captures, selectedCaptureId],
  );

  const normalizedContextPickerSearch = contextPickerSearch.trim().toLowerCase();
  const availableContextOptions = contexts.filter((context) =>
    !selectedCapture?.contexts.some((assigned) => assigned.id === context.id)
    && context.name.toLowerCase().includes(normalizedContextPickerSearch),
  );
  const contextPickerHasExactMatch = contexts.some((context) =>
    context.normalized_name === normalizedContextPickerSearch,
  );
  const exactAvailableContext = availableContextOptions.find((context) =>
    context.normalized_name === normalizedContextPickerSearch,
  );

  useEffect(() => {
    if (!isContextPickerOpen) return;

    function closePicker(event: MouseEvent) {
      if (!contextPickerRef.current?.contains(event.target as Node)) {
        setIsContextPickerOpen(false);
        setContextPickerSearch("");
      }
    }

    function closePickerWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsContextPickerOpen(false);
        setContextPickerSearch("");
      }
    }

    document.addEventListener("mousedown", closePicker);
    document.addEventListener("keydown", closePickerWithEscape);
    return () => {
      document.removeEventListener("mousedown", closePicker);
      document.removeEventListener("keydown", closePickerWithEscape);
    };
  }, [isContextPickerOpen]);

  useEffect(() => {
    setIsContextPickerOpen(false);
    setContextPickerSearch("");
  }, [selectedCaptureId]);

  const selectedContext = contexts.find((context) => context.id === selectedContextId);
  const scopeTitle = selectedContextId === "all"
    ? tr("All captures")
    : selectedContextId === contentBaseId
      ? tr("Content Base")
      : selectedContextId === inboxId ? "Inbox" : selectedContext?.name ?? tr("Contexts");

  const refresh = useCallback(async (nextContextId = selectedContextId) => {
    const requestId = ++refreshRequestId.current;
    const filter = {
      context_id: nextContextId === "all" ? null : nextContextId,
      search: search.trim() || null,
      tag: selectedCategory,
      limit: 200,
      offset: 0,
    };

    const result = await api.loadWorkspace(filter);
    if (requestId !== refreshRequestId.current) return;

    setContexts(result.contexts);
    setCategories(result.categories);
    setCounts(result.counts);
    setCaptures(result.captures);
    setSelectedCaptureId((current) => {
      if (current && result.captures.some((capture) => capture.id === current)) {
        return current;
      }
      return result.captures[0]?.id ?? null;
    });
    setStatus("Ready");
  }, [search, selectedCategory, selectedContextId]);

  useEffect(() => {
    api.getSettings()
      .then((value) => {
        loadPersisted(value);
        if (!value.onboarding_completed) setIsOnboardingOpen(true);
      })
      .catch((error) => setStatus(formatAppError(error, tr)));
    api.getAiProviderOptions()
      .then(setAiOptions)
      .catch((error) => setStatus(formatAppError(error, tr)));
    api.listMagicSearches().then(setMagicHistory).catch(() => undefined);
  }, []);

  useEffect(() => {
    const requestId = ++tagDocumentRequestId.current;
    if (!selectedCategory) {
      setTagDocument(null);
      setTagViewMode("simple");
      setIsTagDocumentLoading(false);
      return;
    }
    setIsTagDocumentLoading(true);
    api.getTagDocument(selectedCategory)
      .then((document) => {
        if (requestId === tagDocumentRequestId.current) setTagDocument(document);
      })
      .catch((error) => {
        if (requestId === tagDocumentRequestId.current) setStatus(formatAppError(error, tr));
      })
      .finally(() => {
        if (requestId === tagDocumentRequestId.current) setIsTagDocumentLoading(false);
      });
    return () => {
      if (requestId === tagDocumentRequestId.current) tagDocumentRequestId.current += 1;
    };
  }, [language, selectedCategory]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      refresh().catch((error) => setStatus(formatAppError(error, tr)));
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [refresh]);

  useEffect(() => {
    if (!previewAsset) return;

    function handlePreviewEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPreviewAsset(null);
    }

    document.addEventListener("keydown", handlePreviewEscape);
    return () => document.removeEventListener("keydown", handlePreviewEscape);
  }, [previewAsset]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen<CaptureCreatedEvent>("capture-created", (event) => {
      const isAutomatic = event.payload.origin === "clipboard_monitor";
      const isReference = event.payload.capture.kind === "reference";
      setStatus(isAutomatic
        ? "Clipboard copy registered automatically."
        : isReference ? "Reference saved to the Content Base." : "Capture saved with the global shortcut.");
      if (isAutomatic) {
      refresh().catch((error) => setStatus(formatAppError(error, tr)));
        return;
      }
      setSelectedContextId(isReference ? contentBaseId : inboxId);
      setSelectedCaptureId(event.payload.capture.id);
      refresh(isReference ? contentBaseId : inboxId).catch((error) => setStatus(formatAppError(error, tr)));
    }).then((unlisten) => unlisteners.push(unlisten));

    listen<CaptureErrorEvent>("capture-error", (event) => {
      setStatus(formatAppMessage(event.payload.error, tr));
    }).then((unlisten) => unlisteners.push(unlisten));

    listen<CaptureUpdatedEvent>("capture-analysis-updated", () => {
      refresh().catch((error) => setStatus(formatAppError(error, tr)));
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [refresh]);

  async function organizeCaptures() {
    setIsOrganizing(true);
    setStatus("Organizing captures from the selected period...");
    try {
      const result = await api.analyzeContexts(organizeDays, organizeWithAi);
      setOrganizeResult(result);
      setSelectedSuggestionIds(new Set(result.suggestions.map((suggestion) => suggestion.id)));
      const ids = [...new Set(result.suggestions.flatMap((suggestion) => suggestion.capture_ids))];
      const loaded = await Promise.all(ids.map((id) => api.getCapture(id)));
      setOrganizeCaptureMap(Object.fromEntries(loaded.filter((capture): capture is Capture => Boolean(capture)).map((capture) => [capture.id, capture])));
      setStatus("Context suggestions ready for review.");
    } catch (error) {
      setStatus(formatAppError(error, tr));
    } finally {
      setIsOrganizing(false);
    }
  }

  async function createContext() {
    if (!newContextName.trim()) return;
    try {
      const context = await api.createContext(newContextName);
      setNewContextName("");
      setSelectedContextId(context.id);
      await refresh(context.id);
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function renameContext(context: Context) {
    const name = window.prompt(tr("New context name"), context.name);
    if (!name || !name.trim()) return;
    try {
      await api.renameContext(context.id, name);
      await refresh(context.id);
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function deleteContext(context: Context) {
    if (context.id === inboxId) return;
    const confirmed = await requestConfirmation({
      title: tr("Delete “{name}”?", { name: context.name }),
      message: tr("Captures in this context will be preserved and moved to Inbox."),
      confirmLabel: tr("Delete context"),
    });
    if (!confirmed) return;
    try {
      await api.deleteContext(context.id);
      setSelectedContextId(inboxId);
      await refresh(inboxId);
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function addSelectedCaptureToContext(contextId: string) {
    if (!selectedCapture) return;
    try {
      await api.addCaptureContexts(selectedCapture.id, [contextId]);
      setContextPickerSearch("");
      await refresh(selectedContextId);
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function deleteSelectedCapture() {
    if (!selectedCapture) return;
    const confirmed = await requestConfirmation({
      title: tr("Delete this capture?"),
      message: tr("The content, metadata, and associated files will be permanently removed."),
      confirmLabel: tr("Delete capture"),
    });
    if (!confirmed) return;
    try {
      await api.deleteCapture(selectedCapture.id);
      await refresh(selectedContextId);
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function resyncMarkdown() {
    try {
      await api.resyncContexts();
      setStatus("Markdown resynchronized.");
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  function updateSettings(patch: Partial<Settings>) {
    return patchSettings(patch);
  }

  async function askChat() {
    if (!chatQuery.trim()) return;
    setIsAsking(true);
    setStatus("Searching local evidence...");
    try {
      const answer = await api.askChat({
          query: chatQuery,
          context_id: selectedContextId === "all" ? null : selectedContextId,
          app: null,
          date_from: null,
          date_to: null,
          limit: 8,
      });
      setChatAnswer(answer);
      setStatus("Local answer generated.");
    } catch (error) {
      setStatus(formatAppError(error, tr));
    } finally {
      setIsAsking(false);
    }
  }

  async function removeSelectedCaptureContext(contextId: string) {
    if (!selectedCapture) return;
    try {
      await api.removeCaptureContext(selectedCapture.id, contextId);
      await refresh(selectedContextId);
    } catch (error) { setStatus(formatAppError(error, tr)); }
  }

  async function createContextForSelectedCapture() {
    const name = contextPickerSearch.trim();
    if (!name || !selectedCapture) return;
    try {
      const context = await api.createContext(name);
      await api.addCaptureContexts(selectedCapture.id, [context.id]);
      setContextPickerSearch("");
      await refresh(selectedContextId);
    } catch (error) { setStatus(formatAppError(error, tr)); }
  }

  async function applyOrganization() {
    if (!organizeResult) return;
    setIsOrganizing(true);
    try {
      const selected: ApplyContextSuggestion[] = organizeResult.suggestions
        .filter((suggestion) => selectedSuggestionIds.has(suggestion.id) && suggestion.capture_ids.length > 0)
        .map((suggestion) => ({ suggestion_id: suggestion.id, name: suggestion.name, existing_context_id: suggestion.existing_context_id, capture_ids: suggestion.capture_ids, confidence: suggestion.confidence }));
      const result = await api.applyContextSuggestions(selected);
      setStatus(`${result.associations_added} context associations added; ${result.contexts_created} contexts created.`);
      setIsOrganizeOpen(false);
      setOrganizeResult(null);
      await refresh("all");
    } catch (error) { setStatus(formatAppError(error, tr)); } finally { setIsOrganizing(false); }
  }

  function toggleSuggestion(id: string, selected: boolean) {
    setSelectedSuggestionIds((current) => { const next = new Set(current); if (selected) next.add(id); else next.delete(id); return next; });
  }

  function updateSuggestion(id: string, patch: Partial<ContextAnalysisResult["suggestions"][number]>) {
    setOrganizeResult((current) => current ? { ...current, suggestions: current.suggestions.map((suggestion) => suggestion.id === id ? { ...suggestion, ...patch } : suggestion) } : current);
  }

  function removeSuggestionCapture(suggestionId: string, captureId: string) {
    const suggestion = organizeResult?.suggestions.find((item) => item.id === suggestionId);
    if (suggestion) updateSuggestion(suggestionId, { capture_ids: suggestion.capture_ids.filter((id) => id !== captureId) });
  }

  async function runMagicSearch(
    previousDocumentId: string | null = null,
    queryOverride?: string,
    filtersOverride?: MagicSearchRequest,
  ) {
    const query = (queryOverride ?? chatQuery).trim();
    if (!query) return;
    const requestId = ++magicRequestId.current;
    setIsMagicGenerating(true);
    setMagicError(null);
    setIsMagicOpen(true);
    try {
      const document = await api.generateMagicSearch({
        ...filtersOverride,
        query,
        context_id: filtersOverride ? filtersOverride.context_id : (selectedContextId === "all" ? null : selectedContextId),
        tag: filtersOverride ? filtersOverride.tag : selectedCategory,
        date_from: filtersOverride ? filtersOverride.date_from : null,
        date_to: filtersOverride ? filtersOverride.date_to : null,
        limit: filtersOverride ? filtersOverride.limit : 24,
        previous_document_id: previousDocumentId,
      });
      if (requestId !== magicRequestId.current) return;
      setMagicDocument(document);
      setIsSensitiveValueRevealed(false);
      const history = await api.listMagicSearches();
      if (requestId !== magicRequestId.current) return;
      setMagicHistory(history);
      setStatus("Magic Search complete.");
    } catch (error) {
      if (requestId !== magicRequestId.current) return;
      setMagicError(formatAppError(error, tr));
      setStatus(formatAppError(error, tr));
    } finally {
      if (requestId === magicRequestId.current) setIsMagicGenerating(false);
    }
  }

  async function openMagicSearch(id: string) {
    const requestId = ++magicRequestId.current;
    setIsMagicOpen(true);
    setIsMagicGenerating(true);
    try {
      const document = await api.getMagicSearch(id);
      if (requestId !== magicRequestId.current) return;
      setMagicDocument(document);
      setIsSensitiveValueRevealed(false);
      setMagicError(null);
    } catch (error) {
      if (requestId !== magicRequestId.current) return;
      setMagicError(formatAppError(error, tr));
    } finally {
      if (requestId === magicRequestId.current) setIsMagicGenerating(false);
    }
  }

  async function openMagicLibrary() {
    setSearchMode("ai");
    setIsMagicOpen(true);
    if (!magicDocument && magicHistory[0]) await openMagicSearch(magicHistory[0].id);
  }

  async function exportCurrentMagicSearch() {
    if (!magicDocument) return;
    try {
      const path = await api.exportMagicSearch(magicDocument.id);
      setStatus(tr("Document exported to {path}", { path }));
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function exportCurrentTag() {
    if (!selectedCategory) return;
    try {
      const path = await api.exportTagDocument(selectedCategory);
      setStatus(tr("Tag exported to {path}", { path }));
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  function selectContext(contextId: string) {
    setSelectedContextId(contextId);
  }

  async function clearAiApiKey() {
    const confirmed = await requestConfirmation({
      title: tr("Remove the AI key?"),
      message: tr("The credential will be deleted from Windows Credential Manager. You can configure it again later."),
      confirmLabel: tr("Remove key"),
      eyebrow: tr("Protected credential"),
    });
    if (!confirmed) return;
    try {
      const next = await api.clearAiApiKey();
      setPersisted(next);
      setStatus("AI key removed from Windows Credential Manager.");
    } catch (error) {
      setStatus(formatAppError(error, tr));
    }
  }

  async function deleteAllData() {
    const confirmed = await requestConfirmation({
      title: tr("Delete all data?"),
      message: tr("Captures, references, images, encrypted contexts, legacy Markdown, and the AI key will be removed. This action cannot be undone."),
      confirmLabel: tr("Delete all data"),
    });
    if (!confirmed) return;
    setIsDeletingAllData(true);
    try {
      await api.deleteAllData();
      setSelectedContextId(inboxId);
      setSelectedCategory(null);
      setSelectedCaptureId(null);
      setChatAnswer(null);
      await refresh(inboxId);
      setStatus("All local data permanently deleted.");
    } catch (error) {
      setStatus(formatAppError(error, tr));
    } finally {
      setIsDeletingAllData(false);
    }
  }

  function selectCategory(tag: string | null) {
    setSelectedCategory(tag);
  }

  async function openEvidence(captureId: string) {
    setSelectedContextId("all");
    setSelectedCategory(null);
    await refresh("all");
    setSelectedCaptureId(captureId);
  }

  return (
    <main className="app-window">
      <header className="titlebar">
        <div className="brand-lockup">
          <div className="brand-mark"><BrandMark /></div>
          <div>
            <strong>ClipScry</strong>
            <span>{tr("Local work memory")}</span>
          </div>
        </div>
        <div className="global-search-wrap">
          <form
            className={`global-search ${searchMode === "ai" ? "is-ai" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (searchMode === "ai") runMagicSearch();
            }}
          >
            <div className="search-mode" aria-label={tr("Search mode")}>
              <button
                type="button"
                className={searchMode === "local" ? "is-selected" : ""}
                onClick={() => {
                  setSearchMode("local");
                }}
              >
                {tr("Local")}
              </button>
              <button
                type="button"
                className={searchMode === "ai" ? "is-selected" : ""}
                onClick={() => {
                  setSearchMode("ai");
                  if (magicDocument) setIsMagicOpen(true);
                }}
              >
                <Icon name="sparkles" size={12} /> Magic Search
              </button>
            </div>
            <Icon name={searchMode === "ai" ? "sparkles" : "search"} size={15} />
            <input
              value={searchMode === "ai" ? chatQuery : search}
              onChange={(event) => {
                if (searchMode === "ai") {
                  setChatQuery(event.currentTarget.value);
                  setChatAnswer(null);
                } else {
                  setSearch(event.currentTarget.value);
                }
              }}
              placeholder={searchMode === "ai" ? tr("What would you like to consolidate?") : tr("Search captures...")}
              aria-label={searchMode === "ai" ? "Magic Search" : tr("Local search")}
            />
            {(searchMode === "ai" ? chatQuery : search) && !isMagicGenerating && (
              <button
                type="button"
                className="global-search-clear"
                onClick={() => {
                  if (searchMode === "ai") {
                    setChatQuery("");
                    setChatAnswer(null);
                  } else {
                    setSearch("");
                  }
                }}
                aria-label={tr("Clear search")}
              >
                <Icon name="close" size={12} />
              </button>
            )}
            {searchMode === "ai" && (
              <button className="global-search-submit" type="submit" disabled={isMagicGenerating || !chatQuery.trim()} aria-label={tr("Generate Magic Search")}>
                <Icon name={isMagicGenerating ? "loader" : "arrow"} size={14} />
              </button>
            )}
          </form>
        </div>
        <div className="titlebar-actions">
          <div className="status-indicator" title={tr(status)}>
            <span className={status === "Ready" ? "status-dot ready" : "status-dot"} />
            <span>{status === "Ready" ? tr("Everything saved") : tr(status)}</span>
          </div>
          <button
            className="icon-button"
            onClick={() => setIsSettingsOpen(true)}
            aria-label={tr("Open settings")}
            title={tr("Settings")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className={`workspace ${selectedCategory && tagViewMode === "document" ? "tag-document-workspace" : ""}`}>
        <aside className="sidebar">
          <nav className="sidebar-nav" aria-label={tr("Library")}>
            <p className="sidebar-label">{tr("Library")}</p>
            <button
              className={`sidebar-item ${selectedContextId === "all" && !selectedCategory ? "is-selected" : ""}`}
              onClick={() => {
                setSelectedCategory(null);
                selectContext("all");
              }}
            >
              <Icon name="library" />
              <span>{tr("All captures")}</span>
              <small>{counts.all}</small>
            </button>
            <button
              className={`sidebar-item ${selectedContextId === inboxId && !selectedCategory ? "is-selected" : ""}`}
              onClick={() => {
                setSelectedCategory(null);
                selectContext(inboxId);
              }}
            >
              <Icon name="inbox" />
              <span>Inbox</span>
              <small>{counts.inbox}</small>
            </button>
            <button
              className={`sidebar-item content-base-item ${selectedContextId === contentBaseId && !selectedCategory ? "is-selected" : ""}`}
              onClick={() => {
                setSelectedCategory(null);
                selectContext(contentBaseId);
              }}
            >
              <Icon name="database" />
              <span>{tr("Content Base")}</span>
              <small>{counts.content_base}</small>
            </button>
            <button className="sidebar-item magic-sidebar-item" onClick={openMagicLibrary}>
              <Icon name="sparkles" />
              <span>Magic Search</span>
              <small>{magicHistory.length}</small>
            </button>
          </nav>

          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <p className="sidebar-label">{tr("Contexts")}</p>
              <button className="mini-action" onClick={() => { setOrganizeResult(null); setIsOrganizeOpen(true); }} title={tr("Organize contexts")}><Icon name="sparkles" size={14} /></button>
            </div>
            {contexts.length > 8 && <input className="sidebar-context-search" value={sidebarContextSearch} onChange={(event) => setSidebarContextSearch(event.currentTarget.value)} placeholder={tr("Search contexts")} aria-label={tr("Search contexts")} />}
            <div className="context-list">
              {contexts.filter((context) => context.name.toLowerCase().includes(sidebarContextSearch.toLowerCase())).map((context) => (
                <div className="context-row" key={context.id}>
                  <button
                    className={`sidebar-item ${selectedContextId === context.id ? "is-selected" : ""}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); const captureId = event.dataTransfer.getData("text/clipscry-capture"); if (captureId) api.addCaptureContexts(captureId, [context.id]).then(() => refresh(selectedContextId)).catch((error) => setStatus(formatAppError(error, tr))); }}
                    onClick={() => {
                      setSelectedCategory(null);
                      selectContext(context.id);
                    }}
                  >
                    <Icon name="folder" />
                    <span>{context.name}</span>
                    <small>{context.capture_count}</small>
                  </button>
                  <div className="context-actions">
                    <button onClick={() => renameContext(context)} aria-label={tr("Rename {name}", { name: context.name })}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button onClick={() => deleteContext(context)} aria-label={tr("Delete {name}", { name: context.name })}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {contexts.length === 0 && <p className="sidebar-empty-guidance">{tr("Create a context to group related captures.")}</p>}
            </div>
            <form
              className="new-context-form"
              onSubmit={(event) => {
                event.preventDefault();
                createContext();
              }}
            >
              <Icon name="plus" size={14} />
              <input
                value={newContextName}
                onChange={(event) => setNewContextName(event.currentTarget.value)}
                placeholder={tr("New context")}
                aria-label={tr("Enter a new context name")}
              />
              {newContextName.trim() && <button type="submit">{tr("Create")}</button>}
            </form>
          </section>

          {categories.length > 0 && (
            <section className="sidebar-section categories-section">
              <div className="sidebar-section-header">
                <p className="sidebar-label">{tr("Contexts")}</p>
                <button className="mini-action" onClick={() => setIsCategoriesOpen(true)} title={tr("View all contexts")} aria-label={tr("View all contexts")}><Icon name="grid" size={14} /></button>
              </div>
              <div className="category-list">
                {categories.slice(0, 8).map((category) => (
                  <button
                    className={selectedCategory === category.tag ? "is-selected" : ""}
                    key={category.tag}
                    onClick={() => {
                      setSelectedContextId("all");
                      selectCategory(selectedCategory === category.tag ? null : category.tag);
                    }}
                  >
                    <span className="tag-dot" />
                    <span>{tr(category.tag)}</span>
                    <small>{category.capture_count}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="sidebar-footer">
            <button className="sidebar-settings" onClick={() => setIsSettingsOpen(true)}>
              <Icon name="settings" />
              <span>{tr("Settings")}</span>
            </button>
            <p>{tr("Your data stays on this computer.")}</p>
          </div>
        </aside>

        <section className="capture-browser">
          <header className="capture-browser-header">
            <div className="scope-heading">
              <div>
                <span className="eyebrow">{tr("Current collection")}</span>
                <h1>{selectedCategory ? `#${selectedCategory}` : scopeTitle}</h1>
              </div>
              <span className="capture-total">{captures.length}</span>
            </div>
            {selectedCategory && (
              <div className="tag-view-controls">
                <div className="segmented-control">
                  <button className={tagViewMode === "simple" ? "is-selected" : ""} onClick={() => setTagViewMode("simple")}>{tr("Simple view")}</button>
                  <button className={tagViewMode === "document" ? "is-selected" : ""} onClick={() => setTagViewMode("document")}>{tr("Document")}</button>
                </div>
                {tagViewMode === "document" && (
                  <div className="tag-document-actions">
                    <button className="quiet-button" disabled={!tagDocument} onClick={() => tagDocument && api.copyTextToClipboard(tagDocument.markdown).catch((error) => setStatus(formatAppError(error, tr)))}><Icon name="copy" size={13} /> {tr("Copy")}</button>
                    <button className="quiet-button" disabled={!tagDocument} onClick={exportCurrentTag}><Icon name="folder" size={13} /> {tr("Export")}</button>
                  </div>
                )}
              </div>
            )}
          </header>

          {selectedCategory && tagViewMode === "document" ? (
            <section className="tag-document-view">
              {isTagDocumentLoading ? (
                <div className="document-loading"><Icon name="loader" size={20} /> {tr("Generating local document...")}</div>
              ) : tagDocument ? (
                <>
                  <div className="tag-document-summary">
                    <div><span>{tr("Captures")}</span><strong>{tagDocument.capture_count}</strong></div>
                    <div><span>{tr("Applications")}</span><strong>{tagDocument.app_count}</strong></div>
                    <div><span>{tr("Contexts")}</span><strong>{tagDocument.context_count}</strong></div>
                    <button onClick={() => { const query = tr("Consolidate everything related to Tag {tag}", { tag: tagDocument.tag }); setChatQuery(query); setSearchMode("ai"); runMagicSearch(null, query); }}><Icon name="sparkles" size={14} /> {tr("Condense with Magic Search")}</button>
                  </div>
                  <MarkdownDocument source={tagDocument.markdown} />
                </>
              ) : null}
            </section>
          ) : captures.length > 0 ? <ol className="capture-list">
            {captures.map((capture) => (
              <li key={capture.id}>
                <button
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("text/clipscry-capture", capture.id)}
                  className={selectedCapture?.id === capture.id ? "is-selected" : ""}
                  onClick={() => setSelectedCaptureId(capture.id)}
                >
                  <div className="capture-row-topline">
                    <span className="app-avatar">{appInitial(capture.source_app_name)}</span>
                    <strong>{capture.source_app_name ?? tr("Unknown application")}</strong>
                    <time>{formatListDate(capture.captured_at)}</time>
                  </div>
                  <p className="capture-window">{capture.window_title ?? tr("Untitled window")}</p>
                  <p className="capture-excerpt">{captureDisplayText(language, capture)}</p>
                  <div className="capture-row-footer">
                    <span>{capture.contexts.map((context) => context.name).join(", ") || (capture.kind === "reference" ? tr("Content Base") : "Inbox")}</span>
                    {capture.kind === "reference" && <code>{tr("reference")}</code>}
                    {capture.assets.length > 0 && <Icon name="image" size={13} />}
                    {capture.tags.slice(0, 2).map((tag) => <code key={tag}>{tr(tag)}</code>)}
                    {capture.contexts.slice(0, 2).map((context) => <code className="context-chip" key={context.id}>{context.name}</code>)}
                  </div>
                </button>
              </li>
            ))}
          </ol> : null}

          {captures.length === 0 && (
            <div className="empty-state list-empty">
              <div className="empty-icon"><Icon name="inbox" size={25} /></div>
              <h2>{search || selectedCategory ? tr("Nothing here") : tr("Your collection is empty")}</h2>
              <p>{search || selectedCategory
                ? tr("Try removing filters or searching for another term.")
                : tr("Select something in any application and create your first capture.")}</p>
            </div>
          )}
        </section>

        <section className="detail-pane">
          {selectedCapture ? (
            <>
              <header className="detail-toolbar">
                <div className="detail-identity">
                  <span className="app-avatar large">{appInitial(selectedCapture.source_app_name)}</span>
                  <div>
                    <h2>{selectedCapture.source_app_name ?? tr("Unknown application")}</h2>
                    <p>{formatDate(selectedCapture.captured_at)}</p>
                  </div>
                </div>
                <div className="detail-actions">
                  <div className="context-picker-wrap" ref={contextPickerRef}>
                    <button className="compact-select" onClick={() => { setIsContextPickerOpen((value) => !value); setContextPickerSearch(""); }} aria-expanded={isContextPickerOpen} aria-label={tr("Manage contexts")}><Icon name="folder" size={14} />{tr("Manage contexts")}</button>
                    {isContextPickerOpen && <div className="context-picker" role="dialog" aria-label={tr("Manage contexts")}>
                      <header className="context-picker-header">
                        <div><span>{tr("Organize capture")}</span><strong>{tr("Manage contexts")}</strong></div>
                        <button onClick={() => { setIsContextPickerOpen(false); setContextPickerSearch(""); }} aria-label={tr("Close")}><Icon name="close" size={14} /></button>
                      </header>

                      <section className="context-picker-assigned">
                        <div className="context-picker-section-title"><span>{tr("Assigned contexts")}</span><small>{selectedCapture.contexts.length}</small></div>
                        {selectedCapture.contexts.length > 0 ? <div className="context-picker-chips">
                          {selectedCapture.contexts.map((context) => <button key={context.id} onClick={() => removeSelectedCaptureContext(context.id)} aria-label={tr("Remove {name}", { name: context.name })}><span>{context.name}</span><Icon name="close" size={11} /></button>)}
                        </div> : <p className="context-picker-empty-assigned">{tr("No contexts assigned yet")}</p>}
                      </section>

                      <div className="context-picker-search" role="search">
                        <Icon name="search" size={15} />
                        <input autoFocus value={contextPickerSearch} onChange={(event) => setContextPickerSearch(event.currentTarget.value)} placeholder={tr("Find a context to add")} aria-label={tr("Find a context to add")} onKeyDown={(event) => { if (event.key !== "Enter" || !contextPickerSearch.trim()) return; event.preventDefault(); if (exactAvailableContext) addSelectedCaptureToContext(exactAvailableContext.id); else if (availableContextOptions.length === 0 && !contextPickerHasExactMatch) createContextForSelectedCapture(); }} />
                        {contextPickerSearch && <button onClick={() => setContextPickerSearch("")} aria-label={tr("Clear search")}><Icon name="close" size={12} /></button>}
                      </div>

                      <div className="context-picker-section-title context-picker-options-title"><span>{tr("Available contexts")}</span><small>{availableContextOptions.length}</small></div>
                      <div className="context-picker-options">
                        {availableContextOptions.map((context) => <button key={context.id} onClick={() => addSelectedCaptureToContext(context.id)}>
                          <span className="context-picker-option-icon"><Icon name="folder" size={14} /></span>
                          <span className="context-picker-option-copy"><strong>{context.name}</strong><small>{tr("Add to this capture")}</small></span>
                          <span className="context-picker-add"><Icon name="plus" size={12} />{tr("Add")}</span>
                        </button>)}
                        {availableContextOptions.length === 0 && !contextPickerSearch.trim() && <p className="context-picker-empty-options">{tr("All contexts are already assigned")}</p>}
                        {availableContextOptions.length === 0 && contextPickerSearch.trim() && contextPickerHasExactMatch && <p className="context-picker-empty-options">{tr("This context is already assigned")}</p>}
                      </div>

                      {contextPickerSearch.trim() && !contextPickerHasExactMatch && <button className="context-create-inline" onClick={createContextForSelectedCapture}><span className="context-picker-option-icon"><Icon name="plus" size={14} /></span><span><strong>{tr("Create context")}</strong><small>“{contextPickerSearch.trim()}”</small></span><Icon name="chevron" size={13} /></button>}
                    </div>}
                  </div>
                  <button className="icon-button danger" onClick={deleteSelectedCapture} aria-label={tr("Delete capture")}>
                    <Icon name="trash" />
                  </button>
                </div>
              </header>

              <div className="detail-scroll">
                <section className="content-card hero-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">{tr("Captured content")}</span>
                      <h3>{selectedCapture.window_title ?? tr("Untitled selection")}</h3>
                    </div>
                    <button className="quiet-button" onClick={() => api.copyCaptureToClipboard(selectedCapture.id).catch((error) => setStatus(formatAppError(error, tr)))}>
                      <Icon name="copy" size={14} /> {tr("Copy")}
                    </button>
                  </div>
                  <pre className="captured-content">{captureDisplayText(language, selectedCapture)}</pre>
                  {selectedCapture.tags.length > 0 && (
                    <div className="tag-list">
                      {selectedCapture.tags.map((tag) => <code key={tag}>{tr(tag)}</code>)}
                      {selectedCapture.contexts.map((context) => <code className="context-chip" key={context.id}>{context.name}</code>)}
                    </div>
                  )}
                  {selectedCapture.contexts.length > 0 && selectedCapture.tags.length === 0 && (
                    <div className="tag-list">
                      {selectedCapture.contexts.map((context) => <code className="context-chip" key={context.id}>{context.name}</code>)}
                    </div>
                  )}
                </section>

                {selectedCapture.assets.length > 0 && (
                  <section className="content-card asset-card">
                    <div className="card-heading">
                      <div>
                        <span className="eyebrow">{tr("Visual reference")}</span>
                        <h3>{tr("Capture image")}</h3>
                      </div>
                      <span className="asset-count">{selectedCapture.assets.length}</span>
                    </div>
                    <ul className="asset-list">
                      {selectedCapture.assets.map((asset) => (
                        <AssetPreview asset={asset} key={asset.id} onPreview={setPreviewAsset} language={language} />
                      ))}
                    </ul>
                  </section>
                )}

                <section className="content-card intelligence-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">{tr("Local intelligence")}</span>
                      <h3>{tr("Explore your captures")}</h3>
                    </div>
                    <span className="privacy-badge"><Icon name="lock" size={12} /> Local</span>
                  </div>
                  <form
                    className="chat-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      askChat();
                    }}
                  >
                    <Icon name="sparkles" size={17} />
                    <input
                      value={chatQuery}
                      onChange={(event) => setChatQuery(event.currentTarget.value)}
                      placeholder={tr("Ask something about your memory...")}
                    />
                    <button type="submit" disabled={isAsking} aria-label={tr("Send question")}>
                      <Icon name={isAsking ? "loader" : "arrow"} size={15} />
                    </button>
                  </form>
                  {chatAnswer ? (
                    <div className="chat-answer">
                      <p>{chatAnswer.answer}</p>
                      <span className={`confidence ${chatAnswer.confidence}`}>{tr("Confidence")} {tr(chatAnswer.confidence)}</span>
                      {chatAnswer.evidence.length > 0 && (
                        <ol className="evidence-list">
                          {chatAnswer.evidence.map((item) => (
                            <li key={item.capture_id}>
                              <button onClick={() => openEvidence(item.capture_id)}>
                                <span className="app-avatar small">{appInitial(item.app_name)}</span>
                                <span>
                                  <strong>{item.app_name ?? tr("Unknown application")}</strong>
                                  <small>{translateLegacyGeneratedContent(language, item.excerpt)}</small>
                                </span>
                                <Icon name="chevron" size={14} />
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ) : (
                    <div className="prompt-suggestions">
                      {["Summarize this capture", "Where did I see this error?", "Find related items"].map((prompt) => (
                        <button key={prompt} onClick={() => setChatQuery(tr(prompt))}>{tr(prompt)}</button>
                      ))}
                    </div>
                  )}
                </section>

                {(selectedCapture.entities.length > 0 || selectedCapture.ocr) && (
                  <section className="content-card analysis-card">
                    <div className="card-heading">
                      <div>
                        <span className="eyebrow">{tr("Automatic analysis")}</span>
                        <h3>{tr("Detected entities")}</h3>
                      </div>
                      {selectedCapture.ocr && <span className="ocr-status">OCR {selectedCapture.ocr.status}</span>}
                    </div>
                    {selectedCapture.entities.length === 0 ? (
                      <p className="muted-copy">{tr("No entities were extracted from this capture.")}</p>
                    ) : (
                      <ul className="entity-list">
                        {selectedCapture.entities.map((entity) => (
                          <li key={entity.id}>
                            <span className="entity-icon"><Icon name="link" size={14} /></span>
                            <div>
                              <strong>{entity.value}</strong>
                              <small>{entity.kind} · {tr("{value}% confidence", { value: Math.round(entity.confidence * 100) })}</small>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {selectedCapture.ocr?.text && (
                      <details className="ocr-text">
                        <summary>{tr("Text recognized locally")}</summary>
                        <pre>{selectedCapture.ocr.text}</pre>
                      </details>
                    )}
                  </section>
                )}

                <details className="metadata-disclosure">
                  <summary><Icon name="info" size={15} /> {tr("Capture information")} <Icon name="chevron" size={13} /></summary>
                  <div className="metadata-grid">
                    <Metadata label={tr("Contexts")} value={selectedCapture.contexts.map((context) => context.name).join(", ") || (selectedCapture.kind === "reference" ? tr("Content Base") : "Inbox")} />
                    <Metadata label="Application ID" value={selectedCapture.source_app_id} />
                    <Metadata label="PID" value={selectedCapture.source_process_id?.toString() ?? null} />
                    <Metadata label={tr("Executable")} value={selectedCapture.source_process_path} />
                    <Metadata label={tr("Window")} value={selectedCapture.window_title} />
                    <Metadata label="Window ID" value={selectedCapture.window_id} />
                    <Metadata label={tr("Platform")} value={selectedCapture.platform} />
                  </div>
                  <pre className="metadata-json">{JSON.stringify(selectedCapture.metadata, null, 2)}</pre>
                </details>
              </div>
            </>
          ) : (
            <div className="empty-state detail-empty">
              <div className="empty-orbit">
                <div className="empty-icon"><Icon name="sparkles" size={28} /></div>
              </div>
              <h2>{tr("Select a capture")}</h2>
              <p>{tr("Content, images, and local analysis will appear here.")}</p>
            </div>
          )}
        </section>
      </div>

      {isCategoriesOpen && <CategoriesModal
        categories={categories}
        selectedCategory={selectedCategory}
        tr={tr}
        onClose={() => setIsCategoriesOpen(false)}
        onSelect={(tag) => {
          setSelectedContextId("all");
          selectCategory(selectedCategory === tag ? null : tag);
          setIsCategoriesOpen(false);
        }}
      />}

      {previewAsset?.path && (
        <div
          className="modal-backdrop image-preview-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPreviewAsset(null);
          }}
        >
          <section className="settings-modal image-modal" role="dialog" aria-modal="true" aria-labelledby="image-preview-title">
            <header>
              <div className="settings-icon"><Icon name="image" size={20} /></div>
              <div>
                <h2 id="image-preview-title">{tr("Capture preview")}</h2>
                <p>{tr("Image stored locally by ClipScry")}</p>
              </div>
              <button className="icon-button" onClick={() => setPreviewAsset(null)} aria-label={tr("Close preview")}>
                <Icon name="close" />
              </button>
            </header>
            <div className="image-modal-body">
              <img
                className="image-modal-image"
                src={convertFileSrc(previewAsset.path)}
                alt={tr("Capture preview")}
              />
            </div>
          </section>
        </div>
      )}

      {isMagicOpen && (
        <div className="modal-backdrop magic-modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !isMagicGenerating) setIsMagicOpen(false);
        }}>
          <section className={`magic-search-modal ${magicDocument?.response_mode === "direct" ? "is-direct" : ""}`} role="dialog" aria-modal="true" aria-labelledby="magic-search-title">
            <aside className="magic-history-pane">
              <div className="magic-history-heading">
                <span className="magic-logo"><Icon name="sparkles" size={17} /></span>
                <div><strong>Magic Search</strong><span>{tr("Magic Search history")}</span></div>
              </div>
              <div className="magic-history-list">
                {magicHistory.map((document) => (
                  <button className={magicDocument?.id === document.id ? "is-selected" : ""} key={document.id} onClick={() => openMagicSearch(document.id)}>
                    <strong>{document.title}</strong>
                    <span>{tr(magicResponseModeLabel(document.response_mode))} · {document.evidence_count} {tr("evidence items")}</span>
                    <time>{formatListDate(document.created_at)}</time>
                  </button>
                ))}
                {magicHistory.length === 0 && <p>{tr("No saved documents yet.")}</p>}
              </div>
            </aside>
            <div className="magic-document-pane">
              <header className="magic-document-toolbar">
                <div className="magic-toolbar-title-row">
                  <div>
                    <span className="eyebrow">{tr(magicResponseModeLabel(magicDocument?.response_mode))}</span>
                    <h2 id="magic-search-title">{magicDocument?.title ?? tr("Gathering evidence")}</h2>
                  </div>
                  <button className="icon-button" onClick={() => setIsMagicOpen(false)} aria-label={tr("Close Magic Search")}><Icon name="close" /></button>
                </div>
                {magicDocument && <div className="magic-toolbar-action-row">
                  <div className="magic-toolbar-primary-actions">
                    {magicDocument.response_mode !== "document" && <button className="secondary-button" disabled={isMagicGenerating} onClick={() => runMagicSearch(null, magicDocument.query, { ...magicDocument.filters, response_mode: "document" })}><Icon name="sparkles" size={13} /> {tr("Create full report")}</button>}
                    <button className="secondary-button" disabled={isMagicGenerating} onClick={() => runMagicSearch(magicDocument.id, magicDocument.query, magicDocument.filters)}><Icon name="refresh" size={13} /> {tr("Update")}</button>
                    {magicDocument.response_mode !== "direct" && <button className="quiet-button" onClick={exportCurrentMagicSearch}><Icon name="folder" size={13} /> {tr("Export")}</button>}
                  </div>
                </div>}
              </header>

              {isMagicGenerating ? (
                <div className="magic-generating"><span className="magic-orbit"><Icon name="sparkles" size={26} /></span><strong>{tr("Searching and preparing your answer...")}</strong><p>{tr("ClipScry is connecting captures, tags, and contexts.")}</p></div>
              ) : magicError ? (
                <div className="magic-generating is-error"><Icon name="info" size={25} /><strong>{tr("The document could not be generated")}</strong><p>{tr(magicError)}</p></div>
              ) : magicDocument ? (
                <div className="magic-document-content">
                  <div className="magic-document-meta">
                    <span>{tr("Version")} {magicDocument.version}</span>
                    <span>{tr(magicResponseModeLabel(magicDocument.response_mode))}</span>
                    <span>{magicDocument.evidence_count} {tr("evidence items")}</span>
                    <span>{magicDocument.model === "secure-lookup" ? tr("Protected local lookup") : magicDocument.provider === "local" ? tr("Local synthesis") : `${magicDocument.provider} · ${magicDocument.model}`}</span>
                    <time>{formatDate(magicDocument.created_at)}</time>
                  </div>
                  {magicDocument.generation_warning && (
                    <div className="magic-generation-warning"><Icon name="info" size={15} />{formatAppMessage(magicDocument.generation_warning, tr)}</div>
                  )}
                  <div className={`magic-answer-card is-${magicDocument.response_mode}`}>
                    <button className="quiet-button magic-answer-copy" onClick={() => api.copyTextToClipboard(magicDocument.markdown).catch((error) => setStatus(formatAppError(error, tr)))}><Icon name="copy" size={13} /> {tr("Copy")}</button>
                    <MarkdownDocument source={magicDocument.markdown} className="magic-markdown" />
                  </div>
                  {magicDocument.sensitive_value && <div className="magic-secret-card">
                    <div><span>{tr("Protected credential")}</span><code>{isSensitiveValueRevealed ? magicDocument.sensitive_value : maskSensitiveValue(magicDocument.sensitive_value)}</code><small>{tr("This value stays local and is not saved in Magic Search history.")}</small></div>
                    <div>
                      <button className="secondary-button" onClick={() => setIsSensitiveValueRevealed((value) => !value)}><Icon name="eye" size={14} /> {tr(isSensitiveValueRevealed ? "Hide" : "Reveal")}</button>
                      <button className="primary-button" onClick={() => api.copyTextToClipboard(magicDocument.sensitive_value!).catch((error) => setStatus(formatAppError(error, tr)))}><Icon name="copy" size={14} /> {tr("Copy credential")}</button>
                    </div>
                  </div>}
                  <section className="magic-evidence-section">
                    <div><span className="eyebrow">{tr("Traceability")}</span><h3>{tr("Evidence used")}</h3></div>
                    <div className="magic-evidence-grid">
                      {magicDocument.evidence.slice(0, magicDocument.response_mode === "direct" ? 1 : undefined).map((item, index) => (
                        <button key={item.capture_id} onClick={() => { setIsMagicOpen(false); openEvidence(item.capture_id); }}>
                          <span>{index + 1}</span><div><strong>{item.app_name ?? tr("Capture")}</strong><small>{translateLegacyGeneratedContent(language, item.excerpt)}</small></div><Icon name="chevron" size={13} />
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      )}

      {isOrganizeOpen && <OrganizeContextsDialog language={language} days={organizeDays} useAi={organizeWithAi} working={isOrganizing} result={organizeResult} contexts={contexts} selectedIds={selectedSuggestionIds} captureMap={organizeCaptureMap} onDays={setOrganizeDays} onUseAi={setOrganizeWithAi} onClose={() => setIsOrganizeOpen(false)} onAnalyze={organizeCaptures} onApply={applyOrganization} onToggle={toggleSuggestion} onUpdate={updateSuggestion} onRemoveCapture={removeSuggestionCapture} onOpenCapture={(id) => { setIsOrganizeOpen(false); openEvidence(id); }} />}

      {isOnboardingOpen && <OnboardingTutorial
        tr={tr}
        settings={settings}
        aiOptions={aiOptions}
        captureHotkey={formatHotkey(settings.hotkey)}
        pasteHotkey={formatHotkey(settings.paste_hotkey)}
        onPatch={updateSettings}
        onSaveCredential={(value) => updateSettings({ ai_api_key: value })}
        onClearCredential={clearAiApiKey}
        saveState={saveState}
        saveError={saveError}
        onRetry={retrySettings}
        awaitPending={awaitPendingSettings}
        onFinish={() => setIsOnboardingOpen(false)}
      />}

      {isSettingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setIsSettingsOpen(false);
        }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header>
              <div className="settings-icon"><Icon name="settings" size={20} /></div>
              <div>
                <h2 id="settings-title">{tr("Settings")}</h2>
                <p>{tr("Customize intelligence, language, and local storage.")}</p>
              </div>
              <button className="icon-button" onClick={() => setIsSettingsOpen(false)} aria-label={tr("Close settings")}>
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-body">
              <section className="settings-group">
                <div className="settings-group-title">
                  <Icon name="library" />
                  <div><strong>{tr("Language")}</strong><span>{language === "en" ? "English" : "Português"}</span></div>
                </div>
                <label>
                  <span>{tr("Language")}</span>
                  <select
                    value={language}
                    onChange={(event) => void updateSettings({ language: normalizeLanguage(event.currentTarget.value) })}
                  >
                    <option value="en">English</option>
                    <option value="pt-BR">Português</option>
                  </select>
                </label>
              </section>
              <section className="settings-group tutorial-settings-group">
                <div className="settings-group-title">
                  <Icon name="sparkles" />
                  <div><strong>{tr("Getting started")}</strong><span>{tr("Review the essential ClipScry workflow")}</span></div>
                </div>
                <button className="tutorial-settings-card" onClick={() => { setIsSettingsOpen(false); setIsOnboardingOpen(true); }}>
                  <span className="tutorial-settings-icon"><Icon name="layers" size={18} /></span>
                  <span><strong>{tr("View welcome tutorial")}</strong><small>{tr("Six short steps · about two minutes")}</small></span>
                  <Icon name="arrow" size={15} />
                </button>
              </section>
              <section className="settings-group ai-settings-group">
                <div className="settings-group-title">
                  <Icon name="sparkles" />
                  <div><strong>{tr("Artificial intelligence")}</strong><span>{tr("Optional provider for enriched answers")}</span></div>
                </div>
                <AiControls settings={settings} options={aiOptions} tr={tr} onPatch={updateSettings} onSaveCredential={(value) => updateSettings({ ai_api_key: value })} onClearCredential={clearAiApiKey} />
              </section>
              <section className="settings-group">
                <div className="settings-group-title"><Icon name="folder" /><div><strong>{tr("Quick context panel")}</strong><span>{tr("Assign contexts immediately after an explicit capture")}</span></div></div>
                <QuickContextControls settings={settings} tr={tr} onPatch={updateSettings} />
              </section>
              <section className="settings-group">
                <div className="settings-group-title"><Icon name="copy" /><div><strong>{tr("Clipboard capture")}</strong><span>{tr("Automatic monitoring is off by default")}</span></div></div>
                <ClipboardCaptureControls settings={settings} tr={tr} onPatch={updateSettings} />
              </section>
              <section className="settings-group">
                <div className="settings-group-title">
                  <Icon name="database" />
                  <div><strong>{tr("Protected local data")}</strong><span>{tr("SQLite and contexts are encrypted at rest")}</span></div>
                </div>
                <div className="storage-path"><Icon name="folder" size={14} /><code>{settings?.data_dir ?? tr("Loading...")}</code></div>
                <div className="settings-actions">
                  <button className="secondary-button wide" onClick={resyncMarkdown}>
                    <Icon name="refresh" size={14} /> {tr("Resynchronize Markdown")}
                  </button>
                  <button className="secondary-button wide danger-action" onClick={deleteAllData} disabled={isDeletingAllData}>
                    <Icon name="trash" size={14} /> {isDeletingAllData ? tr("Deleting data...") : tr("Delete all data")}
                  </button>
                </div>
              </section>
              <section className="settings-group compact-group">
                <StartupAndShortcutsControls settings={settings} tr={tr} onPatch={updateSettings} />
              </section>
            </div>
            <footer>
              <span><Icon name="lock" size={13} /> {tr("Settings stored locally")}</span>
              <SettingsSaveFeedback tr={tr} state={saveState} error={saveError} onRetry={() => void retrySettings()} />
              <button className="primary-button" onClick={() => setIsSettingsOpen(false)}>{tr("Done")}</button>
            </footer>
          </section>
        </div>
      )}

      {confirmation && (
        <ConfirmationModal
          {...confirmation}
          language={language}
          onCancel={() => closeConfirmation(false)}
          onConfirm={() => closeConfirmation(true)}
        />
      )}
    </main>
  );
}

function OrganizeContextsDialog({ language, days, useAi, working, result, contexts, selectedIds, captureMap, onDays, onUseAi, onClose, onAnalyze, onApply, onToggle, onUpdate, onRemoveCapture, onOpenCapture }: {
  language: AppLanguage; days: number; useAi: boolean; working: boolean; result: ContextAnalysisResult | null;
  contexts: Context[]; selectedIds: Set<string>; captureMap: Record<string, Capture>;
  onDays: (value: number) => void; onUseAi: (value: boolean) => void; onClose: () => void;
  onAnalyze: () => void; onApply: () => void; onToggle: (id: string, selected: boolean) => void;
  onUpdate: (id: string, patch: Partial<ContextAnalysisResult["suggestions"][number]>) => void;
  onRemoveCapture: (suggestionId: string, captureId: string) => void; onOpenCapture: (id: string) => void;
}) {
  const tr = (english: string) => translate(language, english);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="settings-modal organize-modal" role="dialog" aria-modal="true" aria-labelledby="organize-contexts-title">
      <header><div className="settings-icon"><Icon name="sparkles" size={20} /></div><div><h2 id="organize-contexts-title">{tr("Organize contexts")}</h2><p>{tr("Review suggested context associations before applying them.")}</p></div><button className="icon-button" onClick={onClose} aria-label={tr("Close organization")}><Icon name="close" /></button></header>
      <div className="settings-body">
        {!result ? <section className="settings-group organize-config-group">
          <div className="settings-group-title"><Icon name="database" /><div><strong>{tr("Analysis configuration")}</strong><span>{tr("Local rules use repeated IDs, URLs, paths, applications, and other identifiers.")}</span></div></div>
          <label><span>{tr("Most recent captures")}</span><select value={days} onChange={(event) => onDays(Number(event.currentTarget.value))}><option value={7}>{tr("Last 7 days")}</option><option value={30}>{tr("Last 30 days")}</option><option value={90}>{tr("Last 90 days")}</option></select></label>
          <div className="organize-ai-option">
            <label className="ai-consent"><input type="checkbox" checked={useAi} onChange={(event) => onUseAi(event.currentTarget.checked)} /><span>{tr("Use the configured AI to enrich suggestions")}</span></label>
            {useAi && <p className="ai-disclosure">{tr("Only bounded text, metadata, and entities are sent. Images and screenshots are not sent.")}</p>}
          </div>
          <p className="ai-disclosure organize-safety-note">{tr("ClipScry will analyze local identifiers and relationships to suggest context associations. No capture will be deleted or removed from an existing context.")}</p>
        </section> : <section className="organize-review">
          <div className="organize-summary"><strong>{result.scanned_count} {tr("items analyzed")}</strong><span>{result.contextualized_count} {tr("already have contexts")} · {result.unmatched_capture_ids.length} {tr("uncertain or unmatched")}</span>{result.ai_message && <p>{formatAppMessage(result.ai_message, tr)}</p>}</div>
          {result.suggestions.map((suggestion) => <article className="suggestion-card" key={suggestion.id}>
            <header><input type="checkbox" checked={selectedIds.has(suggestion.id)} onChange={(event) => onToggle(suggestion.id, event.currentTarget.checked)} /><div><input value={suggestion.name} disabled={Boolean(suggestion.existing_context_id)} onChange={(event) => onUpdate(suggestion.id, { name: event.currentTarget.value })} aria-label={tr("Suggested context name")} /><span>{suggestion.existing_context_id ? tr("Existing context") : tr("New context")} · {Math.round(suggestion.confidence * 100)}%</span></div></header>
            <p>{suggestion.reason}</p>
            <label><span>{tr("Apply to")}</span><select value={suggestion.existing_context_id ?? ""} onChange={(event) => onUpdate(suggestion.id, { existing_context_id: event.currentTarget.value || null, name: contexts.find((context) => context.id === event.currentTarget.value)?.name ?? suggestion.name })}><option value="">{tr("Create a new context")}</option>{contexts.map((context) => <option value={context.id} key={context.id}>{context.name}</option>)}</select></label>
            <ul>{suggestion.capture_ids.map((captureId) => { const item = captureMap[captureId]; return <li key={captureId}><button onClick={() => onOpenCapture(captureId)}><strong>{item?.source_app_name ?? tr("Capture")}</strong><span>{item ? captureDisplayText(language, item).replace(/\s+/g, " ").slice(0, 100) : captureId}</span></button><button aria-label={tr("Remove capture from suggestion")} onClick={() => onRemoveCapture(suggestion.id, captureId)}>×</button></li>; })}</ul>
          </article>)}
          {result.suggestions.length === 0 && <p className="muted-copy">{tr("No useful context suggestions were found. Your captures were left unchanged.")}</p>}
        </section>}
      </div>
      <footer><span><Icon name="lock" size={13} /> {tr("Suggestions never remove existing associations")}</span><button className="primary-button" onClick={result ? onApply : onAnalyze} disabled={working}>{working ? tr("Working...") : result ? tr("Apply selected suggestions") : tr("Analyze")}</button></footer>
    </section>
  </div>;
}

function CategoriesModal({ categories, selectedCategory, tr, onClose, onSelect }: {
  categories: Category[];
  selectedCategory: string | null;
  tr: (english: string, variables?: Record<string, string | number>) => string;
  onClose: () => void;
  onSelect: (tag: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredCategories = categories.filter((category) =>
    tr(category.tag).toLocaleLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    searchRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return <div className="modal-backdrop categories-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="settings-modal categories-modal" role="dialog" aria-modal="true" aria-labelledby="categories-modal-title">
      <header>
        <div className="settings-icon categories-modal-icon"><Icon name="grid" size={19} /></div>
        <div><h2 id="categories-modal-title">{tr("All contexts")}</h2><p>{tr("Browse or search every context in your library.")}</p></div>
        <button className="icon-button" onClick={onClose} aria-label={tr("Close contexts")}><Icon name="close" /></button>
      </header>
      <div className="categories-modal-body">
        <label className="categories-search">
          <Icon name="search" size={15} />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={tr("Search contexts")} aria-label={tr("Search contexts")} />
        </label>
        <div className="categories-modal-list">
          {filteredCategories.map((category) => <button key={category.tag} className={selectedCategory === category.tag ? "is-selected" : ""} onClick={() => onSelect(category.tag)} aria-pressed={selectedCategory === category.tag}>
            <span className="tag-dot" />
            <span>{tr(category.tag)}</span>
            <small>{category.capture_count}</small>
            <Icon name="chevron" size={13} />
          </button>)}
          {filteredCategories.length === 0 && <div className="categories-modal-empty"><Icon name="search" size={20} /><span>{tr("No contexts found")}</span><small>{tr("Try a different search term.")}</small></div>}
        </div>
      </div>
      <footer><span>{tr("{count} contexts", { count: categories.length })}</span><button className="primary-button" onClick={onClose}>{tr("Done")}</button></footer>
    </section>
  </div>;
}

function ConfirmationModal({
  title,
  message,
  confirmLabel,
  eyebrow,
  language,
  onCancel,
  onConfirm,
}: ConfirmationOptions & { language: AppLanguage; onCancel: () => void; onConfirm: () => void }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const tr = (english: string) => translate(language, english);

  useEffect(() => {
    cancelButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <section className="settings-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
        <header>
          <div className="confirmation-icon"><Icon name="trash" size={19} /></div>
          <div>
            <span className="eyebrow">{eyebrow ?? tr("Irreversible action")}</span>
            <h2 id="confirmation-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label={tr("Close confirmation")}><Icon name="close" /></button>
        </header>
        <div className="confirmation-body">
          <p id="confirmation-message">{message}</p>
          <div className="confirmation-notice"><Icon name="info" size={14} /> {tr("Confirm only if you recognize this action.")}</div>
        </div>
        <footer>
          <span><Icon name="lock" size={13} /> {tr("Your other data remains local")}</span>
          <div className="confirmation-actions">
            <button ref={cancelButtonRef} className="secondary-button" onClick={onCancel}>{tr("Cancel")}</button>
            <button className="confirmation-danger-button" onClick={onConfirm}><Icon name="trash" size={14} /> {confirmLabel}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="metadata-item">
      <dt>{label}</dt>
      <dd>{value || translate(normalizeLanguage(document.documentElement.lang), "Unknown")}</dd>
    </div>
  );
}

function AssetPreview({ asset, onPreview, language }: { asset: CaptureAsset; onPreview: (asset: CaptureAsset) => void; language: AppLanguage }) {
  const canPreview = Boolean(asset.path) && ["screenshot", "clipboard_image", "imported_image"].includes(asset.kind);
  const src = canPreview && asset.path ? convertFileSrc(asset.path) : null;

  return (
    <li className="asset-item">
      <div className="asset-header">
        <strong>{asset.kind}</strong>
        <span>{asset.status}</span>
      </div>
      {src && (
        <button className="asset-preview-button" onClick={() => onPreview(asset)} aria-label={translate(language, "Open image at full size")}>
          <img src={src} alt={asset.kind} />
        </button>
      )}
      {asset.path && <code>{asset.path}</code>}
      {asset.error && <span>{formatAppError(asset.error, (english, variables) => translate(language, english, variables))}</span>}
    </li>
  );
}

type IconName =
  | "arrow"
  | "capture"
  | "check"
  | "chevron"
  | "close"
  | "copy"
  | "database"
  | "edit"
  | "eye"
  | "folder"
  | "grid"
  | "image"
  | "inbox"
  | "info"
  | "layers"
  | "library"
  | "link"
  | "loader"
  | "lock"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "sparkles"
  | "trash";

const iconPaths: Record<IconName, string[]> = {
  arrow: ["M5 12h14", "m13-6 6 6-6 6"],
  capture: ["M8 3H5a2 2 0 0 0-2 2v3", "M16 3h3a2 2 0 0 1 2 2v3", "M8 21H5a2 2 0 0 1-2-2v-3", "M16 21h3a2 2 0 0 0 2-2v-3", "M12 8v8", "M8 12h8"],
  check: ["m5 12 4 4L19 6"],
  chevron: ["m9 18 6-6-6-6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  copy: ["M9 9h11v11H9z", "M4 15V4h11"],
  database: ["M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3Z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"],
  eye: ["M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  folder: ["M3 6h7l2 2h9v11H3z"],
  grid: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
  image: ["M4 5h16v14H4z", "m4 14 4-4 3 3 3-4 6 6", "M9 9h.01"],
  inbox: ["M4 4h16v16H4z", "M4 14h5l2 3h2l2-3h5"],
  info: ["M12 11v6", "M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  layers: ["m12 3 9 5-9 5-9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  library: ["M4 4h5v16H4z", "M11 4h4v16h-4z", "m17 5 3-1 3 15-3 1Z"],
  link: ["M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1", "M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"],
  loader: ["M21 12a9 9 0 1 1-6.2-8.6"],
  lock: ["M6 10h12v10H6z", "M8 10V7a4 4 0 0 1 8 0v3"],
  plus: ["M12 5v14", "M5 12h14"],
  refresh: ["M20 7v5h-5", "M4 17v-5h5", "M6.1 9a7 7 0 0 1 11.5-2L20 12", "M4 12l2.4 5a7 7 0 0 0 11.5-2"],
  search: ["M20 20 16 16", "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"],
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  ],
  sparkles: ["m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z", "m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z", "m5 13 .7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7Z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "m6 7 1 14h10l1-14", "M10 11v6", "M14 11v6"],
};

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className={name === "loader" ? "icon-loader" : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name].map((path) => <path d={path} key={path} />)}
    </svg>
  );
}

function appInitial(value: string | null) {
  return value?.trim().charAt(0).toLocaleUpperCase(currentLocale()) || "?";
}

function magicResponseModeLabel(mode?: MagicSearchDocument["response_mode"]) {
  if (mode === "direct") return "Direct answer";
  if (mode === "brief") return "Brief summary";
  if (mode === "document") return "Research document";
  return "Magic Search";
}

function maskSensitiveValue(value: string) {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 7)}••••••••${value.slice(-4)}`;
}

function currentLocale() {
  return document.documentElement.lang === "pt-BR" ? "pt-BR" : "en-US";
}

function formatListDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) {
    return new Intl.DateTimeFormat(currentLocale(), { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(currentLocale(), { day: "2-digit", month: "short" }).format(date);
}

function formatHotkey(value?: string) {
  return (value ?? "CommandOrControl+Shift+C")
    .replace("CommandOrControl", "Ctrl")
    .replace("Shift", "⇧")
    .split("+")
    .join(" ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

export default App;
