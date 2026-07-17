import { useEffect, useState } from "react";
import * as api from "../../api/tauri";
import { formatAppError } from "../../appMessages";
import { translate, type AppLanguage } from "../../i18n";
import type { Context, DataCleanupFilter, DataCleanupPreview, DataCleanupResult } from "../../types";
import { LiteIcon } from "./LiteIcon";

type CleanupType = DataCleanupFilter["content_types"][number];

type DataCleanupDialogProps = {
  contexts: Context[];
  language: AppLanguage;
  onClose: () => void;
  onDeleted: (result: DataCleanupResult) => Promise<void>;
  onError: (message: string) => void;
};

const cleanupTypes: Array<{ value: CleanupType; label: string; icon: "file" | "folder" | "globe" | "image" | "layers" | "window" }> = [
  { value: "text", label: "Text", icon: "layers" },
  { value: "image", label: "Images", icon: "image" },
  { value: "link", label: "Links", icon: "globe" },
  { value: "file", label: "Files", icon: "file" },
  { value: "folder", label: "Folders", icon: "folder" },
  { value: "application", label: "Applications", icon: "window" },
];

export function formatBytes(value: number, language: AppLanguage) {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** exponent);
  return `${new Intl.NumberFormat(language === "pt-BR" ? "pt-BR" : "en-US", { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(amount)} ${units[exponent]}`;
}

export function DataCleanupDialog({ contexts, language, onClose, onDeleted, onError }: DataCleanupDialogProps) {
  const tr = (english: string, variables?: Record<string, string | number>) => translate(language, english, variables);
  const [filter, setFilter] = useState<DataCleanupFilter>({ content_types: [], context_id: null, period_minutes: 10 });
  const [preview, setPreview] = useState<DataCleanupPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isDeleting) return;
      if (isConfirming) setIsConfirming(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isConfirming, isDeleting, onClose]);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setIsPreviewing(true);
    setIsConfirming(false);
    const timeout = window.setTimeout(() => {
      api.previewDataCleanup(filter).then((result) => {
        if (active) setPreview(result);
      }).catch((error) => {
        if (active) onError(formatAppError(error, tr));
      }).finally(() => {
        if (active) setIsPreviewing(false);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [filter, onError]);

  function toggleType(value: CleanupType) {
    setFilter((current) => ({
      ...current,
      content_types: current.content_types.includes(value)
        ? current.content_types.filter((candidate) => candidate !== value)
        : [...current.content_types, value],
    }));
  }

  async function deleteMatches() {
    if (!preview || preview.capture_count === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      const result = await api.deleteDataByFilter(filter, preview.selection_token);
      await onDeleted(result);
      onClose();
    } catch (error) {
      onError(formatAppError(error, tr));
      setIsConfirming(false);
      try {
        setPreview(await api.previewDataCleanup(filter));
      } catch {
        setPreview(null);
      }
    } finally {
      setIsDeleting(false);
    }
  }

  const selectedContextName = filter.context_id === null
    ? tr("Every context")
    : filter.context_id === "inbox"
      ? tr("Inbox")
      : filter.context_id === "content-base"
        ? tr("Content Base")
        : contexts.find((context) => context.id === filter.context_id)?.name ?? tr("Unknown context");

  return <div className="lite-modal-backdrop" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !isDeleting) onClose();
  }}>
    <section className="lite-modal-surface lite-cleanup-modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
      <header>
        <div className="lite-context-picker-heading">
          <span className="lite-context-picker-icon is-danger"><LiteIcon name="trash" /></span>
          <div>
            <span className="lite-eyebrow">{tr("Data cleanup")}</span>
            <h2 id="cleanup-title">{tr("Clear only what you choose")}</h2>
            <p>{tr("Filter local captures by type, period, and context before deleting.")}</p>
          </div>
        </div>
        <button className="lite-icon-button" onClick={onClose} disabled={isDeleting} aria-label={tr("Close")}><LiteIcon name="close" /></button>
      </header>

      <div className="lite-cleanup-body">
        <section className="lite-form-section">
          <div className="lite-form-section-heading"><span>{tr("Content type")}</span><small>{filter.content_types.length === 0 ? tr("All types") : tr("{count} selected", { count: filter.content_types.length })}</small></div>
          <div className="lite-cleanup-types">
            <button type="button" className={filter.content_types.length === 0 ? "is-selected" : ""} onClick={() => setFilter((current) => ({ ...current, content_types: [] }))}><LiteIcon name="layers" />{tr("All types")}</button>
            {cleanupTypes.map((type) => <button type="button" key={type.value} className={filter.content_types.includes(type.value) ? "is-selected" : ""} onClick={() => toggleType(type.value)}><LiteIcon name={type.icon} />{tr(type.label)}</button>)}
          </div>
        </section>

        <section className="lite-form-section lite-cleanup-scope">
          <div className="lite-form-section-heading"><span>{tr("Scope")}</span><small>{tr("Local captures only")}</small></div>
          <label className="lite-field-label"><span>{tr("Period")}</span><select value={filter.period_minutes ?? "all"} onChange={(event) => {
            const value = event.currentTarget.value;
            setFilter((current) => ({ ...current, period_minutes: value === "all" ? null : Number(value) }));
          }}>
            <option value={5}>{tr("Last 5 minutes")}</option>
            <option value={10}>{tr("Last 10 minutes")}</option>
            <option value={30}>{tr("Last 30 minutes")}</option>
            <option value={60}>{tr("Last hour")}</option>
            <option value={1440}>{tr("Last 24 hours")}</option>
            <option value={10080}>{tr("Last 7 days")}</option>
            <option value={43200}>{tr("Last 30 days")}</option>
            <option value="all">{tr("All time")}</option>
          </select></label>
          <label className="lite-field-label"><span>{tr("Context")}</span><select value={filter.context_id ?? "all"} onChange={(event) => {
            const value = event.currentTarget.value;
            setFilter((current) => ({ ...current, context_id: value === "all" ? null : value }));
          }}>
            <option value="all">{tr("Every context")}</option>
            <option value="inbox">{tr("Inbox")}</option>
            <option value="content-base">{tr("Content Base")}</option>
            {contexts.map((context) => <option key={context.id} value={context.id}>{context.name}</option>)}
          </select></label>
        </section>

        <section className={`lite-cleanup-preview ${preview?.capture_count ? "has-matches" : ""}`} aria-live="polite">
          {isPreviewing ? <><span><LiteIcon name="loader" /></span><div><strong>{tr("Checking your selection...")}</strong><p>{tr("Nothing is being deleted.")}</p></div></>
            : preview ? <><span><LiteIcon name={preview.capture_count > 0 ? "trash" : "check"} /></span><div><strong>{preview.capture_count > 0 ? tr("{count} captures will be deleted", { count: preview.capture_count }) : tr("No captures match this selection")}</strong><p>{preview.capture_count > 0 ? tr("Includes {images} images and {files} file captures · up to {size}", { images: preview.image_count, files: preview.file_count, size: formatBytes(preview.reclaimable_bytes, language) }) : tr("Adjust the filters to find data you want to remove.")}</p></div></>
              : <><span><LiteIcon name="info" /></span><div><strong>{tr("Preview unavailable")}</strong><p>{tr("Change a filter to try again.")}</p></div></>}
        </section>

        <div className="lite-cleanup-note"><LiteIcon name="info" size={14} /><span>{tr("Contexts, settings, documents, and your AI key are not deleted by this tool.")}</span></div>
      </div>

      <footer>
        <span>{tr("Selection: {context}", { context: selectedContextName })}</span>
        <button className="lite-context-picker-cancel" onClick={onClose} disabled={isDeleting}>{tr("Cancel")}</button>
        <button className="lite-danger-button" disabled={!preview?.capture_count || isPreviewing || isDeleting} onClick={() => setIsConfirming(true)}><LiteIcon name="trash" />{tr("Review deletion")}</button>
      </footer>

      {isConfirming && preview && <div className="lite-cleanup-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cleanup-confirm-title">
        <div className="lite-cleanup-confirm-card">
          <span><LiteIcon name="trash" /></span>
          <div><span className="lite-eyebrow">{tr("Permanent deletion")}</span><h3 id="cleanup-confirm-title">{tr("Delete {count} matching captures?", { count: preview.capture_count })}</h3><p>{tr("This removes the selected captures and their locally stored files. This action cannot be undone.")}</p></div>
          <dl><div><dt>{tr("Context")}</dt><dd>{selectedContextName}</dd></div><div><dt>{tr("Estimated space")}</dt><dd>{formatBytes(preview.reclaimable_bytes, language)}</dd></div></dl>
          <footer><button onClick={() => setIsConfirming(false)} disabled={isDeleting}>{tr("Go back")}</button><button className="is-danger" onClick={() => void deleteMatches()} disabled={isDeleting}>{isDeleting && <LiteIcon name="loader" />}{tr("Delete permanently")}</button></footer>
        </div>
      </div>}
    </section>
  </div>;
}
