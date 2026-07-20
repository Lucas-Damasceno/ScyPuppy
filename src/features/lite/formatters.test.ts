import { describe, expect, it } from "vitest";
import { emptyCapturePrompt } from "./formatters";

describe("emptyCapturePrompt", () => {
  it("uses the Knowledge Base reference shortcut for the empty Knowledge Base", () => {
    expect(emptyCapturePrompt(
      true,
      "CommandOrControl+Shift+C",
      "CommandOrControl+Shift+S",
    )).toEqual({
      message: "Save a reference with {shortcut} or try another search.",
      shortcut: "Ctrl + Shift + S",
    });
  });

  it("uses the regular capture shortcut for other empty views", () => {
    expect(emptyCapturePrompt(
      false,
      "CommandOrControl+Alt+C",
      "CommandOrControl+Shift+S",
    )).toEqual({
      message: "Copy something with {shortcut} or try another search.",
      shortcut: "Ctrl + Alt + C",
    });
  });
});
