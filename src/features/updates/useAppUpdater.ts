import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

const automaticCheckDelayMs = 8_000;
const automaticCheckIntervalMs = 6 * 60 * 60 * 1_000;
const dismissedUpdateDurationMs = 6 * 60 * 60 * 1_000;
const dismissedUpdateStoragePrefix = "scrypuppy:update-dismissed:";

export type AppUpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "up-to-date"
  | "error";

export type AppUpdaterState = {
  status: AppUpdaterStatus;
  currentVersion: string | null;
  version: string | null;
  notes: string | null;
  date: string | null;
  progress: number | null;
  error: string | null;
};

export type AppUpdaterController = AppUpdaterState & {
  noticeVisible: boolean;
  checkForUpdates: (manual?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissNotice: () => void;
};

const initialState: AppUpdaterState = {
  status: "idle",
  currentVersion: null,
  version: null,
  notes: null,
  date: null,
  progress: null,
  error: null,
};

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function dismissedStorageKey(version: string): string {
  return `${dismissedUpdateStoragePrefix}${version}`;
}

export function isUpdateDismissed(version: string, now = Date.now()): boolean {
  try {
    const dismissedAt = Number(window.localStorage.getItem(dismissedStorageKey(version)));
    return Number.isFinite(dismissedAt) && now - dismissedAt < dismissedUpdateDurationMs;
  } catch {
    return false;
  }
}

export function displayAppVersion(version: string): string {
  const beta = version.match(/^(\d+)\.(\d+)\.0-beta\.(\d+)$/);
  return beta ? `${beta[1]}.${beta[2]}.${beta[3]}` : version;
}

export function updateDownloadProgress(
  event: DownloadEvent,
  downloadedBytes: number,
  contentLength: number | null,
): { downloadedBytes: number; contentLength: number | null; progress: number | null } {
  if (event.event === "Started") {
    const nextLength = event.data.contentLength ?? null;
    return { downloadedBytes: 0, contentLength: nextLength, progress: nextLength ? 0 : null };
  }
  if (event.event === "Progress") {
    const nextDownloaded = downloadedBytes + event.data.chunkLength;
    return {
      downloadedBytes: nextDownloaded,
      contentLength,
      progress: contentLength
        ? Math.min(100, Math.round((nextDownloaded / contentLength) * 100))
        : null,
    };
  }
  return { downloadedBytes, contentLength, progress: 100 };
}

export function useAppUpdater(): AppUpdaterController {
  const previewMode = new URLSearchParams(window.location.search).get("docs-preview");
  const previewUpdate = import.meta.env.DEV
    && (previewMode === "update" || previewMode === "update-settings");
  const [state, setState] = useState<AppUpdaterState>(() => previewUpdate
    ? {
        status: "available",
        currentVersion: "1.0.7",
        version: "1.0.8",
        notes: "A smoother update experience, reliability improvements, and small interface refinements.",
        date: new Date().toISOString(),
        progress: null,
        error: null,
      }
    : initialState);
  const [noticeVisible, setNoticeVisible] = useState(previewUpdate);
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  const closeCurrentUpdate = useCallback(async () => {
    const current = updateRef.current;
    updateRef.current = null;
    if (current) await current.close().catch(() => undefined);
  }, []);

  const checkForUpdates = useCallback(async (manual = true) => {
    if (previewUpdate || checkingRef.current || installingRef.current || !isTauriRuntime()) return;
    checkingRef.current = true;
    if (manual) {
      setState((current) => ({ ...current, status: "checking", progress: null, error: null }));
    }

    try {
      const currentVersion = await getVersion();
      const update = await check({ timeout: 15_000 });
      await closeCurrentUpdate();

      if (!update) {
        setState({
          status: manual ? "up-to-date" : "idle",
          currentVersion,
          version: null,
          notes: null,
          date: null,
          progress: null,
          error: null,
        });
        if (manual) setNoticeVisible(false);
        return;
      }

      updateRef.current = update;
      setState({
        status: "available",
        currentVersion: update.currentVersion || currentVersion,
        version: update.version,
        notes: update.body?.trim() || null,
        date: update.date ?? null,
        progress: null,
        error: null,
      });
      setNoticeVisible(manual || !isUpdateDismissed(update.version));
    } catch (error) {
      if (manual) {
        setState((current) => ({
          ...current,
          status: "error",
          progress: null,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      checkingRef.current = false;
    }
  }, [closeCurrentUpdate, previewUpdate]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current || previewUpdate) return;
    installingRef.current = true;
    setNoticeVisible(true);
    setState((current) => ({ ...current, status: "downloading", progress: 0, error: null }));

    let downloadedBytes = 0;
    let contentLength: number | null = null;
    try {
      await update.downloadAndInstall((event) => {
        const next = updateDownloadProgress(event, downloadedBytes, contentLength);
        downloadedBytes = next.downloadedBytes;
        contentLength = next.contentLength;
        setState((current) => ({
          ...current,
          status: event.event === "Finished" ? "installing" : "downloading",
          progress: next.progress,
        }));
      });
      setState((current) => ({ ...current, status: "installing", progress: 100 }));
      await relaunch();
    } catch (error) {
      installingRef.current = false;
      setState((current) => ({
        ...current,
        status: "error",
        progress: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [previewUpdate]);

  const dismissNotice = useCallback(() => {
    if (state.version) {
      try {
        window.localStorage.setItem(dismissedStorageKey(state.version), String(Date.now()));
      } catch {
        // The update remains available in Settings even when persistence is unavailable.
      }
    }
    setNoticeVisible(false);
  }, [state.version]);

  useEffect(() => {
    if (previewUpdate || !isTauriRuntime()) return undefined;
    getVersion()
      .then((currentVersion) => setState((current) => ({ ...current, currentVersion })))
      .catch(() => undefined);

    const initialTimeout = window.setTimeout(() => void checkForUpdates(false), automaticCheckDelayMs);
    const interval = window.setInterval(() => void checkForUpdates(false), automaticCheckIntervalMs);
    return () => {
      window.clearTimeout(initialTimeout);
      window.clearInterval(interval);
    };
  }, [checkForUpdates, previewUpdate]);

  useEffect(() => () => {
    void closeCurrentUpdate();
  }, [closeCurrentUpdate]);

  return {
    ...state,
    noticeVisible,
    checkForUpdates,
    installUpdate,
    dismissNotice,
  };
}
