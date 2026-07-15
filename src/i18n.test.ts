import { describe, expect, it } from "vitest";
import { captureDisplayText, translate, translateLegacyGeneratedContent } from "./i18n";
import type { Capture } from "./types";

function imageCapture(contentText: string, metadata: unknown): Capture {
  return {
    id: "capture-1",
    content_text: contentText,
    captured_at: "2026-07-15T12:00:00Z",
    source_app_name: "ScryPuppy",
    source_app_id: null,
    source_process_id: null,
    source_process_path: null,
    window_title: null,
    window_id: null,
    platform: "windows",
    kind: "capture",
    content_kind: "image",
    metadata,
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

describe("generated capture labels", () => {
  it("builds image labels from structured metadata", () => {
    const capture = imageCapture("", { clipboard_image: { width: 386, height: 322 } });
    expect(captureDisplayText("en", capture)).toBe("[Image copied from clipboard: 386x322]");
    expect(captureDisplayText("pt-BR", capture)).toBe("[Imagem copiada do clipboard: 386x322]");
  });

  it("keeps the old text parser only as a compatibility fallback", () => {
    expect(translateLegacyGeneratedContent("en", "[Imagem copiada do clipboard: 386x322]"))
      .toBe("[Image copied from clipboard: 386x322]");
  });

  it("does not translate user-authored content", () => {
    const capture = imageCapture("O app focado nao atualizou o clipboard", {});
    expect(captureDisplayText("en", capture)).toBe("O app focado nao atualizou o clipboard");
    expect(translate("en", capture.content_text)).toBe(capture.content_text);
  });
});
