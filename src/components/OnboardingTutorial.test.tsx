import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OnboardingTutorial } from "./OnboardingTutorial";
import { settingsFixture } from "../test/fixtures";

const tr = (value: string) => value;
const baseProps = () => ({
  tr,
  settings: settingsFixture,
  aiOptions: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "Flash" }] }],
  captureHotkey: "Ctrl + Shift + C",
  pasteHotkey: "Ctrl + Shift + V",
  onPatch: vi.fn(() => Promise.resolve()),
  onSaveCredential: vi.fn(() => Promise.resolve()),
  onClearCredential: vi.fn(() => Promise.resolve()),
  saveState: "idle" as const,
  saveError: null,
  onRetry: vi.fn(() => Promise.resolve()),
  awaitPending: vi.fn(() => Promise.resolve()),
  onFinish: vi.fn(),
});

describe("configurable welcome", () => {
  it("keeps six steps and exposes capture controls", () => {
    render(<OnboardingTutorial {...baseProps()} />);
    expect(screen.getByText(/keeps your captures encrypted/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByLabelText("Monitor clipboard copies")).toBeInTheDocument();
    expect(screen.getByText("2 / 6")).toBeInTheDocument();
  });

  it("lets the user configure quick categories and Windows startup", () => {
    render(<OnboardingTutorial {...baseProps()} />);
    fireEvent.click(screen.getByLabelText("Go to step 4: Quick access"));
    expect(screen.getByLabelText("Enable quick context panel")).toBeInTheDocument();
    expect(screen.getByText("Ctrl + Shift + F")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Go to step 5: Personalization"));
    expect(screen.getByLabelText("Start with Windows")).toBeInTheDocument();
  });

  it("waits for pending saves before marking onboarding completed", async () => {
    const props = baseProps();
    render(<OnboardingTutorial {...props} />);
    fireEvent.click(screen.getByText("Skip tutorial"));
    await waitFor(() => expect(props.awaitPending).toHaveBeenCalled());
    expect(props.onPatch).toHaveBeenCalledWith({ onboarding_completed: true });
    expect(props.onFinish).toHaveBeenCalled();
  });
});
