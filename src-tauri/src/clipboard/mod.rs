mod model;
mod service;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(target_os = "windows"))]
mod fallback;

#[cfg(not(target_os = "windows"))]
use fallback as platform;

pub use model::{
    is_network_path, sanitize_file_name, ClipboardFile, ClipboardFileAvailability,
    ClipboardFileKind, ClipboardImage, ClipboardRepresentation, ClipboardRepresentationKind,
    ClipboardSnapshot,
};
pub use service::ClipboardService;
