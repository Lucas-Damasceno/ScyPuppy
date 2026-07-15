use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type CommandResult<T> = Result<T, AppError>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotice {
    pub code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    fn internal(message: &str) -> Self {
        eprintln!("Unexpected command error: {message}");
        Self::new("internal.unexpected")
    }

    /// Compatibility bridge for the String-based domain layer. New command-level
    /// validation must construct AppError directly. This bridge keeps internal
    /// technical details out of the IPC response while the domain layer is
    /// migrated incrementally.
    pub fn from_legacy(message: impl Into<String>) -> Self {
        let message = message.into();
        let exact_code = match message.as_str() {
            "DUPLICATE_CAPTURE_IGNORED" => Some("capture.duplicate_ignored"),
            "O contexto Inbox nao pode ser renomeado." => Some("context.protected_rename"),
            "Contexto nao encontrado." => Some("context.not_found"),
            "O contexto Inbox nao pode ser excluido." => Some("context.protected_delete"),
            "O documento não pode ficar vazio." => Some("document.content_required"),
            "Documento não encontrado." => Some("document.not_found"),
            "O título do documento não pode ficar vazio." => Some("document.title_required"),
            "A janela principal do ScryPuppy não está disponível." => Some("window.main_unavailable"),
            "Janela de colagem indisponivel." => Some("window.quick_paste_unavailable"),
            "A janela de busca do ScryPuppy não está disponível." => Some("window.magic_search_unavailable"),
            "A Base de conteúdo aceita texto selecionado. Selecione texto antes de usar o atalho." => Some("capture.reference_requires_text"),
            "O clipboard nao retornou conteudo para salvar." => Some("clipboard.empty"),
            "Nao foi possivel controlar o estado da captura." => Some("capture.state_unavailable"),
            "Esta captura já é uma fonte do documento." => Some("document.source_exists"),
            "Fonte não encontrada no documento." => Some("document.source_not_found"),
            "O ScryPuppy aceita imagens e arquivos de texto neste menu." => Some("file.unsupported_type"),
            "O arquivo selecionado excede o limite de 20 MB." => Some("file.too_large"),
            "O arquivo de texto precisa estar codificado em UTF-8." => Some("file.invalid_utf8"),
            "O arquivo selecionado esta vazio." => Some("file.empty"),
            "Chave local do banco inválida." => Some("database.invalid_key"),
            "A credencial de segurança local está vazia." => Some("credential.empty"),
            "A chave de segurança local não foi encontrada no Windows Credential Manager. A base existente não será aberta sem ela." => Some("credential.database_key_missing"),
            "Nao foi possivel identificar a janela ativa." => Some("window.active_unavailable"),
            "The focused app did not update the clipboard after the shortcut. Release the keys and try capturing again." => Some("clipboard.not_updated"),
            "O app focado nao atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura." => Some("clipboard.not_updated"),
            "Dados de imagem do clipboard invalidos." => Some("clipboard.invalid_image"),
            "This capture has no restorable clipboard representation." => Some("clipboard.capture_unavailable"),
            "No restorable file path is available." => Some("clipboard.files_unavailable"),
            "The clipboard service is unavailable." => Some("clipboard.service_unavailable"),
            "The clipboard did not respond in time." => Some("clipboard.timeout"),
            "Janela ativa nao encontrada para screenshot." => Some("screenshot.window_not_found"),
            "Janela ativa minimizada; screenshot nao capturado." => Some("screenshot.window_minimized"),
            "Captura nao encontrada." => Some("capture.not_found"),
            "Nome do contexto nao pode ser vazio." => Some("context.name_required"),
            "OCR local está disponível nesta versão para Windows." => Some("ocr.windows_only"),
            "Chave de contexto inválida." => Some("context.invalid_key"),
            "A Tag não pode ser vazia." => Some("tag.name_required"),
            _ => None,
        };
        if let Some(code) = exact_code {
            return Self::new(code);
        }

        if let Some(path) = message.strip_prefix("O arquivo selecionado nao existe: ") {
            return Self::new("file.not_found").with_param("path", path.to_string());
        }
        if let Some(path) = message.strip_prefix("The selected path does not exist: ") {
            return Self::new("file.not_found").with_param("path", path.to_string());
        }
        if let Some(provider) = message.strip_prefix("Provider nao suportado: ") {
            return Self::new("ai.provider_unsupported")
                .with_param("provider", provider.to_string());
        }
        if let Some(value) = message
            .strip_prefix("Imagem acima do limite local de OCR (")
            .and_then(|value| value.strip_suffix("px)."))
            .and_then(|value| value.parse::<u64>().ok())
        {
            return Self::new("ocr.image_too_large").with_param("maxDimension", value);
        }

        let technical_code = [
            (
                "Nao foi possivel preparar o clipboard:",
                "clipboard.prepare_failed",
            ),
            ("Falha ao acionar copia nativa:", "clipboard.copy_failed"),
            (
                "Não foi possível abrir a base criptografada.",
                "database.open_failed",
            ),
            (
                "Falha ao criptografar a base existente:",
                "database.encryption_failed",
            ),
            (
                "A cópia criptografada não pôde ser validada:",
                "database.validation_failed",
            ),
            (
                "Windows Credential Manager indisponível:",
                "credential.manager_unavailable",
            ),
            (
                "Não foi possível salvar a chave no Windows Credential Manager:",
                "credential.save_failed",
            ),
            (
                "Não foi possível ler o Windows Credential Manager:",
                "credential.read_failed",
            ),
            (
                "Não foi possível salvar no Windows Credential Manager:",
                "credential.save_failed",
            ),
            (
                "Não foi possível remover do Windows Credential Manager:",
                "credential.remove_failed",
            ),
        ]
        .into_iter()
        .find_map(|(prefix, code)| message.starts_with(prefix).then_some(code));
        if let Some(code) = technical_code {
            eprintln!("Command error [{code}]: {message}");
            return Self::new(code);
        }

        Self::internal(&message)
    }
}

impl AppNotice {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn from_stored(value: &str) -> Option<Self> {
        if let Ok(notice) = serde_json::from_str(value) {
            return Some(notice);
        }
        if value.starts_with("O provedor de IA falhou;")
            || value.starts_with("The AI provider failed;")
        {
            return Some(Self::new("ai.provider_failed_local_fallback"));
        }
        if value.starts_with("A análise de IA falhou;") || value.starts_with("AI analysis failed;")
        {
            return Some(Self::new("ai.analysis_failed_local_fallback"));
        }
        if value.starts_with("A IA não foi usada porque nenhuma chave")
            || value.starts_with("AI was not used because no key")
        {
            return Some(Self::new("ai.key_missing_local_only"));
        }
        None
    }
}

impl From<String> for AppError {
    fn from(value: String) -> Self {
        Self::from_legacy(value)
    }
}

impl From<&str> for AppError {
    fn from(value: &str) -> Self {
        Self::from_legacy(value)
    }
}

pub fn command_result<T>(result: Result<T, String>) -> CommandResult<T> {
    result.map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_legacy_error_to_stable_code() {
        let error = AppError::from_legacy(
            "O app focado nao atualizou o clipboard depois do atalho. Tente soltar as teclas e repetir a captura.",
        );
        assert_eq!(error.code, "clipboard.not_updated");
        assert!(error.params.is_empty());
    }

    #[test]
    fn keeps_display_safe_parameters() {
        let error = AppError::from_legacy("O arquivo selecionado nao existe: C:\\missing.md");
        assert_eq!(error.code, "file.not_found");
        assert_eq!(
            error.params.get("path"),
            Some(&Value::from("C:\\missing.md"))
        );
    }

    #[test]
    fn hides_unexpected_technical_details() {
        let error = AppError::from_legacy("database password was secret-value");
        assert_eq!(error.code, "internal.unexpected");
        assert!(error.params.is_empty());
    }

    #[test]
    fn serializes_the_ipc_contract_without_internal_details() {
        let value = serde_json::to_value(
            AppError::new("file.not_found").with_param("path", "C:\\missing.md"),
        )
        .unwrap();
        assert_eq!(value["code"], "file.not_found");
        assert_eq!(value["params"]["path"], "C:\\missing.md");
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn stored_notices_round_trip_without_params() {
        let encoded = serde_json::to_string(&AppNotice::new("ai.key_missing_local_only")).unwrap();
        let decoded = AppNotice::from_stored(&encoded).unwrap();
        assert_eq!(decoded.code, "ai.key_missing_local_only");
        assert!(decoded.params.is_empty());
    }
}
