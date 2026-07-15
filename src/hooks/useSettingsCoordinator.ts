import { useCallback, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import * as api from "../api/tauri";
import type { Settings } from "../types";

export type SettingsSaveState = "idle" | "saving" | "saved" | "error";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useSettingsCoordinator(initial: Settings) {
  const [settings, setSettings] = useState(initial);
  const [saveState, setSaveState] = useState<SettingsSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const settingsRef = useRef(initial);
  const versionRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPatchRef = useRef<Partial<Settings> | null>(null);

  const updateOptimistic = useCallback((next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const loadPersisted = useCallback((next: Settings) => {
    if (versionRef.current === 0) updateOptimistic(next);
  }, [updateOptimistic]);

  const setPersisted = useCallback((next: Settings) => {
    updateOptimistic(next);
    void emit("settings-updated", next).catch(() => undefined);
  }, [updateOptimistic]);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    versionRef.current += 1;
    const version = versionRef.current;
    const next = { ...settingsRef.current, ...patch };
    lastPatchRef.current = patch;
    updateOptimistic(next);
    setSaveError(null);

    const save = async () => {
      setSaveState("saving");
      try {
        const saved = await api.saveSettings(next);
        if (version === versionRef.current) {
          updateOptimistic(saved);
          setSaveState("saved");
          void emit("settings-updated", saved).catch(() => undefined);
        }
      } catch (error) {
        if (version === versionRef.current) {
          setSaveState("error");
          setSaveError(errorMessage(error));
          try {
            const persisted = await api.getSettings();
            if (version === versionRef.current) updateOptimistic(persisted);
          } catch {
            // Keep the optimistic state available for another attempt.
          }
        }
        throw error;
      }
    };

    queueRef.current = queueRef.current.catch(() => undefined).then(save);
    return queueRef.current;
  }, [updateOptimistic]);

  const retrySettings = useCallback(() => {
    return lastPatchRef.current ? patchSettings(lastPatchRef.current) : Promise.resolve();
  }, [patchSettings]);

  const awaitPendingSettings = useCallback(() => queueRef.current, []);

  return {
    settings,
    settingsRef,
    saveState,
    saveError,
    loadPersisted,
    setPersisted,
    patchSettings,
    retrySettings,
    awaitPendingSettings,
  };
}
