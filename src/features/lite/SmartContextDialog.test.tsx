import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/tauri";
import { SmartContextDialog } from "./SmartContextDialog";

vi.mock("../../api/tauri", () => ({
  listContextRules: vi.fn(),
  previewContextRule: vi.fn(),
  saveContextRule: vi.fn(),
  deleteContextRule: vi.fn(),
}));

const context = {
  id: "design",
  name: "Design",
  normalized_name: "design",
  slug: "design",
  created_at: "",
  updated_at: "",
  capture_count: 3,
};

describe("Smart Context automations", () => {
  beforeEach(() => {
    vi.mocked(api.listContextRules).mockResolvedValue([]);
    vi.mocked(api.previewContextRule).mockResolvedValue({ match_count: 2, samples: [] });
    vi.mocked(api.saveContextRule).mockImplementation(async (rule) => ({
      rule: { ...rule, id: "rule-1" },
      associations_added: 2,
    }));
  });

  it("keeps preview and existing-capture organization explicit", async () => {
    const onChanged = vi.fn(() => Promise.resolve());
    render(<SmartContextDialog
      context={context}
      language="en"
      onClose={vi.fn()}
      onChanged={onChanged}
      onError={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByText("No automations yet")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Design apps" } });
    fireEvent.change(screen.getByPlaceholderText("Enter a value"), { target: { value: "Figma" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
    await waitFor(() => expect(screen.getByText("2 existing captures match")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Organize existing matches when saving"));
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(api.saveContextRule).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Design apps", context_id: "design" }),
      true,
    ));
    expect(onChanged).toHaveBeenCalledWith("Automation saved and 2 existing captures were organized.");
  });
});
