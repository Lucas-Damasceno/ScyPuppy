use arboard::{Clipboard, ImageData};

use super::model::{ClipboardImage, ClipboardRepresentation, ClipboardSnapshot};

pub fn read_snapshot() -> Result<Option<ClipboardSnapshot>, String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    let mut representations = Vec::new();
    if let Ok(text) = clipboard.get_text() {
        if !text.trim().is_empty() {
            representations.push(ClipboardRepresentation::PlainText(text));
        }
    }
    if let Ok(image) = clipboard.get_image() {
        representations.push(ClipboardRepresentation::Image(ClipboardImage {
            width: image.width,
            height: image.height,
            rgba: image.bytes.into_owned(),
        }));
    }
    if representations.is_empty() {
        Ok(None)
    } else {
        Ok(Some(ClipboardSnapshot {
            representations,
            formats: Vec::new(),
        }))
    }
}

pub fn write_snapshot(snapshot: &ClipboardSnapshot) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    if let Some(image) = snapshot.image() {
        clipboard
            .set_image(ImageData {
                width: image.width,
                height: image.height,
                bytes: image.rgba.clone().into(),
            })
            .map_err(|error| error.to_string())
    } else {
        clipboard
            .set_text(snapshot.content_text())
            .map_err(|error| error.to_string())
    }
}
