import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "./defaultSettings";

describe("Magic Search defaults", () => {
  it("selects the local beta for a new frontend session", () => {
    expect(createDefaultSettings().magic_search_engine).toBe("local");
  });

  it("allows an existing installation to retain provider mode", () => {
    expect(createDefaultSettings({ magic_search_engine: "provider" }).magic_search_engine)
      .toBe("provider");
  });
});
