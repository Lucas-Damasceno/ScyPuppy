use std::{sync::OnceLock, time::Duration};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ProviderOption {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) models: Vec<ModelOption>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ModelOption {
    pub(crate) id: String,
    pub(crate) name: String,
}

pub(crate) fn provider_options() -> Vec<ProviderOption> {
    vec![
        provider(
            "deepseek",
            "DeepSeek",
            &[
                ("deepseek-v4-flash", "DeepSeek V4 Flash"),
                ("deepseek-v4-pro", "DeepSeek V4 Pro"),
                ("deepseek-v3.2", "DeepSeek V3.2"),
            ],
        ),
        provider(
            "openai",
            "OpenAI",
            &[
                ("gpt-5.2", "GPT-5.2"),
                ("gpt-5.1", "GPT-5.1"),
                ("gpt-5-mini", "GPT-5 mini"),
                ("gpt-5-nano", "GPT-5 nano"),
            ],
        ),
        provider(
            "anthropic",
            "Anthropic",
            &[
                ("claude-sonnet-5", "Claude Sonnet 5"),
                ("claude-opus-4-8", "Claude Opus 4.8"),
                ("claude-haiku-4-5", "Claude Haiku 4.5"),
            ],
        ),
        provider(
            "google",
            "Google Gemini",
            &[
                ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
                ("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
                ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ],
        ),
        provider(
            "mistral",
            "Mistral",
            &[
                ("mistral-large-latest", "Mistral Large"),
                ("ministral-8b-latest", "Ministral 8B"),
                ("codestral-latest", "Codestral"),
            ],
        ),
        provider(
            "groq",
            "Groq",
            &[
                ("openai/gpt-oss-120b", "GPT OSS 120B"),
                ("llama-3.3-70b-versatile", "Llama 3.3 70B Versatile"),
                (
                    "deepseek-r1-distill-llama-70b",
                    "DeepSeek R1 Distill Llama 70B",
                ),
            ],
        ),
    ]
}

pub(crate) fn default_model(provider_id: &str) -> String {
    provider_options()
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.models.first().map(|model| model.id.clone()))
        .unwrap_or_else(|| "deepseek-v4-flash".into())
}

pub(crate) fn call_provider(
    provider: &str,
    api_key: &str,
    model: &str,
    system: &str,
    prompt: &str,
) -> Result<String, String> {
    match provider {
        "deepseek" => call_openai_compatible(
            "https://api.deepseek.com/chat/completions",
            api_key,
            model,
            system,
            prompt,
        ),
        "openai" => call_openai_compatible(
            "https://api.openai.com/v1/chat/completions",
            api_key,
            model,
            system,
            prompt,
        ),
        "mistral" => call_openai_compatible(
            "https://api.mistral.ai/v1/chat/completions",
            api_key,
            model,
            system,
            prompt,
        ),
        "groq" => call_openai_compatible(
            "https://api.groq.com/openai/v1/chat/completions",
            api_key,
            model,
            system,
            prompt,
        ),
        "anthropic" => call_anthropic(api_key, model, system, prompt),
        "google" => call_gemini(api_key, model, system, prompt),
        other => Err(format!("Provider nao suportado: {other}")),
    }
}

fn provider(id: &str, name: &str, models: &[(&str, &str)]) -> ProviderOption {
    ProviderOption {
        id: id.into(),
        name: name.into(),
        models: models
            .iter()
            .map(|(id, name)| ModelOption {
                id: (*id).into(),
                name: (*name).into(),
            })
            .collect(),
    }
}

fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn call_openai_compatible(
    url: &str,
    api_key: &str,
    model: &str,
    system: &str,
    prompt: &str,
) -> Result<String, String> {
    let response: Value = client()?.post(url).bearer_auth(api_key).json(&json!({
        "model": model,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": prompt }],
        "temperature": 0.2
    })).send().map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?.json().map_err(|error| error.to_string())?;
    response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Resposta inesperada do provider: {response}"))
}

fn call_anthropic(
    api_key: &str,
    model: &str,
    system: &str,
    prompt: &str,
) -> Result<String, String> {
    let response: Value = client()?.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key).header("anthropic-version", "2023-06-01")
        .json(&json!({ "model": model, "max_tokens": 900, "system": system, "messages": [{ "role": "user", "content": prompt }], "temperature": 0.2 }))
        .send().map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?.json().map_err(|error| error.to_string())?;
    response
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Resposta inesperada do provider: {response}"))
}

fn call_gemini(api_key: &str, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let response: Value = client()?
        .post(url)
        .header("x-goog-api-key", api_key)
        .json(&json!({
            "systemInstruction": { "parts": [{ "text": system }] },
            "contents": [{ "parts": [{ "text": prompt }] }],
            "generationConfig": { "temperature": 0.2 }
        }))
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .map_err(|error| error.to_string())?;
    response
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Resposta inesperada do provider: {response}"))
}
