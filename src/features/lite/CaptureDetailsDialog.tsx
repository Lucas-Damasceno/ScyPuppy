import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../../api/tauri";
import { translate, type AppLanguage } from "../../i18n";
import type { Capture, Context } from "../../types";
import { formatDate } from "./formatters";
import { LiteIcon } from "./LiteIcon";

type CaptureDetailsDialogProps = {
  capture: Capture;
  contexts: Context[];
  language: AppLanguage;
  readOnly?: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
};

export function CaptureDetailsDialog({
  capture,
  contexts,
  language,
  readOnly = false,
  onClose,
  onChanged,
  onError,
}: CaptureDetailsDialogProps) {
  const [newContextName, setNewContextName] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const tr = (english: string) => translate(language, english);
  const available = useMemo(
    () => contexts.filter((context) => !capture.contexts.some((assigned) => assigned.id === context.id)),
    [capture.contexts, contexts],
  );

  async function toggleContext(context: Context, assigned: boolean) {
    try {
      if (assigned) await api.removeCaptureContext(capture.id, context.id);
      else await api.addCaptureContexts(capture.id, [context.id]);
      await onChanged();
    } catch (error) {
      onError(String(error));
    }
  }

  async function createAndAssign() {
    const name = newContextName.trim();
    if (!name) return;
    try {
      const context = await api.createContext(name);
      await api.addCaptureContexts(capture.id, [context.id]);
      setNewContextName("");
      await onChanged();
    } catch (error) {
      onError(String(error));
    }
  }

  async function deleteCapture() {
    if (!window.confirm(tr("Delete capture?"))) return;
    try {
      await api.deleteCapture(capture.id);
      onClose();
      await onChanged();
    } catch (error) {
      onError(String(error));
    }
  }

  return (
    <div className="lite-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="lite-modal-surface lite-detail-modal" role="dialog" aria-modal="true" aria-labelledby="lite-detail-title">
        <header>
          <div><span className="lite-eyebrow">{tr("Captured content")}</span><h2 id="lite-detail-title">{capture.source_app_name ?? tr("Unknown application")}</h2></div>
          <button className="lite-icon-button" onClick={onClose} aria-label={tr("Close")}><LiteIcon name="close" /></button>
        </header>

        <div className="lite-detail-scroll">
          <section className="lite-detail-section">
            <div className="lite-section-heading"><h3>{tr("Full text")}</h3><button onClick={() => api.copyTextToClipboard(capture.content_text).catch((error) => onError(String(error)))}><LiteIcon name="copy" />{tr("Copy")}</button></div>
            <pre>{capture.content_text}</pre>
          </section>

          {!readOnly && <section className="lite-detail-section">
            <h3>{tr("Contexts")}</h3>
            <div className="lite-detail-chips">
              {capture.contexts.map((context) => <button className="is-selected" key={context.id} onClick={() => void toggleContext(context, true)}>{context.name}<LiteIcon name="close" /></button>)}
              {available.map((context) => <button key={context.id} onClick={() => void toggleContext(context, false)}>{context.name}<LiteIcon name="plus" /></button>)}
            </div>
            <form className="lite-inline-create" onSubmit={(event) => { event.preventDefault(); void createAndAssign(); }}>
              <input value={newContextName} onChange={(event) => setNewContextName(event.currentTarget.value)} placeholder={tr("Create a new context")} />
              <button type="submit" disabled={!newContextName.trim()}><LiteIcon name="plus" />{tr("Create")}</button>
            </form>
          </section>}

          <section className="lite-detail-section">
            <h3>{tr("Source and metadata")}</h3>
            <dl className="lite-metadata-grid">
              <Metadata label={tr("Application")} value={capture.source_app_name} />
              <Metadata label="Application ID" value={capture.source_app_id} />
              <Metadata label={tr("Window")} value={capture.window_title} />
              <Metadata label={tr("Executable")} value={capture.source_process_path} />
              <Metadata label={tr("Captured at")} value={formatDate(capture.captured_at, language)} />
              <Metadata label={tr("Platform")} value={capture.platform} />
            </dl>
          </section>

          {capture.assets.some((asset) => asset.path) && <section className="lite-detail-section">
            <h3>{tr("Images and screenshots")}</h3>
            <div className="lite-asset-grid">
              {capture.assets.filter((asset) => asset.path).map((asset) => <button key={asset.id} onClick={() => setPreviewPath(asset.path)}>
                <img src={convertFileSrc(asset.path!)} alt={asset.kind} /><span>{asset.kind}</span>
              </button>)}
            </div>
          </section>}
        </div>

        <footer>
          {!readOnly && <button className="lite-danger-button" onClick={() => void deleteCapture()}><LiteIcon name="trash" />{tr("Delete")}</button>}
          <span />
          <button className="lite-primary-button" onClick={onClose}>{tr("Done")}</button>
        </footer>
      </section>
      {previewPath && <button className="lite-image-preview" onClick={() => setPreviewPath(null)} aria-label={tr("Close preview")}><img src={convertFileSrc(previewPath)} alt="" /></button>}
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  return <div><dt>{label}</dt><dd>{value || "—"}</dd></div>;
}
