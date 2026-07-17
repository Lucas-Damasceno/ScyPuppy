import { useEffect, useMemo, useState } from "react";
import * as api from "../../api/tauri";
import { formatAppError } from "../../appMessages";
import { captureDisplayText, translate, type AppLanguage } from "../../i18n";
import type { Context, SmartContextCondition, SmartContextRule, SmartContextRulePreview } from "../../types";
import { compactContent } from "./formatters";
import { LiteIcon } from "./LiteIcon";

type SmartContextDialogProps = {
  context: Context;
  language: AppLanguage;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
  onError: (message: string) => void;
};

const newCondition = (): SmartContextCondition => ({
  id: null,
  field: "application",
  operator: "contains",
  value: "",
});

function newRule(contextId: string): SmartContextRule {
  return {
    id: null,
    context_id: contextId,
    name: "",
    enabled: true,
    match_mode: "all",
    conditions: [newCondition()],
    created_at: null,
    updated_at: null,
  };
}

export function SmartContextDialog({ context, language, onClose, onChanged, onError }: SmartContextDialogProps) {
  const tr = (english: string, variables?: Record<string, string | number>) => translate(language, english, variables);
  const [rules, setRules] = useState<SmartContextRule[]>([]);
  const [editing, setEditing] = useState<SmartContextRule | null>(null);
  const [preview, setPreview] = useState<SmartContextRulePreview | null>(null);
  const [applyExisting, setApplyExisting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SmartContextRule | null>(null);

  const isValid = Boolean(editing?.name.trim())
    && Boolean(editing?.conditions.length)
    && editing!.conditions.every((condition) => condition.value.trim());

  async function loadRules() {
    setIsLoading(true);
    try {
      setRules(await api.listContextRules(context.id));
    } catch (error) {
      onError(formatAppError(error, tr));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, [context.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSaving) return;
      if (pendingDelete) setPendingDelete(null);
      else if (editing) setEditing(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, isSaving, onClose, pendingDelete]);

  function updateEditing(patch: Partial<SmartContextRule>) {
    setEditing((current) => current ? { ...current, ...patch } : current);
    setPreview(null);
  }

  function updateCondition(index: number, patch: Partial<SmartContextCondition>) {
    if (!editing) return;
    const conditions = editing.conditions.map((condition, candidate) => candidate === index
      ? { ...condition, ...patch }
      : condition);
    updateEditing({ conditions });
  }

  async function previewRule() {
    if (!editing || !isValid || isPreviewing) return;
    setIsPreviewing(true);
    try {
      setPreview(await api.previewContextRule(editing));
    } catch (error) {
      onError(formatAppError(error, tr));
    } finally {
      setIsPreviewing(false);
    }
  }

  async function saveRule() {
    if (!editing || !isValid || isSaving) return;
    setIsSaving(true);
    try {
      const result = await api.saveContextRule(editing, applyExisting);
      await loadRules();
      setEditing(null);
      setPreview(null);
      setApplyExisting(false);
      await onChanged(result.associations_added > 0
        ? tr("Automation saved and {count} existing captures were organized.", { count: result.associations_added })
        : tr("Automation saved. New matching captures will be organized automatically."));
    } catch (error) {
      onError(formatAppError(error, tr));
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleRule(rule: SmartContextRule) {
    if (!rule.id || busyRuleId) return;
    setBusyRuleId(rule.id);
    try {
      const result = await api.saveContextRule({ ...rule, enabled: !rule.enabled }, false);
      setRules((current) => current.map((item) => item.id === rule.id ? result.rule : item));
    } catch (error) {
      onError(formatAppError(error, tr));
    } finally {
      setBusyRuleId(null);
    }
  }

  async function deleteRule() {
    if (!pendingDelete?.id || isSaving) return;
    setIsSaving(true);
    try {
      await api.deleteContextRule(pendingDelete.id);
      setRules((current) => current.filter((rule) => rule.id !== pendingDelete.id));
      setPendingDelete(null);
      await onChanged(tr("Automation deleted. Existing context assignments were preserved."));
    } catch (error) {
      onError(formatAppError(error, tr));
    } finally {
      setIsSaving(false);
    }
  }

  const conditionLabels = useMemo(() => ({
    application: tr("Application"),
    content_type: tr("Content type"),
    text: tr("Text or OCR"),
    file_extension: tr("File extension"),
    file_path: tr("File path"),
    window_title: tr("Window title"),
  }), [language]);

  const operatorLabels = useMemo(() => ({
    equals: tr("is exactly"),
    contains: tr("contains"),
    matches: tr("matches regex"),
  }), [language]);

  return <div className="lite-modal-backdrop" onMouseDown={(event) => {
    if (event.currentTarget === event.target && !isSaving) onClose();
  }}>
    <section className="lite-modal-surface lite-smart-context-modal" role="dialog" aria-modal="true" aria-labelledby="smart-context-title">
      <header>
        <div className="lite-context-picker-heading">
          <span className="lite-context-picker-icon"><LiteIcon name="sparkles" /></span>
          <div>
            <span className="lite-eyebrow">{tr("Smart context")}</span>
            <h2 id="smart-context-title">{tr("Automate {name}", { name: context.name })}</h2>
            <p>{tr("Route matching captures here automatically, without removing other contexts.")}</p>
          </div>
        </div>
        <button className="lite-icon-button" onClick={onClose} disabled={isSaving} aria-label={tr("Close")}><LiteIcon name="close" /></button>
      </header>

      {editing ? <>
        <div className="lite-smart-editor">
          <section className="lite-form-section">
            <div className="lite-form-section-heading"><span>{tr("Rule details")}</span><small>{tr("Local and private")}</small></div>
            <label className="lite-field-label">
              <span>{tr("Rule name")}</span>
              <input autoFocus value={editing.name} maxLength={80} onChange={(event) => updateEditing({ name: event.currentTarget.value })} placeholder={tr("For example: Design work")} />
            </label>
            <div className="lite-smart-mode-row">
              <span>{tr("A capture should match")}</span>
              <div className="lite-segmented-control">
                <button type="button" className={editing.match_mode === "all" ? "is-selected" : ""} onClick={() => updateEditing({ match_mode: "all" })}>{tr("All conditions")}</button>
                <button type="button" className={editing.match_mode === "any" ? "is-selected" : ""} onClick={() => updateEditing({ match_mode: "any" })}>{tr("Any condition")}</button>
              </div>
            </div>
          </section>

          <section className="lite-form-section">
            <div className="lite-form-section-heading"><span>{tr("Conditions")}</span><small>{editing.conditions.length}/12</small></div>
            <div className="lite-smart-conditions">
              {editing.conditions.map((condition, index) => <div className="lite-smart-condition" key={condition.id ?? index}>
                <select value={condition.field} aria-label={tr("Condition field")} onChange={(event) => {
                  const field = event.currentTarget.value as SmartContextCondition["field"];
                  updateCondition(index, { field, operator: field === "content_type" ? "equals" : "contains", value: "" });
                }}>
                  {Object.entries(conditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select value={condition.operator} aria-label={tr("Condition operator")} onChange={(event) => updateCondition(index, { operator: event.currentTarget.value as SmartContextCondition["operator"] })}>
                  {(condition.field === "content_type" ? ["equals"] : ["contains", "equals", "matches"]).map((value) => <option key={value} value={value}>{operatorLabels[value as keyof typeof operatorLabels]}</option>)}
                </select>
                {condition.field === "content_type" ? <select value={condition.value} aria-label={tr("Content type")} onChange={(event) => updateCondition(index, { value: event.currentTarget.value })}>
                  <option value="">{tr("Choose a type")}</option>
                  <option value="text">{tr("Text")}</option>
                  <option value="formatted_text">{tr("Formatted text")}</option>
                  <option value="image">{tr("Images")}</option>
                  <option value="link">{tr("Links")}</option>
                  <option value="file">{tr("Files")}</option>
                  <option value="folder">{tr("Folders")}</option>
                  <option value="application">{tr("Applications")}</option>
                </select> : <input value={condition.value} maxLength={500} onChange={(event) => updateCondition(index, { value: event.currentTarget.value })} placeholder={condition.operator === "matches" ? tr("Enter a regular expression") : tr("Enter a value")} />}
                <button type="button" className="lite-smart-remove" disabled={editing.conditions.length === 1} onClick={() => updateEditing({ conditions: editing.conditions.filter((_, candidate) => candidate !== index) })} aria-label={tr("Remove condition")}><LiteIcon name="trash" size={14} /></button>
              </div>)}
            </div>
            <button type="button" className="lite-smart-add-condition" disabled={editing.conditions.length >= 12} onClick={() => updateEditing({ conditions: [...editing.conditions, newCondition()] })}><LiteIcon name="plus" size={14} />{tr("Add condition")}</button>
          </section>

          <section className="lite-form-section lite-smart-preview-section">
            <div>
              <div className="lite-form-section-heading"><span>{tr("Preview")}</span><small>{tr("No data will be changed")}</small></div>
              <p>{tr("Check how many existing captures match before saving the rule.")}</p>
            </div>
            <button type="button" className="lite-secondary-action" disabled={!isValid || isPreviewing} onClick={() => void previewRule()}>{isPreviewing ? <LiteIcon name="loader" /> : <LiteIcon name="eye" />}{tr("Preview matches")}</button>
            {preview && <div className="lite-smart-preview-result">
              <strong>{tr("{count} existing captures match", { count: preview.match_count })}</strong>
              {preview.samples.length > 0 ? <ul>{preview.samples.map((capture) => <li key={capture.id}>{compactContent(captureDisplayText(language, capture))}</li>)}</ul> : <p>{tr("No existing captures match this rule yet.")}</p>}
            </div>}
            <label className="lite-check-row">
              <input type="checkbox" checked={applyExisting} onChange={(event) => setApplyExisting(event.currentTarget.checked)} />
              <span><strong>{tr("Organize existing matches when saving")}</strong><small>{tr("Existing context assignments will be preserved.")}</small></span>
            </label>
          </section>
        </div>
        <footer>
          <button className="lite-context-picker-cancel" type="button" disabled={isSaving} onClick={() => { setEditing(null); setPreview(null); setApplyExisting(false); }}>{tr("Back")}</button>
          <span />
          <button className="lite-primary-button" type="button" disabled={!isValid || isSaving} onClick={() => void saveRule()}>{isSaving && <LiteIcon name="loader" />}{tr("Save automation")}</button>
        </footer>
      </> : <>
        <div className="lite-smart-rule-list">
          <div className="lite-smart-intro">
            <div><strong>{tr("Let ScryPuppy organize as you copy")}</strong><p>{tr("Rules run locally after capture and again after OCR finishes.")}</p></div>
            <button className="lite-primary-button" onClick={() => setEditing(newRule(context.id))}><LiteIcon name="plus" />{tr("New automation")}</button>
          </div>
          {isLoading ? <div className="lite-smart-empty"><LiteIcon name="loader" /><strong>{tr("Loading automations...")}</strong></div>
            : rules.length === 0 ? <div className="lite-smart-empty"><span><LiteIcon name="sparkles" /></span><strong>{tr("No automations yet")}</strong><p>{tr("Create a rule to route future captures into this context automatically.")}</p></div>
              : rules.map((rule) => <article className={`lite-smart-rule-card ${rule.enabled ? "" : "is-disabled"}`} key={rule.id}>
                <button className={`lite-toggle ${rule.enabled ? "is-on" : ""}`} type="button" role="switch" aria-checked={rule.enabled} aria-label={tr("Toggle {name}", { name: rule.name })} disabled={busyRuleId === rule.id} onClick={() => void toggleRule(rule)}><span /></button>
                <div><strong>{rule.name}</strong><p>{tr(rule.match_mode === "all" ? "Matches all {count} conditions" : "Matches any of {count} conditions", { count: rule.conditions.length })}</p></div>
                <button className="lite-icon-button" disabled={busyRuleId === rule.id} onClick={() => { setEditing({ ...rule, conditions: rule.conditions.map((condition) => ({ ...condition })) }); setPreview(null); }} aria-label={tr("Edit automation")}><LiteIcon name="edit" /></button>
                <button className="lite-icon-button is-danger" disabled={busyRuleId === rule.id} onClick={() => setPendingDelete(rule)} aria-label={tr("Delete automation")}><LiteIcon name="trash" /></button>
              </article>)}
        </div>
        <footer className="lite-smart-footer"><span><LiteIcon name="lock" size={13} />{tr("Rules and previews stay on this computer")}</span><button className="lite-context-picker-cancel" onClick={onClose}>{tr("Done")}</button></footer>
      </>}

      {pendingDelete && <div className="lite-smart-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-rule-title">
        <div><span><LiteIcon name="trash" /></span><div><strong id="delete-rule-title">{tr("Delete “{name}”?", { name: pendingDelete.name })}</strong><p>{tr("Future captures will stop using this rule. Existing assignments will remain.")}</p></div></div>
        <footer><button onClick={() => setPendingDelete(null)} disabled={isSaving}>{tr("Cancel")}</button><button className="is-danger" onClick={() => void deleteRule()} disabled={isSaving}>{tr("Delete automation")}</button></footer>
      </div>}
    </section>
  </div>;
}
