import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiControls, ClipboardCaptureControls, QuickContextControls, RetentionControls } from "./SettingsControls";
import { settingsFixture } from "../test/fixtures";

const apiMocks = vi.hoisted(() => ({
  previewRetentionChange: vi.fn(),
  applyRetentionChange: vi.fn(),
}));

vi.mock("../api/tauri", () => apiMocks);

const tr = (value: string) => value;

describe("shared settings controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts with automatic clipboard monitoring and effects disabled", () => {
    render(<ClipboardCaptureControls settings={settingsFixture} tr={tr} onPatch={vi.fn(() => Promise.resolve())} />);
    expect(screen.getByLabelText("Monitor clipboard copies")).not.toBeChecked();
    expect(screen.getByLabelText("Screenshot automatic captures")).toBeDisabled();
    expect(screen.getByLabelText("Quick Context automatic captures")).toBeDisabled();
  });

  it("enables automatic children without changing their stored values", () => {
    const onPatch = vi.fn(() => Promise.resolve());
    const { rerender } = render(<ClipboardCaptureControls settings={settingsFixture} tr={tr} onPatch={onPatch} />);
    fireEvent.click(screen.getByLabelText("Monitor clipboard copies"));
    expect(onPatch).toHaveBeenCalledWith({ clipboard_monitor_enabled: true });
    rerender(<ClipboardCaptureControls settings={{ ...settingsFixture, clipboard_monitor_enabled: true }} tr={tr} onPatch={onPatch} />);
    expect(screen.getByLabelText("Screenshot automatic captures")).not.toBeDisabled();
  });

  it("keeps automatic Quick Context disabled when the global toggle is off", () => {
    render(<QuickContextControls settings={{ ...settingsFixture, clipboard_monitor_enabled: true, quick_context_enabled: false }} tr={tr} onPatch={vi.fn(() => Promise.resolve())} />);
    render(<ClipboardCaptureControls settings={{ ...settingsFixture, clipboard_monitor_enabled: true, quick_context_enabled: false, clipboard_monitor_quick_context_enabled: true }} tr={tr} onPatch={vi.fn(() => Promise.resolve())} />);
    expect(screen.getByLabelText("Quick Context automatic captures")).toBeDisabled();
  });

  it("only submits an API key after blur or Enter", () => {
    const onSaveCredential = vi.fn(() => Promise.resolve());
    render(<AiControls settings={settingsFixture} options={[{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "Flash" }] }]} tr={tr} onPatch={vi.fn(() => Promise.resolve())} onSaveCredential={onSaveCredential} onClearCredential={vi.fn(() => Promise.resolve())} />);
    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "secret" } });
    expect(onSaveCredential).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSaveCredential).toHaveBeenCalledWith("secret");
  });

  it("previews affected history before applying a shorter retention period", async () => {
    apiMocks.previewRetentionChange.mockResolvedValue({
      selection_token: "retention-token",
      capture_count: 12,
      image_count: 2,
      file_count: 1,
      reclaimable_bytes: 4096,
      oldest_captured_at: null,
      newest_captured_at: null,
    });
    apiMocks.applyRetentionChange.mockResolvedValue({
      settings: { ...settingsFixture, retention_policy: "1_day" },
      deleted_count: 0,
      reclaimed_bytes: 0,
    });
    const onApplied = vi.fn(() => Promise.resolve());
    render(<RetentionControls settings={settingsFixture} tr={tr} onApplied={onApplied} onStatus={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Keep clipboard history for"), { target: { value: "1_day" } });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(apiMocks.applyRetentionChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep existing items" }));
    await waitFor(() => expect(apiMocks.applyRetentionChange).toHaveBeenCalledWith("1_day", "keep", "retention-token"));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("applies a policy immediately when no existing items are affected", async () => {
    apiMocks.previewRetentionChange.mockResolvedValue({
      selection_token: "empty-retention-token",
      capture_count: 0,
      image_count: 0,
      file_count: 0,
      reclaimable_bytes: 0,
      oldest_captured_at: null,
      newest_captured_at: null,
    });
    apiMocks.applyRetentionChange.mockResolvedValue({
      settings: { ...settingsFixture, retention_policy: "never" },
      deleted_count: 0,
      reclaimed_bytes: 0,
    });
    render(<RetentionControls settings={settingsFixture} tr={tr} onApplied={vi.fn()} onStatus={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Keep clipboard history for"), { target: { value: "never" } });
    await waitFor(() => expect(apiMocks.applyRetentionChange).toHaveBeenCalledWith("never", "delete", "empty-retention-token"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("deletes existing expired history only after explicit confirmation", async () => {
    apiMocks.previewRetentionChange.mockResolvedValue({
      selection_token: "delete-retention-token",
      capture_count: 4,
      image_count: 1,
      file_count: 0,
      reclaimable_bytes: 2048,
      oldest_captured_at: null,
      newest_captured_at: null,
    });
    apiMocks.applyRetentionChange.mockResolvedValue({
      settings: { ...settingsFixture, retention_policy: "3_days" },
      deleted_count: 4,
      reclaimed_bytes: 2048,
    });
    render(<RetentionControls settings={settingsFixture} tr={tr} onApplied={vi.fn()} onStatus={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Keep clipboard history for"), { target: { value: "3_days" } });
    fireEvent.click(await screen.findByRole("button", { name: "Delete now" }));
    await waitFor(() => expect(apiMocks.applyRetentionChange).toHaveBeenCalledWith("3_days", "delete", "delete-retention-token"));
  });
});
