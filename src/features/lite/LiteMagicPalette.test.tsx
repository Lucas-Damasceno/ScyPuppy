import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/tauri";
import type { Capture, EvidenceItem, MagicSearchDocument } from "../../types";
import { settingsFixture } from "../../test/fixtures";
import { LiteMagicPalette } from "./LiteMagicPalette";

vi.mock("../../api/tauri", () => ({
  closeMagicSearchWindow: vi.fn(),
  copyTextToClipboard: vi.fn(),
  generateMagicSearch: vi.fn(),
  getCapture: vi.fn(),
  getLocalSearchStatus: vi.fn(),
  getSettings: vi.fn(),
  listContexts: vi.fn(),
  openMagicDocument: vi.fn(),
  previewMagicSearch: vi.fn(),
}));

vi.mock("../../hooks/useTauriEvent", () => ({ useTauriEvent: vi.fn() }));

const evidence = Array.from({ length: 5 }, (_, index): EvidenceItem => ({
  capture_id: `capture-${index + 1}`,
  captured_at: `2026-07-${String(index + 10).padStart(2, "0")}T12:00:00Z`,
  context_names: [],
  app_name: `App ${index + 1}`,
  application_id: `app.${index + 1}`,
  window_title: `Window ${index + 1}`,
  excerpt: `Evidence ${index + 1}`,
  matched_fields: ["semantic"],
  asset_paths: [],
}));

const searchDocument: MagicSearchDocument = {
  id: "search-1",
  root_id: "search-1",
  previous_document_id: null,
  version: 1,
  title: "Direct answer",
  query: "Find evidence",
  markdown: "I found: Evidence 1 [capture:capture-1]",
  provider: "local",
  model: "deterministic",
  retrieval_engine: "fts5+e5+rrf",
  retrieval_model: "intfloat/multilingual-e5-small",
  filters: {
    query: "Find evidence",
    context_id: null,
    tag: null,
    date_from: null,
    date_to: null,
    limit: 5,
    previous_document_id: null,
    response_mode: "direct",
  },
  generation_warning: null,
  evidence_count: evidence.length,
  created_at: "2026-07-18T12:00:00Z",
  evidence,
  response_mode: "direct",
  sensitive_value: null,
  answer_value: null,
};

function captureFromEvidence(item: EvidenceItem): Capture {
  return {
    id: item.capture_id,
    content_text: item.excerpt,
    captured_at: item.captured_at,
    source_app_name: item.app_name,
    source_app_id: item.application_id,
    source_process_id: null,
    source_process_path: null,
    window_title: item.window_title,
    window_id: null,
    platform: "windows",
    kind: "capture",
    content_kind: "plain_text",
    metadata: {},
    assets: [],
    representations: [],
    files: [],
    clipboard_formats: [],
    tags: [],
    entities: [],
    ocr: null,
    contexts: [],
  };
}

describe("local Magic Search evidence", () => {
  beforeEach(() => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settingsFixture, magic_search_engine: "local" });
    vi.mocked(api.getLocalSearchStatus).mockResolvedValue({
      phase: "ready",
      model_id: "intfloat/multilingual-e5-small",
      model_name: "Multilingual E5 Small",
      cache_bytes: 1,
      indexed_count: 5,
      total_count: 5,
      pending_count: 0,
      error: null,
      can_download: false,
      can_retry: false,
      can_remove: true,
    });
    vi.mocked(api.listContexts).mockResolvedValue([]);
    vi.mocked(api.generateMagicSearch).mockResolvedValue(searchDocument);
    vi.mocked(api.getCapture).mockImplementation(async (id) => captureFromEvidence(evidence.find((item) => item.capture_id === id)!));
  });

  it("shows five ranked sources and opens the selected capture", async () => {
    const { container } = render(<LiteMagicPalette />);
    const input = screen.getByLabelText("Magic Search");
    await waitFor(() => expect(input).toBeEnabled());

    fireEvent.change(input, { target: { value: "Find evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask ScryPuppy" }));

    await screen.findByText("Evidence used");
    const sourceButtons = container.querySelectorAll<HTMLButtonElement>(".lite-direct-sources .lite-document-source-open");
    expect(sourceButtons).toHaveLength(5);
    expect(api.generateMagicSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, response_mode: "direct" }));

    fireEvent.click(sourceButtons[3]);
    await waitFor(() => expect(api.getCapture).toHaveBeenCalledWith("capture-4"));
    expect(await screen.findByRole("dialog", { name: "App 4" })).toBeVisible();
  });
});
