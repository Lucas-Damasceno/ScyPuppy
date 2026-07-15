import { describe, expect, it } from "vitest";
import { translate, translateGeneratedContent } from "./i18n";

describe("localized backend messages", () => {
  it("converts legacy Portuguese capture errors in the English interface", () => {
    expect(translate(
      "en",
      "O app focado nao atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.",
    )).toBe(
      "The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again.",
    );
  });

  it("keeps canonical backend errors localized in Portuguese", () => {
    expect(translate(
      "pt-BR",
      "The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again.",
    )).toBe(
      "O app focado não atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.",
    );
  });

  it("translates dynamic legacy AI warnings in English", () => {
    expect(translate("en", "A análise de IA falhou; as sugestões locais continuam disponíveis: timeout")).toBe(
      "AI analysis failed; local suggestions remain available: timeout",
    );
  });

  it("translates generated image labels from existing captures", () => {
    expect(translateGeneratedContent("en", "[Imagem copiada do clipboard: 386x322]"))
      .toBe("[Image copied from clipboard: 386x322]");
    expect(translateGeneratedContent("pt-BR", "[Image copied from clipboard: 386x322]"))
      .toBe("[Imagem copiada do clipboard: 386x322]");
  });
});
