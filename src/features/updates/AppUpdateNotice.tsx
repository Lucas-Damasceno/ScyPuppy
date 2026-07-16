import type { MessageParams } from "../../appMessages";
import type { AppLanguage } from "../../i18n";
import { translate } from "../../i18n";
import { BrandMark } from "../../components/BrandMark";
import { LiteIcon } from "../lite/LiteIcon";
import { displayAppVersion, type AppUpdaterController } from "./useAppUpdater";

type AppUpdateNoticeProps = {
  updater: AppUpdaterController;
  language: AppLanguage;
};

function releaseDate(value: string | null, language: AppLanguage): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(language === "pt-BR" ? "pt-BR" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function AppUpdateNotice({ updater, language }: AppUpdateNoticeProps) {
  if (!updater.noticeVisible || !["available", "downloading", "installing", "error"].includes(updater.status)) {
    return null;
  }

  const tr = (english: string, variables?: MessageParams) => translate(language, english, variables);
  const isBusy = updater.status === "downloading" || updater.status === "installing";
  const formattedDate = releaseDate(updater.date, language);
  const availableVersion = updater.version ? displayAppVersion(updater.version) : "";

  return (
    <aside className={`lite-update-notice is-${updater.status}`} role="status" aria-live="polite">
      <div className="lite-update-brand" aria-hidden="true"><BrandMark /></div>
      <div className="lite-update-content">
        <span className="lite-update-eyebrow">
          {updater.status === "error" ? tr("Update interrupted") : tr("New ScryPuppy version")}
        </span>
        <strong>
          {updater.status === "downloading"
            ? tr("Downloading version {version}", { version: availableVersion })
            : updater.status === "installing"
              ? tr("Preparing to restart")
              : updater.status === "error"
                ? tr("The update could not be completed")
                : tr("Version {version} is ready", { version: availableVersion })}
        </strong>
        {updater.status === "available" && (
          <p>{tr("Update securely without losing your local history.")}</p>
        )}
        {updater.status === "error" && (
          <p>{tr("Check your connection and try again. Your current version is unchanged.")}</p>
        )}
        {isBusy && (
          <div className={`lite-update-progress ${updater.progress === null ? "is-indeterminate" : ""}`} aria-label={tr("Update progress")}>
            <span style={{ width: updater.progress === null ? "34%" : `${updater.progress}%` }} />
          </div>
        )}
        {updater.status === "downloading" && (
          <small>{updater.progress === null ? tr("Downloading securely...") : tr("{progress}% downloaded", { progress: updater.progress })}</small>
        )}
        {updater.status === "installing" && <small>{tr("ScryPuppy will reopen automatically.")}</small>}
        {updater.status === "available" && updater.notes && (
          <details className="lite-update-notes">
            <summary>{tr("What changed")}{formattedDate ? <span>{formattedDate}</span> : null}</summary>
            <p>{updater.notes}</p>
          </details>
        )}
        <div className="lite-update-actions">
          {updater.status === "available" && (
            <>
              <button type="button" className="is-secondary" onClick={updater.dismissNotice}>{tr("Later")}</button>
              <button type="button" className="is-primary" onClick={() => void updater.installUpdate()}>
                <LiteIcon name="download" size={14} />{tr("Update now")}
              </button>
            </>
          )}
          {updater.status === "error" && (
            <>
              <button type="button" className="is-secondary" onClick={updater.dismissNotice}>{tr("Close")}</button>
              <button type="button" className="is-primary" onClick={() => void updater.checkForUpdates(true)}>
                <LiteIcon name="refresh" size={14} />{tr("Try again")}
              </button>
            </>
          )}
        </div>
      </div>
      {!isBusy && (
        <button className="lite-update-close" type="button" onClick={updater.dismissNotice} aria-label={tr("Close update notice")}>
          <LiteIcon name="close" size={14} />
        </button>
      )}
    </aside>
  );
}

type AppUpdateSettingsProps = {
  updater: AppUpdaterController;
  language: AppLanguage;
};

export function AppUpdateSettings({ updater, language }: AppUpdateSettingsProps) {
  const tr = (english: string, variables?: MessageParams) => translate(language, english, variables);
  const isBusy = updater.status === "checking" || updater.status === "downloading" || updater.status === "installing";
  const hasUpdate = updater.status === "available";
  const installedVersion = updater.currentVersion ? displayAppVersion(updater.currentVersion) : null;
  const availableVersion = updater.version ? displayAppVersion(updater.version) : "";
  const busyLabel = updater.status === "checking"
    ? tr("Checking...")
    : updater.status === "downloading"
      ? tr("Downloading securely...")
      : tr("Preparing to restart");

  return (
    <section className="settings-group lite-update-settings">
      <div className="settings-group-title">
        <LiteIcon name="download" />
        <div>
          <strong>{tr("Application updates")}</strong>
          <span>{tr("Signed and delivered securely through GitHub Releases")}</span>
        </div>
      </div>
      <div className="lite-update-settings-row">
        <div>
          <span>{tr("Installed version")}</span>
          <strong>{installedVersion ? `v${installedVersion}` : tr("Loading...")}</strong>
          {hasUpdate && <small>{tr("Version {version} is available", { version: availableVersion })}</small>}
          {updater.status === "up-to-date" && <small className="is-success"><LiteIcon name="check" size={12} />{tr("You are up to date")}</small>}
          {updater.status === "error" && <small className="is-error">{tr("Could not check for updates")}</small>}
          {updater.status === "downloading" && <small>{tr("{progress}% downloaded", { progress: updater.progress ?? 0 })}</small>}
          {updater.status === "installing" && <small>{tr("Preparing to restart")}</small>}
        </div>
        {hasUpdate ? (
          <button className="lite-update-settings-primary" type="button" onClick={() => void updater.installUpdate()}>
            <LiteIcon name="download" size={14} />{tr("Update now")}
          </button>
        ) : (
          <button type="button" disabled={isBusy} onClick={() => void updater.checkForUpdates(true)}>
            <LiteIcon name={isBusy ? "loader" : "refresh"} size={14} />
            {isBusy ? busyLabel : tr("Check for updates")}
          </button>
        )}
      </div>
    </section>
  );
}
