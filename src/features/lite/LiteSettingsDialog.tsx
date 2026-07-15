import * as api from "../../api/tauri";
import { formatAppError, type MessageParams } from "../../appMessages";
import {
  AiControls,
  ClipboardCaptureControls,
  QuickContextControls,
  SettingsSaveFeedback,
  StartupAndShortcutsControls,
} from "../../components/SettingsControls";
import type { SettingsSaveState } from "../../hooks/useSettingsCoordinator";
import { normalizeLanguage, translate, type AppLanguage } from "../../i18n";
import type { AiProviderOption, Settings } from "../../types";
import { LiteIcon } from "./LiteIcon";

type LiteSettingsDialogProps = {
  settings: Settings;
  aiOptions: AiProviderOption[];
  language: AppLanguage;
  saveState: SettingsSaveState;
  saveError: unknown;
  onPatch: (patch: Partial<Settings>) => Promise<void>;
  onClearCredential: () => Promise<void>;
  onRetry: () => void;
  onDeleteAll: () => Promise<void>;
  onClose: () => void;
  onOpenTutorial: () => void;
  onStatus: (message: string | null) => void;
};

export function LiteSettingsDialog({ settings, aiOptions, language, saveState, saveError, onPatch, onClearCredential, onRetry, onDeleteAll, onClose, onOpenTutorial, onStatus }: LiteSettingsDialogProps) {
  const tr = (english: string, variables?: MessageParams) => translate(language, english, variables);
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
          <section className="settings-group ai-settings-group">
            <div className="settings-group-title"><LiteIcon name="sparkles" /><div><strong>{tr("Artificial intelligence")}</strong><span>{tr("Optional provider for better direct answers")}</span></div></div>
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
