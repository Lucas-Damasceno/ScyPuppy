import { describe, expect, it } from "vitest";
import { cleanMagicAnswer } from "./LiteApp";

describe("cleanMagicAnswer", () => {
  it("reduces a sourced document to the concise answer shown by ScryPuppy", () => {
    expect(
      cleanMagicAnswer("## Result\n\n**com.example.app** [capture:capture-1]"),
    ).toBe("Result\n\ncom.example.app");
  });

  it("removes the direct-answer preamble", () => {
    expect(cleanMagicAnswer("Encontrei: `APP-1234` [capture:42]")).toBe("APP-1234");
  });
});
