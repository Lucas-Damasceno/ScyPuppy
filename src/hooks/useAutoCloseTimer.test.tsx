import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCloseTimer } from "./useAutoCloseTimer";

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-close timer", () => {
  it("runs after the configured delay", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();

    renderHook(() => useAutoCloseTimer({
      enabled: true,
      delaySeconds: 5,
      resetKey: 0,
      onElapsed,
    }));

    act(() => vi.advanceTimersByTime(4_999));
    expect(onElapsed).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("restarts the full delay after user activity", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const { rerender } = renderHook(
      ({ resetKey }) => useAutoCloseTimer({
        enabled: true,
        delaySeconds: 3,
        resetKey,
        onElapsed,
      }),
      { initialProps: { resetKey: 0 } },
    );

    act(() => vi.advanceTimersByTime(2_000));
    rerender({ resetKey: 1 });
    act(() => vi.advanceTimersByTime(2_999));
    expect(onElapsed).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("waits until a save finishes before starting a new delay", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const { rerender } = renderHook(
      ({ paused }) => useAutoCloseTimer({
        enabled: true,
        delaySeconds: 3,
        paused,
        resetKey: 0,
        onElapsed,
      }),
      { initialProps: { paused: true } },
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(onElapsed).not.toHaveBeenCalled();
    rerender({ paused: false });
    act(() => vi.advanceTimersByTime(3_000));
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("does not run when auto-close is set to never", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();

    renderHook(() => useAutoCloseTimer({
      enabled: true,
      delaySeconds: 0,
      resetKey: 0,
      onElapsed,
    }));

    act(() => vi.runAllTimers());
    expect(onElapsed).not.toHaveBeenCalled();
  });
});
