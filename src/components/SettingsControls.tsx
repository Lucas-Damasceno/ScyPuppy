import { useEffect, useId, useState } from "react";
import { formatAppError, type MessageParams } from "../appMessages";
import type { AiProviderOption, Settings } from "../types";
import type { SettingsSaveState } from "../hooks/useSettingsCoordinator";

type Translate = (english: string, variables?: MessageParams) => string;
type PatchSettings = (patch: Partial<Settings>) => Promise<void>;

export function ClipboardCaptureControls({ settings, tr, onPatch }: { settings: Settings; tr: Translate; onPatch: PatchSettings }) {
  const monitorDisabled = !settings.clipboard_monitor_enabled;
  const quickContextDisabled = monitorDisabled || !settings.quick_context_enabled;
  const dependencyHintId = useId();
  return <div className="settings-control-stack">
    <ToggleSetting
      label={tr("Monitor clipboard copies")}
      description={tr("Save copied text and images to your local history.")}
      checked={settings.clipboard_monitor_enabled}
      onChange={(checked) => onPatch({ clipboard_monitor_enabled: checked })}
    />
    <div className={`nested-settings ${monitorDisabled ? "is-disabled" : ""}`} aria-disabled={monitorDisabled}>
      <ToggleSetting label={tr("Screenshot automatic captures")} checked={settings.clipboard_monitor_capture_screenshots} disabled={monitorDisabled} onChange={(checked) => onPatch({ clipboard_monitor_capture_screenshots: checked })} />
      <ToggleSetting label={tr("Quick Context automatic captures")} checked={settings.clipboard_monitor_quick_context_enabled} disabled={quickContextDisabled} describedBy={dependencyHintId} onChange={(checked) => onPatch({ clipboard_monitor_quick_context_enabled: checked })} />
      {(monitorDisabled || !settings.quick_context_enabled) && <p id={dependencyHintId} className="settings-dependency-hint">
        {monitorDisabled ? tr("Turn on clipboard monitoring to configure automatic effects.") : tr("Enable the Quick Context panel to use it with automatic captures.")}
      </p>}
    </div>
    <ToggleSetting label={tr("Screenshot explicit captures")} checked={settings.capture_screenshots} onChange={(checked) => onPatch({ capture_screenshots: checked })} />
  </div>;
}

export function QuickContextControls({ settings, tr, onPatch }: { settings: Settings; tr: Translate; onPatch: PatchSettings }) {
  return <div className="settings-control-stack">
    <ToggleSetting label={tr("Enable quick context panel")} checked={settings.quick_context_enabled} onChange={(checked) => onPatch({ quick_context_enabled: checked })} />
    <label><span>{tr("Auto-close delay")}</span><select value={settings.quick_context_timeout_seconds} onChange={(event) => onPatch({ quick_context_timeout_seconds: Number(event.currentTarget.value) })}><option value={3}>{tr("3 seconds")}</option><option value={5}>{tr("5 seconds")}</option><option value={8}>{tr("8 seconds")}</option><option value={15}>{tr("15 seconds")}</option><option value={0}>{tr("Never")}</option></select></label>
  </div>;
}

export function StartupAndShortcutsControls({ settings, tr, onPatch }: { settings: Settings; tr: Translate; onPatch: PatchSettings }) {
  return <div className="settings-control-stack">
    <ToggleSetting label={tr("Start with Windows")} checked={settings.launch_at_startup} onChange={(checked) => onPatch({ launch_at_startup: checked })} />
    <ReadOnlyShortcut label={tr("Global shortcut")} value={formatHotkey(settings.hotkey)} />
    <ReadOnlyShortcut label={tr("Paste from history")} value={formatHotkey(settings.paste_hotkey)} />
    <ReadOnlyShortcut label={tr("Search with ScryPuppy")} value="Ctrl + Shift + F" />
  </div>;
}

export function AiControls({ settings, options, tr, onPatch, onSaveCredential, onClearCredential }: {
  settings: Settings;
  options: AiProviderOption[];
  tr: Translate;
  onPatch: PatchSettings;
  onSaveCredential: (value: string) => Promise<void>;
  onClearCredential: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings.ai_api_key);
  const [editing, setEditing] = useState(false);
  const provider = options.find((option) => option.id === settings.ai_provider);

  useEffect(() => {
    if (!editing) setDraft(settings.ai_api_key);
  }, [editing, settings.ai_api_key]);

  async function commitCredential() {
    setEditing(false);
    if (draft.trim()) await onSaveCredential(draft.trim());
  }

  return <div className="settings-control-stack">
    <label><span>{tr("Provider")}</span><select value={settings.ai_provider} onChange={(event) => {
      const nextProvider = options.find((option) => option.id === event.currentTarget.value);
      void onPatch({ ai_provider: event.currentTarget.value, ai_model: nextProvider?.models[0]?.id ?? settings.ai_model });
    }}>{options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>
    <label><span>{tr("Model")}</span><select value={settings.ai_model} onChange={(event) => void onPatch({ ai_model: event.currentTarget.value })}>{(provider?.models ?? []).map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
    <label className="api-key-row"><span>{tr("API key")}</span><input type="password" value={draft} onFocus={() => setEditing(true)} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={() => void commitCredential()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitCredential(); } }} placeholder={settings.ai_api_key_configured ? tr("Key stored in Credential Manager") : tr("Enter your key")} aria-describedby="ai-api-key-help" /></label>
    <span id="ai-api-key-help" className="settings-inline-help">{tr("The key is stored only in Windows Credential Manager.")}</span>
    {(draft.trim() || settings.ai_api_key_configured) && <div className="credential-actions">
      {draft.trim() && <button type="button" className="settings-inline-button" onClick={() => void commitCredential()}>{tr("Save API key")}</button>}
      {settings.ai_api_key_configured && <button type="button" className="settings-inline-button is-danger" onClick={() => void onClearCredential()}>{tr("Remove saved key")}</button>}
    </div>}
  </div>;
}

export function SettingsSaveFeedback({ tr, state, error, onRetry }: { tr: Translate; state: SettingsSaveState; error: unknown; onRetry?: () => void }) {
  if (state === "saving") return <span className="settings-save-feedback is-saving">{tr("Saving...")}</span>;
  if (state === "error") return <span className="settings-save-feedback is-error">{tr("Could not save settings.")} {onRetry && <button type="button" onClick={onRetry}>{tr("Try again")}</button>} {error != null && <small>{formatAppError(error, tr)}</small>}</span>;
  if (state === "saved") return <span className="settings-save-feedback is-saved">{tr("Saved")}</span>;
  return null;
}

function ReadOnlyShortcut({ label, value }: { label: string; value: string }) {
  return <div className="read-only-setting"><span>{label}</span><kbd>{value}</kbd></div>;
}

function ToggleSetting({ label, description, checked, disabled = false, describedBy, onChange }: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange: (checked: boolean) => void | Promise<void>;
}) {
  return <label className="toggle-setting">
    <span className="settings-control-copy"><strong>{label}</strong>{description && <small>{description}</small>}</span>
    <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(event) => void onChange(event.currentTarget.checked)} />
  </label>;
}

function formatHotkey(value?: string) {
  return (value ?? "").replace("CommandOrControl", "Ctrl").replace(/\+/g, " + ");
}
