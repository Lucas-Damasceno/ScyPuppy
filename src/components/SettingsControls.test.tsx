import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiControls, ClipboardCaptureControls, QuickContextControls } from "./SettingsControls";
import { settingsFixture } from "../test/fixtures";

const tr = (value: string) => value;

describe("shared settings controls", () => {
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
});
