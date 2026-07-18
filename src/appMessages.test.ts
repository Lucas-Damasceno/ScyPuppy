import { describe, expect, it, vi } from "vitest";
import { formatAppError, formatAppMessage, normalizeCommandError } from "./appMessages";
import { translate } from "./i18n";

const english = (value: string, variables?: Record<string, string | number>) => translate("en", value, variables);
const portuguese = (value: string, variables?: Record<string, string | number>) => translate("pt-BR", value, variables);

describe("structured app messages", () => {
  it("formats a backend error code without depending on backend prose", () => {
    const payload = { code: "clipboard.not_updated" };
    expect(formatAppError(payload, english)).toBe(
      "The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again.",
    );
    expect(formatAppError(payload, portuguese)).toBe(
      "O app focado não atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.",
    );
  });

  it("interpolates display-safe parameters", () => {
    expect(formatAppError({ code: "file.not_found", params: { path: "C:\\missing.md" } }, english))
      .toBe("The selected file does not exist: C:\\missing.md");
  });

  it("supports legacy string errors at the compatibility boundary", () => {
    const error = normalizeCommandError(
      "O app focado nao atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.",
    );
    expect(error.payload).toEqual({ code: "clipboard.not_updated" });
  });

  it("does not expose unexpected technical details", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(formatAppError("database password was secret-value", english))
      .toBe("Something went wrong. Please try again.");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("uses the same typed catalog for non-error notices", () => {
    expect(formatAppMessage({ code: "ai.key_missing_local_only" }, portuguese))
      .toBe("Nenhuma chave de IA está configurada; as sugestões locais continuam disponíveis.");
  });

  it("keeps local model failures structured and retryable", () => {
    expect(formatAppError({ code: "local_search.download_failed" }, english))
      .toBe("The local model could not be downloaded. Check your connection and try again.");
    expect(formatAppError({ code: "local_search.not_ready" }, portuguese))
      .toBe("Baixe o modelo local e aguarde a indexação antes de usar o Magic Search local.");
  });
});
