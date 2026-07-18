export type MessageParams = Record<string, string | number>;

export type AppMessagePayload = {
  code: string;
  params?: MessageParams;
};

export type MessageTranslator = (english: string, variables?: MessageParams) => string;

const messageTemplates: Record<string, string> = {
  "internal.unexpected": "Something went wrong. Please try again.",
  "clipboard.prepare_failed": "ScryPuppy could not prepare the clipboard. Please try again.",
  "clipboard.copy_failed": "ScryPuppy could not trigger the copy action. Please try again.",
  "clipboard.not_updated": "The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again.",
  "clipboard.empty": "The clipboard did not return any content to save.",
  "clipboard.invalid_image": "The clipboard returned invalid image data.",
  "clipboard.capture_unavailable": "This capture can no longer be copied because its original content is unavailable.",
  "clipboard.files_unavailable": "The original files are no longer available at their saved locations.",
  "clipboard.service_unavailable": "Clipboard access is temporarily unavailable. Restart ScryPuppy if this continues.",
  "clipboard.timeout": "Windows took too long to provide the clipboard content. Try copying it again.",
  "capture.duplicate_ignored": "This capture is already saved.",
  "capture.state_unavailable": "ScryPuppy could not start a new capture. Please try again.",
  "capture.not_found": "Capture not found.",
  "capture.reference_requires_text": "The Content Base accepts selected text. Select text before using the shortcut.",
  "context.name_required": "Enter a context name.",
  "context.not_found": "Context not found.",
  "context.protected_rename": "This built-in collection cannot be renamed.",
  "context.protected_delete": "This built-in collection cannot be deleted.",
  "context.reserved_collection": "Built-in collections cannot be assigned as contexts.",
  "context.invalid_key": "The context encryption key is invalid.",
  "smart_context.invalid_rule": "Complete the rule with valid conditions before saving.",
  "smart_context.rule_not_found": "This automation rule no longer exists.",
  "cleanup.invalid_filter": "Choose a valid period, type, and context for cleanup.",
  "cleanup.selection_changed": "Your matching data changed. Review the updated preview before deleting.",
  "document.content_required": "The document cannot be empty.",
  "document.not_found": "Document not found.",
  "document.title_required": "Enter a document title.",
  "document.source_exists": "This capture is already a document source.",
  "document.source_not_found": "Document source not found.",
  "window.main_unavailable": "The main ScryPuppy window is unavailable.",
  "window.quick_paste_unavailable": "Quick Paste is unavailable.",
  "window.magic_search_unavailable": "Ask ScryPuppy is unavailable.",
  "window.active_unavailable": "ScryPuppy could not identify the active window.",
  "screenshot.window_not_found": "The active window could not be found for the screenshot.",
  "screenshot.window_minimized": "Restore the active window before capturing a screenshot.",
  "file.not_found": "The selected file does not exist: {path}",
  "file.unsupported_type": "Choose an image or text file supported by ScryPuppy.",
  "file.too_large": "The selected file exceeds the 20 MB limit.",
  "file.invalid_utf8": "The text file must use UTF-8 encoding.",
  "file.empty": "The selected file is empty.",
  "database.invalid_key": "The local database key is invalid.",
  "database.open_failed": "ScryPuppy could not open the encrypted database.",
  "database.encryption_failed": "ScryPuppy could not encrypt the existing database.",
  "database.validation_failed": "ScryPuppy could not validate the encrypted database.",
  "credential.manager_unavailable": "Windows Credential Manager is unavailable.",
  "credential.save_failed": "ScryPuppy could not save the credential in Windows Credential Manager.",
  "credential.read_failed": "ScryPuppy could not read Windows Credential Manager.",
  "credential.remove_failed": "ScryPuppy could not remove the credential from Windows Credential Manager.",
  "credential.empty": "The local security credential is empty.",
  "credential.database_key_missing": "The local database key was not found in Windows Credential Manager.",
  "ocr.windows_only": "Local OCR is available in the Windows version.",
  "ocr.image_too_large": "The image exceeds the local OCR limit ({maxDimension}px).",
  "tag.name_required": "Enter a tag name.",
  "ai.provider_unsupported": "The AI provider is not supported: {provider}",
  "ai.provider_failed_local_fallback": "The AI provider was unavailable, so ScryPuppy used local synthesis.",
  "ai.analysis_failed_local_fallback": "AI analysis was unavailable; local suggestions remain available.",
  "ai.key_missing_local_only": "No AI key is configured; local suggestions remain available.",
  "search.query_required": "Describe what Ask ScryPuppy should consolidate.",
  "search.no_evidence": "Ask ScryPuppy did not find enough evidence for this request.",
  "local_search.not_ready": "Download the local model and wait for indexing to finish before using Local Magic Search.",
  "local_search.download_failed": "The local model could not be downloaded. Check your connection and try again.",
  "local_search.load_failed": "The downloaded local model could not be loaded. Remove it and download it again.",
  "local_search.index_failed": "The local model is available, but ScryPuppy could not finish indexing your library. Try again.",
  "local_search.remove_failed": "ScryPuppy could not remove the downloaded local model.",
  "local_search.busy": "A local model operation is already running. Wait for it to finish and try again.",
  "export.path_required": "Choose where the Markdown document should be saved.",
  "export.absolute_path_required": "Choose an absolute path for the exported document.",
  "export.file_required": "Choose a Markdown file, not a directory.",
  "export.folder_not_found": "The selected export folder does not exist.",
};

const legacyExactCodes: Record<string, string> = {
  "O contexto Inbox nao pode ser renomeado.": "context.protected_rename",
  "Contexto nao encontrado.": "context.not_found",
  "Context not found.": "context.not_found",
  "O contexto Inbox nao pode ser excluido.": "context.protected_delete",
  "O documento não pode ficar vazio.": "document.content_required",
  "Documento não encontrado.": "document.not_found",
  "O título do documento não pode ficar vazio.": "document.title_required",
  "A janela principal do ScryPuppy não está disponível.": "window.main_unavailable",
  "Janela de colagem indisponivel.": "window.quick_paste_unavailable",
  "A janela de busca do ScryPuppy não está disponível.": "window.magic_search_unavailable",
  "A Base de conteúdo aceita texto selecionado. Selecione texto antes de usar o atalho.": "capture.reference_requires_text",
  "O clipboard nao retornou conteudo para salvar.": "clipboard.empty",
  "Nao foi possivel controlar o estado da captura.": "capture.state_unavailable",
  "Esta captura já é uma fonte do documento.": "document.source_exists",
  "Fonte não encontrada no documento.": "document.source_not_found",
  "O ScryPuppy aceita imagens e arquivos de texto neste menu.": "file.unsupported_type",
  "O arquivo selecionado excede o limite de 20 MB.": "file.too_large",
  "O arquivo de texto precisa estar codificado em UTF-8.": "file.invalid_utf8",
  "O arquivo selecionado esta vazio.": "file.empty",
  "Chave local do banco inválida.": "database.invalid_key",
  "A credencial de segurança local está vazia.": "credential.empty",
  "A chave de segurança local não foi encontrada no Windows Credential Manager. A base existente não será aberta sem ela.": "credential.database_key_missing",
  "Nao foi possivel identificar a janela ativa.": "window.active_unavailable",
  "O app focado nao atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.": "clipboard.not_updated",
  "Dados de imagem do clipboard invalidos.": "clipboard.invalid_image",
  "Janela ativa nao encontrada para screenshot.": "screenshot.window_not_found",
  "Janela ativa minimizada; screenshot nao capturado.": "screenshot.window_minimized",
  "Captura nao encontrada.": "capture.not_found",
  "Capture not found.": "capture.not_found",
  "Nome do contexto nao pode ser vazio.": "context.name_required",
  "OCR local está disponível nesta versão para Windows.": "ocr.windows_only",
  "Chave de contexto inválida.": "context.invalid_key",
  "A Tag não pode ser vazia.": "tag.name_required",
  "The tag cannot be empty.": "tag.name_required",
  "Reserved collections cannot be assigned as contexts.": "context.reserved_collection",
  "Describe what Magic Search should consolidate.": "search.query_required",
  "Descreva o que o Magic Search deve consolidar.": "search.query_required",
  "Magic Search did not find enough evidence to answer this request.": "search.no_evidence",
  "O Magic Search não encontrou evidências suficientes para responder a esta solicitação.": "search.no_evidence",
  "Choose where the Markdown document should be saved.": "export.path_required",
  "The export destination must be an absolute path.": "export.absolute_path_required",
  "Choose a Markdown file, not a directory.": "export.file_required",
  "The selected export folder does not exist.": "export.folder_not_found",
};

export class AppCommandError extends Error {
  readonly payload: AppMessagePayload;
  readonly originalError?: unknown;

  constructor(payload: AppMessagePayload, originalError?: unknown) {
    super(payload.code);
    this.name = "AppCommandError";
    this.payload = payload;
    this.originalError = originalError;
  }
}

function isPayload(value: unknown): value is AppMessagePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string"
    && (candidate.params === undefined || (candidate.params !== null && typeof candidate.params === "object"));
}

function legacyPayload(message: string): AppMessagePayload | null {
  const exact = legacyExactCodes[message];
  if (exact) return { code: exact };
  const filePath = message.match(/^O arquivo selecionado nao existe: (.+)$/u);
  if (filePath) return { code: "file.not_found", params: { path: filePath[1] } };
  const provider = message.match(/^Provider nao suportado: (.+)$/u);
  if (provider) return { code: "ai.provider_unsupported", params: { provider: provider[1] } };
  const ocrLimit = message.match(/^Imagem acima do limite local de OCR \((\d+)px\)\.$/u);
  if (ocrLimit) return { code: "ocr.image_too_large", params: { maxDimension: Number(ocrLimit[1]) } };
  if (message.startsWith("O provedor de IA falhou;") || message.startsWith("The AI provider failed;")) {
    return { code: "ai.provider_failed_local_fallback" };
  }
  if (message.startsWith("A análise de IA falhou;") || message.startsWith("AI analysis failed;")) {
    return { code: "ai.analysis_failed_local_fallback" };
  }
  return null;
}

export function normalizeCommandError(error: unknown): AppCommandError {
  if (error instanceof AppCommandError) return error;
  if (isPayload(error)) return new AppCommandError(error);
  if (typeof error === "string") {
    try {
      const parsed: unknown = JSON.parse(error);
      if (isPayload(parsed)) return new AppCommandError(parsed);
    } catch {
      // Older app versions rejected plain strings; handle them below.
    }
    const legacy = legacyPayload(error);
    if (legacy) return new AppCommandError(legacy, error);
  }
  if (error instanceof Error) {
    const legacy = legacyPayload(error.message);
    if (legacy) return new AppCommandError(legacy, error);
  }
  console.error("Unexpected command error", error);
  return new AppCommandError({ code: "internal.unexpected" }, error);
}

export function formatAppMessage(message: AppMessagePayload, tr: MessageTranslator): string {
  const template = messageTemplates[message.code] ?? messageTemplates["internal.unexpected"];
  return tr(template, message.params);
}

export function formatAppError(error: unknown, tr: MessageTranslator): string {
  return formatAppMessage(normalizeCommandError(error).payload, tr);
}
