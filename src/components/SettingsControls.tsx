import { useEffect, useId, useState } from "react";
import * as api from "../api/tauri";
import { formatAppError, type MessageParams } from "../appMessages";
import type { AiProviderOption, RetentionApplyResult, RetentionPolicy, RetentionPreview, Settings } from "../types";
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
    <ReadOnlyShortcut label={tr("Knowledge Base shortcut")} value={formatHotkey(settings.reference_hotkey)} />
    <ReadOnlyShortcut label={tr("Paste from history")} value={formatHotkey(settings.paste_hotkey)} />
    <ReadOnlyShortcut label={tr("Search with ScryPuppy")} value="Ctrl + Shift + F" />
  </div>;
}

const retentionOptions: Array<{ value: RetentionPolicy; label: string }> = [
  { value: "1_day", label: "1 day" },
  { value: "3_days", label: "3 days" },
  { value: "7_days", label: "7 days" },
  { value: "1_month", label: "1 month" },
  { value: "3_months", label: "3 months" },
  { value: "6_months", label: "6 months" },
  { value: "12_months", label: "12 months" },
  { value: "never", label: "Never delete" },
];

export function RetentionControls({ settings, tr, onApplied, onStatus }: {
  settings: Settings;
  tr: Translate;
  onApplied: (result: RetentionApplyResult) => void | Promise<void>;
  onStatus: (message: string) => void;
}) {
  const [draftPolicy, setDraftPolicy] = useState<RetentionPolicy>(settings.retention_policy);
  const [pending, setPending] = useState<{ policy: RetentionPolicy; preview: RetentionPreview } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraftPolicy(settings.retention_policy), [settings.retention_policy]);

  async function selectPolicy(policy: RetentionPolicy) {
    setDraftPolicy(policy);
    if (policy === settings.retention_policy) return;
    setBusy(true);
    try {
      const preview = await api.previewRetentionChange(policy);
      if (preview.capture_count === 0) {
        const result = await api.applyRetentionChange(policy, "delete", preview.selection_token);
        await onApplied(result);
        onStatus(tr("History retention updated."));
      } else {
        setPending({ policy, preview });
      }
    } catch (error) {
      setDraftPolicy(settings.retention_policy);
      onStatus(formatAppError(error, tr));
    } finally {
      setBusy(false);
    }
  }

  async function applyPolicy(existingAction: "delete" | "keep") {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await api.applyRetentionChange(pending.policy, existingAction, pending.preview.selection_token);
      await onApplied(result);
      setPending(null);
      onStatus(existingAction === "delete"
        ? tr("Deleted {count} expired items and reclaimed up to {size}.", { count: result.deleted_count, size: formatRetentionBytes(result.reclaimed_bytes) })
        : tr("History retention updated. Existing items were kept."));
    } catch (error) {
      onStatus(formatAppError(error, tr));
    } finally {
      setBusy(false);
    }
  }

  function cancelPending() {
    if (busy) return;
    setPending(null);
    setDraftPolicy(settings.retention_policy);
  }

  return <>
    <div className="settings-control-stack">
      <label>
        <span>{tr("Keep clipboard history for")}</span>
        <select value={draftPolicy} disabled={busy} onChange={(event) => void selectPolicy(event.currentTarget.value as RetentionPolicy)}>
          {retentionOptions.map((option) => <option key={option.value} value={option.value}>{tr(option.label)}</option>)}
        </select>
      </label>
      <span className="settings-inline-help">{tr("Expired items are deleted automatically. Knowledge Base items are always kept.")}</span>
    </div>
    {pending && <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) cancelPending(); }}>
      <section className="settings-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="retention-impact-title" aria-describedby="retention-impact-description">
        <header>
          <div className="confirmation-icon" aria-hidden="true">!</div>
          <div><span className="eyebrow">{tr("History retention")}</span><h2 id="retention-impact-title">{tr("Apply retention to existing history?")}</h2></div>
          <button className="icon-button" disabled={busy} onClick={cancelPending} aria-label={tr("Close")}>{"\u00d7"}</button>
        </header>
        <div className="confirmation-body">
          <p id="retention-impact-description">{tr("{count} items are already older than the new limit and use up to {size} of local storage.", { count: pending.preview.capture_count, size: formatRetentionBytes(pending.preview.reclaimable_bytes) })}</p>
          <p>{tr("Keeping them makes the new rule apply only to captures saved after this change. You can still remove kept items manually.")}</p>
          <div className="confirmation-notice">{tr("Knowledge Base items are not included and will not be deleted.")}</div>
        </div>
        <footer>
          <span>{tr("Choose how to apply the new limit")}</span>
          <div className="confirmation-actions">
            <button className="secondary-button" disabled={busy} onClick={cancelPending}>{tr("Cancel")}</button>
            <button className="secondary-button" disabled={busy} onClick={() => void applyPolicy("keep")}>{tr("Keep existing items")}</button>
            <button className="confirmation-danger-button" disabled={busy} onClick={() => void applyPolicy("delete")}>{tr("Delete now")}</button>
          </div>
        </footer>
      </section>
    </div>}
  </>;
}

function formatRetentionBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
