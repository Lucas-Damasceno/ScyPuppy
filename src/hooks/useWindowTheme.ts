import { useEffect, useState } from "react";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";

function preferredTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useWindowTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(preferredTheme);

  useEffect(() => {
    let active = true;
    let nativeThemeAvailable = false;
    let unlistenTheme: (() => void) | undefined;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = (nextTheme: Theme) => {
      if (active) setTheme(nextTheme);
    };
    const handleMediaChange = (event: MediaQueryListEvent) => {
      if (!nativeThemeAvailable) applyTheme(event.matches ? "dark" : "light");
    };

    media?.addEventListener("change", handleMediaChange);

    if ("__TAURI_INTERNALS__" in window) {
      const appWindow = getCurrentWindow();
      void appWindow.theme()
        .then((nativeTheme) => {
          if (!nativeTheme) return;
          nativeThemeAvailable = true;
          applyTheme(nativeTheme);
        })
        .catch(() => undefined);
      void appWindow.onThemeChanged(({ payload }) => {
        nativeThemeAvailable = true;
        applyTheme(payload);
      }).then((unlisten) => {
        if (active) unlistenTheme = unlisten;
        else unlisten();
      }).catch(() => undefined);
    }

    return () => {
      active = false;
      media?.removeEventListener("change", handleMediaChange);
      unlistenTheme?.();
    };
  }, []);

  return theme;
}
