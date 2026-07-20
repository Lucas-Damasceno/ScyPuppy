import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/tauri";
import type { Capture, Context, EvidenceItem, MagicSearchDocument } from "../../types";
import { settingsFixture } from "../../test/fixtures";
import { LiteMagicPalette } from "./LiteMagicPalette";

vi.mock("../../api/tauri", () => ({
  closeMagicSearchWindow: vi.fn(),
  generateMagicSearch: vi.fn(),
  getCapture: vi.fn(),
  getLocalSearchStatus: vi.fn(),
  getSettings: vi.fn(),
  listContexts: vi.fn(),
  openMagicDocument: vi.fn(),
  previewMagicSearch: vi.fn(),
  searchMagicItems: vi.fn(),
}));

vi.mock("../../hooks/useTauriEvent", () => ({ useTauriEvent: vi.fn() }));

const evidence = Array.from({ length: 25 }, (_, index): EvidenceItem => ({
  capture_id: `capture-${index + 1}`,
  captured_at: `2026-07-${String((index % 18) + 1).padStart(2, "0")}T12:00:00Z`,
  context_names: ["Apollo"],
  app_name: `App ${index + 1}`,
  application_id: null,
  window_title: `Window ${index + 1}`,
  excerpt: `Matched excerpt ${index + 1}`,
  matched_fields: ["semantic"],
  asset_paths: [],
}));

const contexts: Context[] = [
  { id: "apollo", name: "Apollo", normalized_name: "apollo", slug: "apollo", created_at: "2026-07-01", updated_at: "2026-07-01", capture_count: 12 },
  { id: "work", name: "Work", normalized_name: "work", slug: "work", created_at: "2026-07-01", updated_at: "2026-07-01", capture_count: 8 },
];

const generatedDocument: MagicSearchDocument = {
  id: "document-1", root_id: "document-1", previous_document_id: null, version: 1,
  title: "Application Apollo", query: "Summarize Apollo", markdown: "# Application Apollo",
  provider: "deepseek", model: "deepseek-v4-flash", retrieval_engine: "filtered-scope", retrieval_model: null,
  filters: { query: "Summarize Apollo", context_ids: ["apollo", "work"], include_knowledge_base: true, include_inbox: true, tag: null, date_from: null, date_to: null, limit: 0, previous_document_id: null, response_mode: "document" },
  generation_warning: null, evidence_count: 25, created_at: "2026-07-18T12:00:00Z", evidence,
  response_mode: "document", sensitive_value: null, answer_value: null,
};

function captureFromEvidence(item: EvidenceItem): Capture {
  return {
    id: item.capture_id, content_text: item.excerpt, captured_at: item.captured_at,
    source_app_name: item.app_name, source_app_id: null, source_process_id: null, source_process_path: null,
    window_title: item.window_title, window_id: null, platform: "windows", kind: "capture", content_kind: "text",
    metadata: {}, assets: [], representations: [], files: [], clipboard_formats: [], tags: [], entities: [], ocr: null, contexts: [],
  };
}

describe("LiteMagicPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue({ ...settingsFixture, ai_api_key_configured: true });
    vi.mocked(api.getLocalSearchStatus).mockResolvedValue({
      phase: "ready", model_id: "intfloat/multilingual-e5-small", model_name: "Multilingual E5 Small",
      cache_bytes: 1, indexed_count: 25, total_count: 25, pending_count: 0, error: null,
      can_download: false, can_retry: false, can_remove: true,
    });
    vi.mocked(api.listContexts).mockResolvedValue(contexts);
    vi.mocked(api.previewMagicSearch).mockResolvedValue({ evidence_count: 25, available_count: 25, batch_count: 2 });
    vi.mocked(api.generateMagicSearch).mockResolvedValue(generatedDocument);
    vi.mocked(api.searchMagicItems).mockImplementation(async ({ offset }) => ({
      items: evidence.slice(offset, offset + 20), total: evidence.length, has_more: offset + 20 < evidence.length,
    }));
    vi.mocked(api.getCapture).mockImplementation(async (id) => captureFromEvidence(evidence.find((item) => item.capture_id === id)!));
  });

  it("shows a paginated ranked list and opens any selected capture", async () => {
    const { container } = render(<LiteMagicPalette />);
    const input = await screen.findByLabelText("Magic Search");
    fireEvent.change(input, { target: { value: "Apollo application" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText("Items found")).toBeVisible();
    expect(container.querySelectorAll(".lite-search-results .lite-document-source-open")).toHaveLength(20);
    expect(api.searchMagicItems).toHaveBeenCalledWith({ query: "Apollo application", offset: 0, limit: 20 });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(container.querySelectorAll(".lite-search-results .lite-document-source-open")).toHaveLength(25));
    expect(api.searchMagicItems).toHaveBeenLastCalledWith({ query: "Apollo application", offset: 20, limit: 20 });

    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".lite-document-source-open")[23]);
    await waitFor(() => expect(api.getCapture).toHaveBeenCalledWith("capture-24"));
    expect(await screen.findByRole("dialog", { name: "App 24" })).toBeVisible();
  });

  it("starts document creation with every source group selected", async () => {
    render(<LiteMagicPalette />);
    fireEvent.click(await screen.findByRole("tab", { name: "Create document" }));

    const input = screen.getByLabelText("Magic Search");
    fireEvent.change(input, { target: { value: "Summarize Apollo" } });
    await waitFor(() => expect(api.previewMagicSearch).toHaveBeenCalled());

    expect(screen.getByRole("checkbox", { name: /All contexts/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Apollo/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Work/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Knowledge Base/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Inbox/ })).toBeChecked();

    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.generateMagicSearch).toHaveBeenCalledWith(expect.objectContaining({
      context_ids: ["apollo", "work"], include_knowledge_base: true, include_inbox: true, response_mode: "document",
    })));
    expect(await screen.findByText("Application Apollo")).toBeVisible();
  });
});
