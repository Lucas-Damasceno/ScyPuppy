import { useEffect, useState } from "react";
import * as api from "../../api/tauri";
import { formatAppError, formatAppMessage, type MessageParams } from "../../appMessages";
import {
  AiControls,
  ClipboardCaptureControls,
  QuickContextControls,
  RetentionControls,
  SettingsSaveFeedback,
  StartupAndShortcutsControls,
} from "../../components/SettingsControls";
import type { SettingsSaveState } from "../../hooks/useSettingsCoordinator";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { normalizeLanguage, translate, type AppLanguage } from "../../i18n";
import type { AiProviderOption, LocalSearchStatus, RetentionApplyResult, Settings } from "../../types";
import { AppUpdateSettings } from "../updates/AppUpdateNotice";
import type { AppUpdaterController } from "../updates/useAppUpdater";
import { LiteIcon } from "./LiteIcon";

type LiteSettingsDialogProps = {
  settings: Settings;
  aiOptions: AiProviderOption[];
  language: AppLanguage;
  updater: AppUpdaterController;
  saveState: SettingsSaveState;
  saveError: unknown;
  onPatch: (patch: Partial<Settings>) => Promise<void>;
  onClearCredential: () => Promise<void>;
  onRetry: () => void;
  onDeleteAll: () => Promise<void>;
  onRetentionApplied: (result: RetentionApplyResult) => Promise<void>;
  onClose: () => void;
  onOpenTutorial: () => void;
  onStatus: (message: string | null) => void;
};

export function LiteSettingsDialog({ settings, aiOptions, language, updater, saveState, saveError, onPatch, onClearCredential, onRetry, onDeleteAll, onRetentionApplied, onClose, onOpenTutorial, onStatus }: LiteSettingsDialogProps) {
  const tr = (english: string, variables?: MessageParams) => translate(language, english, variables);
  const [localStatus, setLocalStatus] = useState<LocalSearchStatus | null>(null);
  const [localActionPending, setLocalActionPending] = useState(false);
  useEffect(() => { void api.getLocalSearchStatus().then(setLocalStatus).catch(() => undefined); }, []);
  useTauriEvent<LocalSearchStatus>("local-search-status-changed", ({ payload }) => setLocalStatus(payload));

  async function prepareLocalSearch() {
    setLocalActionPending(true);
    try {
      setLocalStatus(await api.prepareLocalSearch());
    } catch (error) {
      onStatus(formatAppError(error, tr));
    } finally {
      setLocalActionPending(false);
    }
  }

  async function removeLocalModel() {
    if (!window.confirm(tr("Remove the downloaded model? Captures and the search index will be preserved."))) return;
    setLocalActionPending(true);
    try {
      setLocalStatus(await api.removeLocalSearchModel());
    } catch (error) {
      onStatus(formatAppError(error, tr));
    } finally {
      setLocalActionPending(false);
    }
  }
  return (
    <div className="modal-backdrop lite-modal-backdrop lite-settings-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="settings-modal lite-modal-surface" role="dialog" aria-modal="true" aria-labelledby="lite-settings-title">
        <header>
          <div className="settings-icon"><LiteIcon name="settings" /></div>
          <div><h2 id="lite-settings-title">{tr("Settings")}</h2><p>{tr("Customize capture, search, and local storage.")}</p></div>
          <button className="icon-button" onClick={onClose} aria-label={tr("Close")}><LiteIcon name="close" /></button>
        </header>
        <div className="settings-body">
          <section className="settings-group">
            <div className="settings-group-title"><LiteIcon name="globe" /><div><strong>{tr("Language")}</strong><span>{language === "en" ? "English" : "Português"}</span></div></div>
            <label><span>{tr("Language")}</span><select value={language} onChange={(event) => void onPatch({ language: normalizeLanguage(event.currentTarget.value) })}><option value="en">English</option><option value="pt-BR">Português</option></select></label>
          </section>
          <section className="settings-group tutorial-settings-group">
            <div className="settings-group-title"><LiteIcon name="sparkles" /><div><strong>{tr("Getting started")}</strong><span>{tr("Review the essential ScryPuppy workflow")}</span></div></div>
            <button className="tutorial-settings-card" onClick={onOpenTutorial}>
              <span className="tutorial-settings-icon"><LiteIcon name="layers" /></span>
              <span><strong>{tr("View welcome tutorial")}</strong><small>{tr("Six short steps · about two minutes")}</small></span>
              <LiteIcon name="arrow" />
            </button>
          </section>
          <AppUpdateSettings updater={updater} language={language} />
          <section className="settings-group magic-engine-settings">
            <div className="settings-group-title"><LiteIcon name="search" /><div><strong>{tr("Semantic search")}</strong><span>{tr("E5 and exact text rank Magic Search results locally")}</span></div></div>
            <div className="settings-control-stack magic-engine-control-stack">
              <div className="local-model-status">
                <span className="settings-control-copy">
                  <strong>{localStatus?.model_name ?? "Multilingual E5 Small"}</strong>
                  <small>
                    {localStatus ? localPhaseLabel(localStatus, tr) : tr("Checking local model...")}
                    {localStatus && localStatus.cache_bytes > 0 && <>{" \u00b7 "}{formatBytes(localStatus.cache_bytes)} {tr("on disk")}</>}
                  </small>
                </span>
                <div className="local-model-actions">
                  {(localStatus?.can_download || localStatus?.can_retry) && <button className="settings-inline-button" disabled={localActionPending} onClick={() => void prepareLocalSearch()}><LiteIcon name="refresh" />{tr(localStatus.can_retry ? "Retry download" : "Download model")}</button>}
                  {localStatus?.can_remove && <button className="settings-inline-button is-danger" disabled={localActionPending || localStatus.phase === "downloading" || localStatus.phase === "indexing" || localStatus.phase === "removing"} onClick={() => void removeLocalModel()}><LiteIcon name="trash" />{tr("Remove model")}</button>}
                </div>
              </div>
              {localStatus?.phase === "indexing" && localStatus.total_count > 0 && <div className="local-model-progress"><progress value={localStatus.indexed_count} max={localStatus.total_count} /></div>}
              {localStatus?.error && <p className="settings-dependency-hint is-error">{formatAppMessage(localStatus.error, tr)}</p>}
            </div>
          </section>
          <section className="settings-group ai-settings-group">
            <div className="settings-group-title"><LiteIcon name="sparkles" /><div><strong>{tr("Document creation")}</strong><span>{tr("A configured AI provider is required to create documents")}</span></div></div>
            <AiControls settings={settings} options={aiOptions} tr={tr} onPatch={onPatch} onSaveCredential={(value) => onPatch({ ai_api_key: value })} onClearCredential={onClearCredential} />
          </section>
          <section className="settings-group">
            <div className="settings-group-title"><LiteIcon name="folder" /><div><strong>{tr("Quick context panel")}</strong><span>{tr("Choose contexts immediately after a capture")}</span></div></div>
            <QuickContextControls settings={settings} tr={tr} onPatch={onPatch} />
          </section>
          <section className="settings-group">
            <div className="settings-group-title"><LiteIcon name="copy" /><div><strong>{tr("Clipboard capture")}</strong><span>{tr("Automatic monitoring is off by default")}</span></div></div>
            <ClipboardCaptureControls settings={settings} tr={tr} onPatch={onPatch} />
          </section>
          <section className="settings-group">
            <div className="settings-group-title"><LiteIcon name="lock" /><div><strong>{tr("Protected local data")}</strong><span>{tr("Your history is encrypted on this computer")}</span></div></div>
            <RetentionControls settings={settings} tr={tr} onApplied={onRetentionApplied} onStatus={(message) => onStatus(message)} />
            <div className="storage-path"><LiteIcon name="folder" /><code>{settings.data_dir || tr("Loading...")}</code></div>
            <div className="settings-actions">
              <button className="secondary-button wide" onClick={() => api.resyncContexts().then(() => onStatus(tr("Data resynchronized."))).catch((error) => onStatus(formatAppError(error, tr)))}><LiteIcon name="refresh" />{tr("Resynchronize data")}</button>
              <button className="secondary-button wide danger-action" onClick={() => void onDeleteAll()}><LiteIcon name="trash" />{tr("Delete all data")}</button>
            </div>
          </section>
          <section className="settings-group compact-group"><StartupAndShortcutsControls settings={settings} tr={tr} onPatch={onPatch} /></section>
        </div>
        <footer><span><LiteIcon name="lock" />{tr("Settings stored locally")}</span><SettingsSaveFeedback tr={tr} state={saveState} error={saveError} onRetry={onRetry} /><button className="primary-button" onClick={onClose}>{tr("Done")}</button></footer>
      </section>
    </div>
  );
}

function localPhaseLabel(status: LocalSearchStatus, tr: (english: string, variables?: MessageParams) => string) {
  switch (status.phase) {
    case "not_downloaded": return tr("Model not downloaded. Local Magic Search is unavailable.");
    case "downloading": return tr("Downloading model...");
    case "indexing": return tr("Indexing {indexed} of {total} captures...", { indexed: status.indexed_count, total: status.total_count });
    case "ready": return tr("Ready · {count} captures indexed", { count: status.indexed_count });
    case "error": return tr("Local model needs attention.");
    case "removing": return tr("Removing model...");
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
