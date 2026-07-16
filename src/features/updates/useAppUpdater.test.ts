import { beforeEach, describe, expect, it } from "vitest";
import { displayAppVersion, isUpdateDismissed, updateDownloadProgress } from "./useAppUpdater";

describe("displayAppVersion", () => {
  it("maps the internal beta SemVer to the public ScryPuppy version", () => {
    expect(displayAppVersion("1.0.0-beta.8")).toBe("1.0.8");
    expect(displayAppVersion("2.4.3")).toBe("2.4.3");
  });
});

describe("updateDownloadProgress", () => {
  it("calculates determinate download progress from updater events", () => {
    const started = updateDownloadProgress(
      { event: "Started", data: { contentLength: 1_000 } },
      0,
      null,
    );
    const halfway = updateDownloadProgress(
      { event: "Progress", data: { chunkLength: 500 } },
      started.downloadedBytes,
      started.contentLength,
    );

    expect(halfway.progress).toBe(50);
    expect(updateDownloadProgress(
      { event: "Finished" },
      halfway.downloadedBytes,
      halfway.contentLength,
    ).progress).toBe(100);
  });

  it("keeps progress indeterminate when the server omits content length", () => {
    const started = updateDownloadProgress({ event: "Started", data: {} }, 0, null);
    expect(updateDownloadProgress(
      { event: "Progress", data: { chunkLength: 128 } },
      started.downloadedBytes,
      started.contentLength,
    ).progress).toBeNull();
  });
});

describe("isUpdateDismissed", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  it("expires a dismissed update after six hours", () => {
    const now = new Date("2026-07-16T12:00:00Z").valueOf();
    window.localStorage.setItem("scrypuppy:update-dismissed:1.0.8", String(now - (5 * 60 * 60 * 1_000)));
    expect(isUpdateDismissed("1.0.8", now)).toBe(true);

    window.localStorage.setItem("scrypuppy:update-dismissed:1.0.8", String(now - (7 * 60 * 60 * 1_000)));
    expect(isUpdateDismissed("1.0.8", now)).toBe(false);
  });
});
