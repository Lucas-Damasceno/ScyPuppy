use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use serde::Serialize;

use crate::app_error::AppNotice;

pub const MODEL_ID: &str = "intfloat/multilingual-e5-small";
pub const MODEL_NAME: &str = "Multilingual E5 Small";
pub const MODEL_DIMENSIONS: usize = 384;
pub const INDEX_VERSION: i64 = 1;
const INSTALL_MARKER: &str = "installed.json";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalSearchPhase {
    NotDownloaded,
    Downloading,
    Indexing,
    Ready,
    Error,
    Removing,
}

#[derive(Clone, Debug, Serialize)]
pub struct LocalSearchStatus {
    pub phase: LocalSearchPhase,
    pub model_id: String,
    pub model_name: String,
    pub cache_bytes: u64,
    pub indexed_count: usize,
    pub total_count: usize,
    pub pending_count: usize,
    pub error: Option<AppNotice>,
    pub can_download: bool,
    pub can_retry: bool,
    pub can_remove: bool,
}

impl LocalSearchStatus {
    fn initial(installed: bool, cache_bytes: u64) -> Self {
        Self {
            phase: if installed {
                LocalSearchPhase::Indexing
            } else {
                LocalSearchPhase::NotDownloaded
            },
            model_id: MODEL_ID.into(),
            model_name: MODEL_NAME.into(),
            cache_bytes,
            indexed_count: 0,
            total_count: 0,
            pending_count: 0,
            error: None,
            can_download: !installed,
            can_retry: false,
            can_remove: installed || cache_bytes > 0,
        }
    }
}

pub struct LocalSearchManager {
    cache_dir: PathBuf,
    model: Mutex<Option<TextEmbedding>>,
    status: Mutex<LocalSearchStatus>,
    operation_running: AtomicBool,
    cancel_requested: AtomicBool,
}

impl LocalSearchManager {
    pub fn new(app_dir: &Path) -> Self {
        let cache_dir = app_dir.join("models").join("fastembed");
        let installed = cache_dir.join(INSTALL_MARKER).is_file();
        let cache_bytes = directory_size(&cache_dir).unwrap_or_default();
        Self {
            cache_dir,
            model: Mutex::new(None),
            status: Mutex::new(LocalSearchStatus::initial(installed, cache_bytes)),
            operation_running: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> LocalSearchStatus {
        self.status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| LocalSearchStatus::initial(false, 0))
    }

    pub fn installed(&self) -> bool {
        self.cache_dir.join(INSTALL_MARKER).is_file()
    }

    pub fn try_begin_operation(&self) -> bool {
        self.cancel_requested.store(false, Ordering::Release);
        self.operation_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn finish_operation(&self) {
        self.operation_running.store(false, Ordering::Release);
    }

    pub fn operation_running(&self) -> bool {
        self.operation_running.load(Ordering::Acquire)
    }

    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Release);
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub fn set_phase(&self, phase: LocalSearchPhase, error: Option<AppNotice>) {
        if let Ok(mut status) = self.status.lock() {
            status.phase = phase.clone();
            status.error = error;
            status.cache_bytes = directory_size(&self.cache_dir).unwrap_or_default();
            status.can_download = phase == LocalSearchPhase::NotDownloaded;
            status.can_retry = phase == LocalSearchPhase::Error;
            status.can_remove = self.installed() || status.cache_bytes > 0;
        }
    }

    pub fn set_index_progress(&self, indexed: usize, total: usize) {
        if let Ok(mut status) = self.status.lock() {
            status.indexed_count = indexed;
            status.total_count = total;
            status.pending_count = total.saturating_sub(indexed);
        }
    }

    pub fn load_model(&self, allow_download: bool) -> Result<(), String> {
        if !allow_download && !self.installed() {
            return Err("local model is not installed".into());
        }
        fs::create_dir_all(&self.cache_dir).map_err(|error| error.to_string())?;
        let options = TextInitOptions::new(EmbeddingModel::MultilingualE5Small)
            .with_cache_dir(self.cache_dir.clone())
            .with_show_download_progress(false)
            .with_intra_threads(4);
        let model = TextEmbedding::try_new(options).map_err(|error| error.to_string())?;
        let mut guard = self
            .model
            .lock()
            .map_err(|_| "local model lock is unavailable".to_string())?;
        *guard = Some(model);
        Ok(())
    }

    pub fn mark_installed(&self) -> Result<(), String> {
        fs::create_dir_all(&self.cache_dir).map_err(|error| error.to_string())?;
        let temporary = self.cache_dir.join("installed.json.tmp");
        let destination = self.cache_dir.join(INSTALL_MARKER);
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(
            format!(
                "{{\"model_id\":\"{}\",\"index_version\":{}}}",
                MODEL_ID, INDEX_VERSION
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(temporary, destination).map_err(|error| error.to_string())
    }

    pub fn embed_query(&self, query: &str) -> Result<Vec<f32>, String> {
        self.embed(vec![format!("query: {}", query.trim())])?
            .into_iter()
            .next()
            .ok_or_else(|| "the local model returned no query embedding".into())
    }

    pub fn embed_passages(&self, passages: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        self.embed(
            passages
                .into_iter()
                .map(|value| format!("passage: {value}"))
                .collect(),
        )
    }

    fn embed(&self, values: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        let mut guard = self
            .model
            .lock()
            .map_err(|_| "local model lock is unavailable".to_string())?;
        let model = guard
            .as_mut()
            .ok_or_else(|| "local model is not loaded".to_string())?;
        let embeddings = model
            .embed(values, Some(32))
            .map_err(|error| error.to_string())?;
        for embedding in &embeddings {
            if embedding.len() != MODEL_DIMENSIONS {
                return Err(format!(
                    "unexpected embedding dimensions: expected {MODEL_DIMENSIONS}, got {}",
                    embedding.len()
                ));
            }
        }
        Ok(embeddings)
    }

    pub fn remove_model(&self) -> Result<(), String> {
        let mut guard = self
            .model
            .lock()
            .map_err(|_| "local model lock is unavailable".to_string())?;
        *guard = None;
        drop(guard);
        if self.cache_dir.exists() {
            fs::remove_dir_all(&self.cache_dir).map_err(|error| error.to_string())?;
        }
        self.set_index_progress(0, 0);
        self.set_phase(LocalSearchPhase::NotDownloaded, None);
        Ok(())
    }
}

pub fn normalize_embedding(mut embedding: Vec<f32>) -> Vec<f32> {
    let norm = embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if norm > f32::EPSILON {
        for value in &mut embedding {
            *value /= norm;
        }
    }
    embedding
}

pub fn encode_embedding(embedding: &[f32]) -> Result<Vec<u8>, String> {
    if embedding.len() != MODEL_DIMENSIONS || embedding.iter().any(|value| !value.is_finite()) {
        return Err("invalid local embedding".into());
    }
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(embedding));
    for value in embedding {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(bytes)
}

pub fn decode_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() != MODEL_DIMENSIONS * std::mem::size_of::<f32>() {
        return None;
    }
    let values = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    values
        .iter()
        .all(|value| value.is_finite())
        .then_some(values)
}

pub fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() {
        return f32::NEG_INFINITY;
    }
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

fn directory_size(path: &Path) -> std::io::Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        total = total.saturating_add(if metadata.is_dir() {
            directory_size(&entry.path())?
        } else {
            metadata.len()
        });
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_round_trip_in_little_endian_format() {
        let source = vec![0.25; MODEL_DIMENSIONS];
        let encoded = encode_embedding(&source).expect("valid embedding");
        assert_eq!(encoded.len(), MODEL_DIMENSIONS * 4);
        assert_eq!(decode_embedding(&encoded), Some(source));
    }

    #[test]
    fn normalization_produces_unit_length() {
        let normalized = normalize_embedding(vec![3.0, 4.0]);
        let length = normalized
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        assert!((length - 1.0).abs() < 0.0001);
    }

    #[test]
    fn cosine_rejects_mismatched_vectors() {
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), f32::NEG_INFINITY);
    }
}
