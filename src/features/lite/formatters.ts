import type { AppLanguage } from "../../i18n";

function localeFor(language: AppLanguage) {
  return language === "pt-BR" ? "pt-BR" : "en-US";
}

export function compactContent(value: string) {
  return value.replace(/\s+/g, " ").trim() || "—";
}

export function appInitial(value: string | null) {
  return value?.trim().charAt(0).toLocaleUpperCase() || "?";
}

export function formatRelativeDate(value: string, language: AppLanguage) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(localeFor(language), { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(localeFor(language), { day: "2-digit", month: "short" }).format(date);
}

export function formatDate(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(localeFor(language), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatHotkey(value?: string) {
  return (value ?? "").replace("CommandOrControl", "Ctrl").replace(/\+/g, " + ");
}

export function cleanMagicAnswer(markdown: string) {
  return markdown
    .replace(/\[capture:[^\]]+\]/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|`/g, "")
    .replace(/^\s*(?:I found:|Encontrei:)\s*/i, "")
    .trim();
}

export function maskSensitive(value: string) {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 7)}••••••••${value.slice(-4)}`;
}
