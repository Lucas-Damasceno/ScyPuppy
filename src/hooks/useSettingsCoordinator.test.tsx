import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import { settingsFixture } from "../test/fixtures";
import { useSettingsCoordinator } from "./useSettingsCoordinator";

vi.mock("../api/tauri", () => ({
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()) }));

describe("settings coordinator", () => {
  it("does not let an older response overwrite a newer patch", async () => {
    let resolveFirst!: (value: typeof settingsFixture) => void;
    const firstResponse = new Promise<typeof settingsFixture>((resolve) => { resolveFirst = resolve; });
    vi.mocked(api.saveSettings)
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce({ ...settingsFixture, language: "en" });
    const { result } = renderHook(() => useSettingsCoordinator(settingsFixture));

    let pending!: Promise<void>;
    act(() => {
      result.current.patchSettings({ language: "pt-BR" });
      pending = result.current.patchSettings({ language: "en" });
    });
    resolveFirst({ ...settingsFixture, language: "pt-BR" });
    await act(async () => { await pending; });
    expect(result.current.settings.language).toBe("en");
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("reloads persisted settings after the latest save fails", async () => {
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(api.getSettings).mockResolvedValue({ ...settingsFixture, language: "en" });
    const { result } = renderHook(() => useSettingsCoordinator(settingsFixture));
    await act(async () => {
      await expect(result.current.patchSettings({ language: "pt-BR" })).rejects.toThrow("offline");
    });
    expect(result.current.settings.language).toBe("en");
    expect(result.current.saveState).toBe("error");
  });
});
