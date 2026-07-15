import { useEffect, useRef, useState } from "react";
import * as api from "../../api/tauri";
import { translate, translateGeneratedContent, type AppLanguage } from "../../i18n";
import type { Capture, Context } from "../../types";
import { appInitial, compactContent, formatRelativeDate } from "./formatters";
import { LiteIcon } from "./LiteIcon";

type AddItemsToContextDialogProps = {
  context: Context;
  language: AppLanguage;
  totalCaptureCount: number;
  onClose: () => void;
  onAdded: (count: number) => Promise<void>;
  onError: (message: string) => void;
};

export function AddItemsToContextDialog({
  context,
  language,
  totalCaptureCount,
  onClose,
  onAdded,
  onError,
}: AddItemsToContextDialogProps) {
  const [query, setQuery] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const requestId = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const tr = (english: string, variables?: Record<string, string | number>) =>
    translate(language, english, variables);

  useEffect(() => {
    searchInput.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSaving, onClose]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    const timeout = window.setTimeout(() => {
      setIsLoading(true);
      api.listCaptures({
        context_id: null,
        search: query.trim() || null,
        tag: null,
        limit: 500,
        offset: 0,
      }).then((items) => {
        if (currentRequest !== requestId.current) return;
        setCaptures(items.filter((capture) =>
          !capture.contexts.some((assigned) => assigned.id === context.id),
        ));
      }).catch((error) => {
        if (currentRequest === requestId.current) onError(String(error));
      }).finally(() => {
        if (currentRequest === requestId.current) setIsLoading(false);
      });
    }, 140);

    return () => window.clearTimeout(timeout);
  }, [context.id, onError, query]);

  function toggleCapture(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    if (selectedIds.size === 0 || isSaving) return;
    setIsSaving(true);
    try {
      const addedCount = await api.addCapturesToContext([...selectedIds], context.id);
      await onAdded(addedCount);
      onClose();
    } catch (error) {
      onError(String(error));
      setIsSaving(false);
    }
  }

  const hasSearch = Boolean(query.trim());
  const emptyTitle = hasSearch
    ? tr("No local captures match your search.")
    : totalCaptureCount === 0
      ? tr("There are no captures to add yet.")
      : tr("All captures are already in this context.");
  const emptyDescription = hasSearch
    ? tr("Clear the search or try another term.")
    : tr("New captures will appear here when they are available.");

  return (
    <div className="lite-modal-backdrop" onMouseDown={(event) => {
      if (!isSaving && event.currentTarget === event.target) onClose();
    }}>
      <section className="lite-modal-surface lite-context-picker-modal" role="dialog" aria-modal="true" aria-labelledby="lite-context-picker-title">
        <header>
          <div className="lite-context-picker-heading">
            <span className="lite-context-picker-icon"><LiteIcon name="folder" /></span>
            <div>
              <span className="lite-eyebrow">{tr("Select captures")}</span>
              <h2 id="lite-context-picker-title">{tr("Add items to {name}", { name: context.name })}</h2>
              <p>{tr("Choose captures to include in this context.")}</p>
            </div>
          </div>
          <button className="lite-icon-button" onClick={onClose} disabled={isSaving} aria-label={tr("Close")}>
            <LiteIcon name="close" />
          </button>
        </header>

        <div className="lite-context-picker-search-area">
          <form className="lite-context-picker-search" onSubmit={(event) => event.preventDefault()}>
            <LiteIcon name="search" />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={tr("Search your local captures...")}
              aria-label={tr("Local search")}
            />
            {query && <button type="button" onClick={() => setQuery("")} aria-label={tr("Clear search")}>
              <LiteIcon name="close" />
            </button>}
          </form>
          <span className="lite-context-picker-local"><LiteIcon name="lock" />{tr("Local search")}</span>
        </div>

        <div className="lite-context-picker-results" aria-live="polite" aria-busy={isLoading}>
          {isLoading ? <div className="lite-context-picker-empty">
            <LiteIcon name="loader" />
            <strong>{tr("Searching...")}</strong>
          </div> : captures.length === 0 ? <div className="lite-context-picker-empty">
            <LiteIcon name={hasSearch ? "search" : "check"} />
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </div> : captures.map((capture) => {
            const isSelected = selectedIds.has(capture.id);
            return <button
              type="button"
              className={`lite-context-picker-item ${isSelected ? "is-selected" : ""}`}
              key={capture.id}
              onClick={() => toggleCapture(capture.id)}
              aria-pressed={isSelected}
            >
              <span className="lite-context-picker-app">{appInitial(capture.source_app_name)}</span>
              <span className="lite-context-picker-copy">
                <strong>{capture.content_text.trim() ? compactContent(translateGeneratedContent(language, capture.content_text)) : tr("Image capture")}</strong>
                <small>{capture.source_app_name ?? tr("Unknown application")} · {formatRelativeDate(capture.captured_at, language)}</small>
              </span>
              <span className="lite-context-picker-check"><LiteIcon name={isSelected ? "check" : "plus"} /></span>
            </button>;
          })}
        </div>

        <footer>
          <span>{tr("{count} selected", { count: selectedIds.size })}</span>
          <button className="lite-context-picker-cancel" onClick={onClose} disabled={isSaving}>{tr("Cancel")}</button>
          <button className="lite-primary-button" onClick={() => void addSelected()} disabled={selectedIds.size === 0 || isSaving}>
            <LiteIcon name={isSaving ? "loader" : "plus"} />
            {isSaving ? tr("Adding...") : tr("Add {count} items", { count: selectedIds.size })}
          </button>
        </footer>
      </section>
    </div>
  );
}
