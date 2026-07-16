import { useEffect } from "react";

type AutoCloseTimerOptions = {
  enabled: boolean;
  delaySeconds: number;
  paused?: boolean;
  resetKey: unknown;
  onElapsed: () => void;
};

export function useAutoCloseTimer({
  enabled,
  delaySeconds,
  paused = false,
  resetKey,
  onElapsed,
}: AutoCloseTimerOptions): void {
  useEffect(() => {
    if (!enabled || paused || delaySeconds <= 0) return;

    const timeout = window.setTimeout(onElapsed, delaySeconds * 1000);
    return () => window.clearTimeout(timeout);
  }, [delaySeconds, enabled, onElapsed, paused, resetKey]);
}
