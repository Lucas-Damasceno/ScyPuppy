import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/tauri";
import { DataCleanupDialog } from "./DataCleanupDialog";

vi.mock("../../api/tauri", () => ({
  previewDataCleanup: vi.fn(),
  deleteDataByFilter: vi.fn(),
}));

const preview = {
  selection_token: "selection-1",
  capture_count: 4,
  image_count: 4,
  file_count: 0,
  reclaimable_bytes: 8_493_056,
  oldest_captured_at: "2026-07-16T20:00:00Z",
  newest_captured_at: "2026-07-16T20:05:00Z",
};

describe("selective data cleanup", () => {
  beforeEach(() => {
    vi.mocked(api.previewDataCleanup).mockResolvedValue(preview);
    vi.mocked(api.deleteDataByFilter).mockResolvedValue({ deleted_count: 4, reclaimed_bytes: 8_493_056 });
  });

  it("previews a composed filter before enabling permanent deletion", async () => {
    render(<DataCleanupDialog
      contexts={[{ id: "design", name: "Design", normalized_name: "design", slug: "design", created_at: "", updated_at: "", capture_count: 3 }]}
      language="en"
      onClose={vi.fn()}
      onDeleted={vi.fn(() => Promise.resolve())}
      onError={vi.fn()}
    />);

    await waitFor(() => expect(api.previewDataCleanup).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "design" } });

    await waitFor(() => expect(api.previewDataCleanup).toHaveBeenLastCalledWith({
      content_types: ["image"],
      context_id: "design",
      period_minutes: 5,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Review deletion" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 4 matching captures?");
    expect(api.deleteDataByFilter).not.toHaveBeenCalled();
  });
});
