use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardRepresentationKind {
    PlainText,
    Html,
    RichText,
    Url,
    Image,
    Files,
}

impl ClipboardRepresentationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PlainText => "plain_text",
            Self::Html => "html",
            Self::RichText => "rich_text",
            Self::Url => "url",
            Self::Image => "image",
            Self::Files => "files",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClipboardImage {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardFileKind {
    File,
    Directory,
    Application,
    Shortcut,
    VirtualFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardFileAvailability {
    Available,
    Missing,
    Unverified,
    TooLarge,
    Unreadable,
}

impl ClipboardFileAvailability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::Unverified => "unverified",
            Self::TooLarge => "too_large",
            Self::Unreadable => "unreadable",
        }
    }
}

impl ClipboardFileKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
            Self::Application => "application",
            Self::Shortcut => "shortcut",
            Self::VirtualFile => "virtual_file",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClipboardFile {
    pub display_name: String,
    pub original_path: Option<PathBuf>,
    pub kind: ClipboardFileKind,
    pub size_bytes: Option<u64>,
    pub bytes: Option<Vec<u8>>,
    pub availability: ClipboardFileAvailability,
}

impl ClipboardFile {
    pub fn physical(path: PathBuf) -> Self {
        let display_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let network_path = is_network_path(&path);
        let metadata = if network_path {
            None
        } else {
            std::fs::metadata(&path).ok()
        };
        let kind = if metadata.as_ref().is_some_and(|value| value.is_dir()) {
            ClipboardFileKind::Directory
        } else if extension == "exe" {
            ClipboardFileKind::Application
        } else if extension == "lnk" || extension == "url" {
            ClipboardFileKind::Shortcut
        } else {
            ClipboardFileKind::File
        };
        let availability = if network_path {
            ClipboardFileAvailability::Unverified
        } else if path.exists() {
            ClipboardFileAvailability::Available
        } else {
            ClipboardFileAvailability::Missing
        };
        Self {
            display_name,
            original_path: Some(path),
            kind,
            size_bytes: metadata
                .filter(|value| value.is_file())
                .map(|value| value.len()),
            bytes: None,
            availability,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ClipboardRepresentation {
    PlainText(String),
    Html(String),
    RichText(String),
    Url(String),
    Image(ClipboardImage),
    Files(Vec<ClipboardFile>),
}

impl ClipboardRepresentation {
    pub fn kind(&self) -> ClipboardRepresentationKind {
        match self {
            Self::PlainText(_) => ClipboardRepresentationKind::PlainText,
            Self::Html(_) => ClipboardRepresentationKind::Html,
            Self::RichText(_) => ClipboardRepresentationKind::RichText,
            Self::Url(_) => ClipboardRepresentationKind::Url,
            Self::Image(_) => ClipboardRepresentationKind::Image,
            Self::Files(_) => ClipboardRepresentationKind::Files,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardFormatMetadata {
    pub id: u32,
    pub name: String,
    pub supported: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ClipboardSnapshot {
    pub representations: Vec<ClipboardRepresentation>,
    pub formats: Vec<ClipboardFormatMetadata>,
}

impl ClipboardSnapshot {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            representations: vec![ClipboardRepresentation::PlainText(text.into())],
            formats: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.representations.is_empty()
    }

    pub fn plain_text(&self) -> Option<&str> {
        self.representations
            .iter()
            .find_map(|representation| match representation {
                ClipboardRepresentation::PlainText(value) => Some(value.as_str()),
                _ => None,
            })
    }

    pub fn image(&self) -> Option<&ClipboardImage> {
        self.representations
            .iter()
            .find_map(|representation| match representation {
                ClipboardRepresentation::Image(value) => Some(value),
                _ => None,
            })
    }

    pub fn image_dimensions(&self) -> Option<(usize, usize)> {
        self.image().map(|image| (image.width, image.height))
    }

    pub fn files(&self) -> Option<&[ClipboardFile]> {
        self.representations
            .iter()
            .find_map(|representation| match representation {
                ClipboardRepresentation::Files(value) => Some(value.as_slice()),
                _ => None,
            })
    }

    pub fn content_text(&self) -> String {
        // File captures must never promote an application's textual path fallback
        // into the searchable/AI-safe field. Store display names only; complete
        // paths remain confined to capture_file_entries.
        if let Some(files) = self.files() {
            return files
                .iter()
                .map(|file| file.display_name.as_str())
                .collect::<Vec<_>>()
                .join("\n");
        }
        if let Some(text) = self.plain_text().filter(|text| !text.trim().is_empty()) {
            return text.to_string();
        }
        if let Some(url) =
            self.representations
                .iter()
                .find_map(|representation| match representation {
                    ClipboardRepresentation::Url(value) => Some(value),
                    _ => None,
                })
        {
            return url.clone();
        }
        String::new()
    }

    pub fn primary_kind(&self) -> ClipboardRepresentationKind {
        for kind in [
            ClipboardRepresentationKind::Files,
            ClipboardRepresentationKind::Image,
            ClipboardRepresentationKind::Html,
            ClipboardRepresentationKind::RichText,
            ClipboardRepresentationKind::Url,
            ClipboardRepresentationKind::PlainText,
        ] {
            if self
                .representations
                .iter()
                .any(|value| value.kind() == kind)
            {
                return kind;
            }
        }
        ClipboardRepresentationKind::PlainText
    }

    pub fn content_hash(&self) -> String {
        let mut hasher = Sha256::new();
        for representation in &self.representations {
            hasher.update(representation.kind().as_str().as_bytes());
            match representation {
                ClipboardRepresentation::PlainText(value)
                | ClipboardRepresentation::Html(value)
                | ClipboardRepresentation::RichText(value)
                | ClipboardRepresentation::Url(value) => hasher.update(value.as_bytes()),
                ClipboardRepresentation::Image(value) => {
                    hasher.update(value.width.to_le_bytes());
                    hasher.update(value.height.to_le_bytes());
                    hasher.update(&value.rgba);
                }
                ClipboardRepresentation::Files(files) => {
                    for file in files {
                        hasher.update(file.display_name.as_bytes());
                        if let Some(path) = &file.original_path {
                            hasher.update(path.to_string_lossy().as_bytes());
                        }
                        if let Some(bytes) = &file.bytes {
                            hasher.update(bytes);
                        }
                    }
                }
            }
        }
        format!("{:x}", hasher.finalize())
    }
}

pub fn is_network_path(path: &Path) -> bool {
    let value = path.as_os_str().to_string_lossy();
    value.starts_with("\\\\") || value.starts_with("//")
}

pub fn sanitize_file_name(value: &str) -> String {
    let value = value
        .trim_matches(['\0', ' ', '.'])
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}' => '_',
            _ => character,
        })
        .collect::<String>();
    let value = value.trim();
    if value.is_empty() || value == "." || value == ".." {
        "unnamed-file".into()
    } else {
        value.chars().take(180).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_cannot_escape_the_capture_vault() {
        assert_eq!(sanitize_file_name("../../report?.pdf"), "_.._report_.pdf");
        assert_eq!(sanitize_file_name(".."), "unnamed-file");
        assert_eq!(sanitize_file_name("a/b\\c.txt"), "a_b_c.txt");
    }

    #[test]
    fn primary_kind_prefers_lossless_richer_representations() {
        let snapshot = ClipboardSnapshot {
            representations: vec![
                ClipboardRepresentation::PlainText("fallback".into()),
                ClipboardRepresentation::Html("<b>fallback</b>".into()),
                ClipboardRepresentation::Files(vec![ClipboardFile {
                    display_name: "report.pdf".into(),
                    original_path: Some(PathBuf::from("C:\\report.pdf")),
                    kind: ClipboardFileKind::File,
                    size_bytes: Some(42),
                    bytes: None,
                    availability: ClipboardFileAvailability::Available,
                }]),
            ],
            formats: Vec::new(),
        };
        assert_eq!(snapshot.primary_kind(), ClipboardRepresentationKind::Files);
    }

    #[test]
    fn snapshot_hash_covers_every_representation() {
        let text = ClipboardSnapshot::text("hello");
        let mut rich = text.clone();
        rich.representations
            .push(ClipboardRepresentation::Html("<b>hello</b>".into()));
        assert_ne!(text.content_hash(), rich.content_hash());
    }

    #[test]
    fn unc_paths_are_detected_without_touching_the_network() {
        assert!(is_network_path(Path::new(r"\\server\share\file.txt")));
        assert!(!is_network_path(Path::new(r"C:\local\file.txt")));
    }
}
