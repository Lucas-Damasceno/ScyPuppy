import type { Settings } from "../types";

const baseSettings: Settings = {
  capture_screenshots: true,
  launch_at_startup: false,
  language: "en",
  hotkey: "CommandOrControl+Shift+C",
  reference_hotkey: "CommandOrControl+Shift+S",
  paste_hotkey: "CommandOrControl+Shift+V",
  data_dir: "",
  ai_provider: "deepseek",
  ai_model: "deepseek-v4-flash",
  ai_api_key: "",
  ai_api_key_configured: false,
  magic_search_engine: "local",
  clipboard_monitor_enabled: false,
  clipboard_monitor_capture_screenshots: false,
  clipboard_monitor_quick_context_enabled: false,
  quick_context_enabled: true,
  quick_context_after_reference: false,
  quick_context_timeout_seconds: 8,
  quick_context_show_preview: true,
  quick_context_show_recent: true,
  onboarding_completed: false,
};

export function createDefaultSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...baseSettings, ...overrides };
}

export const appDefaultSettings = createDefaultSettings();

export const liteDefaultSettings = createDefaultSettings({
  quick_context_show_preview: false,
  quick_context_show_recent: false,
  onboarding_completed: true,
});
