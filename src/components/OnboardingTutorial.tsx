import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageParams } from "../appMessages";
import type { AiProviderOption, Settings } from "../types";
import type { SettingsSaveState } from "../hooks/useSettingsCoordinator";
import { AiControls, ClipboardCaptureControls, QuickContextControls, SettingsSaveFeedback } from "./SettingsControls";
import { BrandMark } from "./BrandMark";

type Translate = (english: string, variables?: MessageParams) => string;
type PatchSettings = (patch: Partial<Settings>) => Promise<void>;

type OnboardingTutorialProps = {
  tr: Translate;
  settings: Settings;
  aiOptions: AiProviderOption[];
  captureHotkey: string;
  pasteHotkey: string;
  onPatch: PatchSettings;
  onSaveCredential: (value: string) => Promise<void>;
  onClearCredential: () => Promise<void>;
  saveState: SettingsSaveState;
  saveError: unknown;
  onRetry: () => Promise<void>;
  awaitPending: () => Promise<void>;
  onFinish: () => void;
};

const stepIcons = ["sparkles", "capture", "contexts", "paste", "settings", "lock"] as const;

export function OnboardingTutorial({
  tr, settings, aiOptions, captureHotkey, pasteHotkey, onPatch, onSaveCredential,
  onClearCredential, saveState, saveError, onRetry, awaitPending, onFinish,
}: OnboardingTutorialProps) {
  const [step, setStep] = useState(0);
  const [isCompleting, setIsCompleting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const total = 6;
  const stepLabels = [tr("Overview"), tr("Capture"), tr("Contexts"), tr("Quick access"), tr("Personalization"), tr("Summary")];
  const isConfigurableStep = step === 1 || step === 3 || step === 4;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    if (step > 0) headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const complete = useCallback(async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    try {
      await awaitPending();
      if (!settings.onboarding_completed) await onPatch({ onboarding_completed: true });
      await awaitPending();
      onFinish();
    } catch {
      // The coordinator keeps the welcome open and exposes the inline retry action.
    } finally {
      setIsCompleting(false);
    }
  }, [awaitPending, isCompleting, onFinish, onPatch, settings.onboarding_completed]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(target?.closest("input, select, textarea, button"));
      if (event.key === "Escape") {
        event.preventDefault();
        void complete();
      } else if (!isEditing && event.key === "ArrowRight" && step < total - 1) {
        setStep((value) => value + 1);
      } else if (!isEditing && event.key === "ArrowLeft" && step > 0) {
        setStep((value) => value - 1);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [complete, step]);

  const copy = [
    {
      eyebrow: tr("Welcome to ScryPuppy"),
      title: tr("Your useful clipboard, ready when you need it"),
      description: tr("ScryPuppy keeps your captures encrypted on this computer. Choose how it should work before you start."),
    },
    {
      eyebrow: tr("Step 2 · Capture"),
      title: tr("Choose what Ctrl + C may save"),
      description: tr("Turn clipboard monitoring on to save normal text and image copies. Screenshots and the Quick Context panel remain independent choices."),
    },
    {
      eyebrow: tr("Step 3 · Contexts"),
      title: tr("Keep related copies together"),
      description: tr("Assign one or more contexts from the Quick Context panel, create a new one while capturing, or organize a copy later from its details."),
    },
    {
      eyebrow: tr("Step 4 · Quick access"),
      title: tr("Find and paste without breaking your flow"),
      description: tr("Quick Paste reuses a previous copy, while Magic Search gives you a direct answer and keeps the source one click away."),
    },
    {
      eyebrow: tr("Step 5 · Personalize"),
      title: tr("Configure language, startup, and optional AI"),
      description: tr("Choose the language, whether ScryPuppy starts with Windows, and an optional AI provider. Every change is saved immediately."),
    },
    {
      eyebrow: tr("Step 6 · Privacy and summary"),
      title: tr("Review your choices before you start"),
      description: tr("Review your choices below. You can reopen this tutorial from Settings without resetting any value."),
    },
  ][step];

  return <div className="onboarding-backdrop">
    <section ref={dialogRef} className={`onboarding-modal ${isConfigurableStep ? "is-configurable" : ""} ${step === total - 1 ? "is-summary" : ""}`} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description" tabIndex={-1}>
      <header className="onboarding-header">
        <div className="onboarding-brand"><BrandMark /></div>
        <strong>ScryPuppy</strong>
        <span className="onboarding-current-step">{step + 1} / {total} · {stepLabels[step]}</span>
        <button className="onboarding-skip" onClick={() => void complete()} disabled={isCompleting}>{step === total - 1 ? tr("Close") : tr("Skip tutorial")}</button>
      </header>

      <div className="onboarding-content">
        <div className="onboarding-copy">
          <span className="onboarding-eyebrow">{copy.eyebrow}</span>
          <h2 ref={headingRef} id="onboarding-title" tabIndex={-1}>{copy.title}</h2>
          <p id="onboarding-description">{copy.description}</p>
          {step === 0 && <WelcomeBenefits tr={tr} />}
          {step === 1 && <><PrivacyCallout tr={tr} /><CaptureStep settings={settings} tr={tr} captureHotkey={captureHotkey} onPatch={onPatch} /></>}
          {step === 2 && <ContextGuide tr={tr} />}
          {step === 3 && <QuickContextStep settings={settings} tr={tr} pasteHotkey={pasteHotkey} onPatch={onPatch} />}
          {step === 4 && <PersonalizationStep settings={settings} aiOptions={aiOptions} tr={tr} onPatch={onPatch} onSaveCredential={onSaveCredential} onClearCredential={onClearCredential} />}
          {step === 5 && <PrivacySummary settings={settings} tr={tr} />}
        </div>
        <div className={`onboarding-visual onboarding-visual-${step}`} aria-hidden="true">
          <TutorialIcon name={stepIcons[step]} />
          <VisualPreview step={step} tr={tr} settings={settings} />
        </div>
      </div>

      <footer className="onboarding-footer">
        <div className="onboarding-progress" aria-label={tr("Tutorial progress")}>
          {Array.from({ length: total }, (_, index) => <button key={index} className={index === step ? "is-active" : index < step ? "is-complete" : ""} onClick={() => setStep(index)} disabled={isCompleting} aria-label={`${tr("Go to step")} ${index + 1}: ${stepLabels[index]}`} aria-current={index === step ? "step" : undefined}><span>{index + 1}</span></button>)}
        </div>
        <div className="onboarding-save-status"><SettingsSaveFeedback tr={tr} state={saveState} error={saveError} onRetry={() => void onRetry()} /></div>
        <span className="onboarding-step-count">{step + 1} / {total}</span>
        <div className="onboarding-actions">
          {step > 0 && <button className="secondary-button" onClick={() => setStep((value) => value - 1)} disabled={isCompleting}>{tr("Back")}</button>}
          <button className="primary-button" onClick={() => step === total - 1 ? void complete() : setStep((value) => value + 1)} disabled={isCompleting}>
            {isCompleting ? tr("Saving...") : step === total - 1 ? tr("Start using ScryPuppy") : tr("Continue")}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}

function CaptureStep({ settings, tr, captureHotkey, onPatch }: { settings: Settings; tr: Translate; captureHotkey: string; onPatch: PatchSettings }) {
  return <div className="onboarding-settings-panel">
    <ClipboardCaptureControls settings={settings} tr={tr} onPatch={onPatch} />
    <div className="onboarding-guide"><GuideRow label={tr("Explicit capture shortcut")} value={captureHotkey} /><GuideRow label={tr("Normal clipboard copy")} value="Ctrl + C" /></div>
  </div>;
}

function QuickContextStep({ settings, tr, pasteHotkey, onPatch }: { settings: Settings; tr: Translate; pasteHotkey: string; onPatch: PatchSettings }) {
  return <div className="onboarding-settings-panel"><div className="onboarding-guide"><GuideRow label={tr("Quick Paste shortcut")} value={pasteHotkey} /><GuideRow label="Magic Search" value="Ctrl + Shift + F" /></div><QuickContextControls settings={settings} tr={tr} onPatch={onPatch} /></div>;
}

function PersonalizationStep({ settings, aiOptions, tr, onPatch, onSaveCredential, onClearCredential }: { settings: Settings; aiOptions: AiProviderOption[]; tr: Translate; onPatch: PatchSettings; onSaveCredential: (value: string) => Promise<void>; onClearCredential: () => Promise<void> }) {
  return <div className="onboarding-settings-panel">
    <label className="onboarding-setting-row"><span>{tr("Language")}</span><select value={settings.language} onChange={(event) => void onPatch({ language: event.currentTarget.value as Settings["language"] })}><option value="en">English</option><option value="pt-BR">Português</option></select></label>
    <label className="toggle-setting"><span>{tr("Start with Windows")}</span><input type="checkbox" checked={settings.launch_at_startup} onChange={(event) => void onPatch({ launch_at_startup: event.currentTarget.checked })} /></label>
    <AiControls settings={settings} options={aiOptions} tr={tr} onPatch={onPatch} onSaveCredential={onSaveCredential} onClearCredential={onClearCredential} />
  </div>;
}

function WelcomeBenefits({ tr }: { tr: Translate }) {
  return <><div className="onboarding-benefits"><span>{tr("Encrypted local storage")}</span><span>{tr("Clipboard monitor off")}</span><span>{tr("No telemetry")}</span></div><p className="onboarding-privacy-note">{tr("Nothing is monitored until you choose to turn clipboard monitoring on.")}</p></>;
}

function PrivacyCallout({ tr }: { tr: Translate }) {
  return <div className="onboarding-callout" role="note"><strong>{tr("Your clipboard may contain sensitive information")}</strong><span>{tr("If monitoring is enabled, copied text and images are saved locally to your history.")}</span></div>;
}

function ContextGuide({ tr }: { tr: Translate }) {
  return <div className="onboarding-guide"><GuideRow label={tr("Everything")} value={tr("Every copied item")} /><GuideRow label={tr("Contexts")} value={tr("Work, clients, and topics")} /><GuideRow label={tr("Quick context panel")} value={tr("Choose immediately after capturing")} /></div>;
}

function PrivacySummary({ settings, tr }: { settings: Settings; tr: Translate }) {
  const ai = settings.ai_api_key_configured ? tr("Configured") : tr("Not configured");
  return <div className="onboarding-guide onboarding-summary"><GuideRow label={tr("Data location")} value={settings.data_dir || tr("Local computer")} /><GuideRow label={tr("Clipboard monitor")} value={settings.clipboard_monitor_enabled ? tr("On") : tr("Off")} /><GuideRow label={tr("Automatic screenshot")} value={settings.clipboard_monitor_capture_screenshots ? tr("On") : tr("Off")} /><GuideRow label={tr("Explicit screenshot")} value={settings.capture_screenshots ? tr("On") : tr("Off")} /><GuideRow label={tr("Quick Context panel")} value={settings.quick_context_enabled ? tr("On") : tr("Off")} /><GuideRow label={tr("Automatic Quick Context")} value={settings.clipboard_monitor_quick_context_enabled ? tr("On") : tr("Off")} /><GuideRow label={tr("Startup")} value={settings.launch_at_startup ? tr("On") : tr("Off")} /><GuideRow label={tr("AI")} value={ai} /></div>;
}

function GuideRow({ label, value }: { label: string; value: string }) {
  return <div className="onboarding-guide-row"><span>{label}</span><kbd>{value}</kbd></div>;
}

function VisualPreview({ step, tr, settings }: { step: number; tr: Translate; settings: Settings }) {
  if (step === 0) return <div className="tutorial-orbit"><i /><i /><i /><strong>ScryPuppy</strong></div>;
  if (step === 1) return <div className="tutorial-capture-card"><span>{tr("Clipboard monitor")}</span><strong>{settings.clipboard_monitor_enabled ? tr("On") : tr("Off")}</strong><small>{tr("Sensitive content warning")}</small></div>;
  if (step === 2) return <div className="tutorial-context-stack"><span>{tr("Everything")}</span><span>{tr("Client A")}</span><span>{tr("Project notes")}</span></div>;
  if (step === 3) return <div className="tutorial-search"><span>⌕</span><strong>{tr("Search history...")}</strong><i>Magic Search</i></div>;
  if (step === 4) return <div className="tutorial-settings-preview"><div><span>{tr("AI provider key")}</span><strong>••••••••••••</strong><i>{tr("Saved securely")}</i></div><div><span>{tr("Start with Windows")}</span><strong className="tutorial-toggle"><i /></strong></div></div>;
  return <div className="tutorial-privacy"><span>SQLCipher</span><span>AES-256-GCM</span><span>{tr("Windows Credential Manager")}</span></div>;
}

type TutorialIconName = typeof stepIcons[number];

function TutorialIcon({ name }: { name: TutorialIconName }) {
  const paths: Record<TutorialIconName, string[]> = {
    sparkles: ["m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z", "m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z", "m5 13 .7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7Z"],
    capture: ["M8 3H5a2 2 0 0 0-2 2v3", "M16 3h3a2 2 0 0 1 2 2v3", "M8 21H5a2 2 0 0 1-2-2v-3", "M16 21h3a2 2 0 0 0 2-2v-3", "M12 8v8", "M8 12h8"],
    contexts: ["M4 6h7l2 2h7v10H4z", "M8 3h7l2 2", "M9 12h6", "M12 9v6"],
    paste: ["M9 5h6", "M9 3h6v4H9z", "M6 5H4v16h16V5h-2", "M8 12h8", "M8 16h5"],
    settings: [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    ],
    lock: ["M6 10h12v10H6z", "M8 10V7a4 4 0 0 1 8 0v3", "M12 14v2"],
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name].map((path) => <path d={path} key={path} />)}</svg>;
}
