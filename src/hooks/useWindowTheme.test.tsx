import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowTheme } from "./useWindowTheme";

const theme = vi.fn();
const onThemeChanged = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ theme, onThemeChanged }),
}));

describe("window theme", () => {
  let themeListener: ((event: { payload: "light" | "dark" }) => void) | undefined;
  let mediaListener: ((event: { matches: boolean }) => void) | undefined;
  const unlisten = vi.fn();
  const removeEventListener = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    themeListener = undefined;
    mediaListener = undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
          mediaListener = listener;
        },
        removeEventListener,
      })),
    });
    theme.mockResolvedValue("dark");
    onThemeChanged.mockImplementation(async (listener) => {
      themeListener = listener;
      return unlisten;
    });
  });

  it("uses the native window theme and follows Windows theme changes", async () => {
    const { result } = renderHook(() => useWindowTheme());

    expect(result.current).toBe("light");
    await waitFor(() => expect(result.current).toBe("dark"));

    act(() => themeListener?.({ payload: "light" }));
    expect(result.current).toBe("light");

    act(() => mediaListener?.({ matches: true }));
    expect(result.current).toBe("light");
  });

  it("cleans up native and browser theme listeners", async () => {
    const { unmount } = renderHook(() => useWindowTheme());
    await waitFor(() => expect(themeListener).toBeDefined());

    unmount();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });
});
