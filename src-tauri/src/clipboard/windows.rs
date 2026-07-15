use std::{
    collections::HashSet, mem::size_of, path::PathBuf, ptr::copy_nonoverlapping, thread,
    time::Duration,
};

use arboard::Clipboard;
use windows::{
    core::{BOOL, PCWSTR},
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, POINT},
        Graphics::Gdi::{BITMAPV5HEADER, BI_BITFIELDS, LCS_GM_IMAGES},
        Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY,
        System::{
            Com::{DVASPECT_CONTENT, FORMATETC, STGMEDIUM, TYMED_HGLOBAL, TYMED_ISTREAM},
            DataExchange::{
                CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
                GetClipboardFormatNameW, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{OleGetClipboard, ReleaseStgMedium, CF_DIBV5, CF_HDROP, CF_UNICODETEXT},
        },
        UI::Shell::{
            DragQueryFileW, DROPFILES, FD_ATTRIBUTES, FD_FILESIZE, FILEDESCRIPTORW, HDROP,
        },
    },
};

use super::model::{
    sanitize_file_name, ClipboardFile, ClipboardFileAvailability, ClipboardFileKind,
    ClipboardFormatMetadata, ClipboardImage, ClipboardRepresentation, ClipboardSnapshot,
};

const MAX_CLIPBOARD_VALUE_BYTES: usize = 256 * 1024 * 1024;
const ALL_FILES: u32 = 0xffff_ffff;

const HTML_FORMAT: &str = "HTML Format";
const RTF_FORMAT: &str = "Rich Text Format";
const URL_FORMAT: &str = "UniformResourceLocatorW";
const FILE_GROUP_DESCRIPTOR_FORMAT: &str = "FileGroupDescriptorW";
const FILE_CONTENTS_FORMAT: &str = "FileContents";
const PREFERRED_DROP_EFFECT_FORMAT: &str = "Preferred DropEffect";
const MAX_VIRTUAL_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_VIRTUAL_CAPTURE_BYTES: usize = 256 * 1024 * 1024;

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

pub fn read_snapshot() -> Result<Option<ClipboardSnapshot>, String> {
    let mut last_error = None;
    for _ in 0..6 {
        match read_snapshot_once() {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(35));
    }
    Err(last_error.unwrap_or_else(|| "The clipboard could not be read.".into()))
}

fn read_snapshot_once() -> Result<Option<ClipboardSnapshot>, String> {
    let html_format = register_format(HTML_FORMAT);
    let rtf_format = register_format(RTF_FORMAT);
    let url_format = register_format(URL_FORMAT);
    let file_group_descriptor_format = register_format(FILE_GROUP_DESCRIPTOR_FORMAT);
    let file_contents_format = register_format(FILE_CONTENTS_FORMAT);
    let preferred_drop_effect_format = register_format(PREFERRED_DROP_EFFECT_FORMAT);
    let virtual_files = read_virtual_files();

    unsafe { OpenClipboard(None) }.map_err(|error| error.to_string())?;
    let guard = ClipboardGuard;

    let available_formats = enumerate_formats();
    let known_formats = [
        CF_UNICODETEXT.0 as u32,
        CF_DIBV5.0 as u32,
        CF_HDROP.0 as u32,
        html_format,
        rtf_format,
        url_format,
        file_group_descriptor_format,
        file_contents_format,
        preferred_drop_effect_format,
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let formats = available_formats
        .iter()
        .map(|format| ClipboardFormatMetadata {
            id: *format,
            name: clipboard_format_name(*format),
            supported: known_formats.contains(format),
        })
        .collect::<Vec<_>>();

    let mut representations = Vec::new();
    if let Some(files) = read_file_drop(CF_HDROP.0 as u32) {
        if !files.is_empty() {
            representations.push(ClipboardRepresentation::Files(files));
        }
    } else if !virtual_files.is_empty() {
        representations.push(ClipboardRepresentation::Files(virtual_files));
    }
    if let Some(value) = read_utf16_format(url_format).filter(|value| !value.trim().is_empty()) {
        representations.push(ClipboardRepresentation::Url(value));
    }
    if let Some(value) =
        read_byte_string_format(html_format).filter(|value| !value.trim().is_empty())
    {
        representations.push(ClipboardRepresentation::Html(value));
    }
    if let Some(value) =
        read_byte_string_format(rtf_format).filter(|value| !value.trim().is_empty())
    {
        representations.push(ClipboardRepresentation::RichText(value));
    }
    if let Some(value) =
        read_utf16_format(CF_UNICODETEXT.0 as u32).filter(|value| !value.trim().is_empty())
    {
        representations.push(ClipboardRepresentation::PlainText(value));
    }

    drop(guard);

    // arboard has battle-tested DIB/PNG decoding. It is called on the same STA
    // thread only after the native clipboard handle has been released.
    if let Ok(mut clipboard) = Clipboard::new() {
        if let Ok(image) = clipboard.get_image() {
            if image.width > 0 && image.height > 0 && image.bytes.len() <= MAX_CLIPBOARD_VALUE_BYTES
            {
                representations.push(ClipboardRepresentation::Image(ClipboardImage {
                    width: image.width,
                    height: image.height,
                    rgba: image.bytes.into_owned(),
                }));
            }
        }
    }

    if representations.is_empty() {
        Ok(None)
    } else {
        Ok(Some(ClipboardSnapshot {
            representations,
            formats,
        }))
    }
}

pub fn write_snapshot(snapshot: &ClipboardSnapshot) -> Result<(), String> {
    if snapshot.is_empty() {
        return Err("An empty clipboard snapshot cannot be restored.".into());
    }

    let html_format = register_format(HTML_FORMAT);
    let rtf_format = register_format(RTF_FORMAT);
    let url_format = register_format(URL_FORMAT);
    let preferred_drop_effect_format = register_format(PREFERRED_DROP_EFFECT_FORMAT);
    unsafe { OpenClipboard(None) }.map_err(|error| error.to_string())?;
    let _guard = ClipboardGuard;
    unsafe { EmptyClipboard() }.map_err(|error| error.to_string())?;

    for representation in &snapshot.representations {
        match representation {
            ClipboardRepresentation::PlainText(value) => {
                set_utf16(CF_UNICODETEXT.0 as u32, value)?;
            }
            ClipboardRepresentation::Html(value) => set_bytes(html_format, value.as_bytes())?,
            ClipboardRepresentation::RichText(value) => set_bytes(rtf_format, value.as_bytes())?,
            ClipboardRepresentation::Url(value) => set_utf16(url_format, value)?,
            ClipboardRepresentation::Image(value) => set_dibv5(value)?,
            ClipboardRepresentation::Files(files) => set_file_drop(files)?,
        }
    }
    if snapshot.files().is_some() {
        let handle = allocate_bytes(&1u32.to_le_bytes())?;
        set_allocated(preferred_drop_effect_format, handle)?;
    }
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn register_format(value: &str) -> u32 {
    let value = wide(value);
    unsafe { RegisterClipboardFormatW(PCWSTR(value.as_ptr())) }
}

fn enumerate_formats() -> Vec<u32> {
    let mut formats = Vec::new();
    let mut current = 0;
    loop {
        current = unsafe { EnumClipboardFormats(current) };
        if current == 0 {
            break;
        }
        formats.push(current);
        if formats.len() >= 256 {
            break;
        }
    }
    formats
}

fn clipboard_format_name(format: u32) -> String {
    match format {
        value if value == CF_UNICODETEXT.0 as u32 => "CF_UNICODETEXT".into(),
        value if value == CF_DIBV5.0 as u32 => "CF_DIBV5".into(),
        value if value == CF_HDROP.0 as u32 => "CF_HDROP".into(),
        _ => {
            let mut buffer = vec![0u16; 256];
            let length = unsafe { GetClipboardFormatNameW(format, &mut buffer) };
            if length > 0 {
                String::from_utf16_lossy(&buffer[..length as usize])
            } else {
                format!("format-{format}")
            }
        }
    }
}

fn read_hglobal(format: u32) -> Option<Vec<u8>> {
    let handle = unsafe { GetClipboardData(format) }.ok()?;
    read_hglobal_handle(HGLOBAL(handle.0), MAX_CLIPBOARD_VALUE_BYTES)
}

fn read_hglobal_handle(global: HGLOBAL, maximum: usize) -> Option<Vec<u8>> {
    let size = unsafe { GlobalSize(global) };
    if size == 0 || size > maximum {
        return None;
    }
    let pointer = unsafe { GlobalLock(global) };
    if pointer.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), size) }.to_vec();
    unsafe {
        let _ = GlobalUnlock(global);
    }
    Some(bytes)
}

fn read_virtual_files() -> Vec<ClipboardFile> {
    let descriptor_format = register_format(FILE_GROUP_DESCRIPTOR_FORMAT);
    let contents_format = register_format(FILE_CONTENTS_FORMAT);
    let Ok(data_object) = (unsafe { OleGetClipboard() }) else {
        return Vec::new();
    };
    let descriptor_request = FORMATETC {
        cfFormat: descriptor_format as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let Ok(mut medium) = (unsafe { data_object.GetData(&descriptor_request) }) else {
        return Vec::new();
    };
    let descriptors = if medium.tymed == TYMED_HGLOBAL.0 as u32 {
        let global = unsafe { medium.u.hGlobal };
        read_hglobal_handle(global, 4 * 1024 * 1024)
            .map(|bytes| parse_file_descriptors(&bytes))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    unsafe { ReleaseStgMedium(&mut medium) };

    let mut captured_bytes = 0usize;
    descriptors
        .into_iter()
        .enumerate()
        .map(|(index, descriptor)| {
            let mut file = descriptor;
            if file.kind == ClipboardFileKind::Directory {
                file.availability = ClipboardFileAvailability::Available;
                return file;
            }
            let declared_size = file
                .size_bytes
                .and_then(|value| usize::try_from(value).ok());
            if declared_size.is_some_and(|value| {
                value > MAX_VIRTUAL_FILE_BYTES
                    || captured_bytes.saturating_add(value) > MAX_VIRTUAL_CAPTURE_BYTES
            }) {
                file.availability = ClipboardFileAvailability::TooLarge;
                return file;
            }
            match read_virtual_file_content(&data_object, contents_format, index as i32) {
                Some(bytes)
                    if bytes.len() <= MAX_VIRTUAL_FILE_BYTES
                        && captured_bytes.saturating_add(bytes.len())
                            <= MAX_VIRTUAL_CAPTURE_BYTES =>
                {
                    captured_bytes += bytes.len();
                    file.size_bytes = Some(bytes.len() as u64);
                    file.bytes = Some(bytes);
                    file.availability = ClipboardFileAvailability::Available;
                }
                Some(_) => file.availability = ClipboardFileAvailability::TooLarge,
                None => file.availability = ClipboardFileAvailability::Unreadable,
            }
            file
        })
        .collect()
}

fn parse_file_descriptors(bytes: &[u8]) -> Vec<ClipboardFile> {
    if bytes.len() < size_of::<u32>() {
        return Vec::new();
    }
    let count = u32::from_le_bytes(bytes[..4].try_into().unwrap_or_default()).min(10_000);
    let descriptor_size = size_of::<FILEDESCRIPTORW>();
    let available = bytes.len().saturating_sub(4) / descriptor_size;
    let count = (count as usize).min(available);
    (0..count)
        .filter_map(|index| {
            let offset = 4 + index * descriptor_size;
            let descriptor = unsafe {
                std::ptr::read_unaligned(bytes[offset..].as_ptr().cast::<FILEDESCRIPTORW>())
            };
            let file_name = unsafe { std::ptr::addr_of!(descriptor.cFileName).read_unaligned() };
            let end = file_name
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(file_name.len());
            let name = sanitize_file_name(&String::from_utf16_lossy(&file_name[..end]));
            if name.is_empty() {
                return None;
            }
            let flags = descriptor.dwFlags;
            let size = (flags & FD_FILESIZE.0 as u32 != 0).then_some(
                ((descriptor.nFileSizeHigh as u64) << 32) | descriptor.nFileSizeLow as u64,
            );
            let directory = flags & FD_ATTRIBUTES.0 as u32 != 0
                && descriptor.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
            Some(ClipboardFile {
                display_name: name,
                original_path: None,
                kind: if directory {
                    ClipboardFileKind::Directory
                } else {
                    ClipboardFileKind::VirtualFile
                },
                size_bytes: (!directory).then_some(size).flatten(),
                bytes: None,
                availability: ClipboardFileAvailability::Unreadable,
            })
        })
        .collect()
}

fn read_virtual_file_content(
    data_object: &windows::Win32::System::Com::IDataObject,
    format: u32,
    index: i32,
) -> Option<Vec<u8>> {
    let request = FORMATETC {
        cfFormat: format as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: (TYMED_HGLOBAL.0 | TYMED_ISTREAM.0) as u32,
    };
    let mut medium: STGMEDIUM = unsafe { data_object.GetData(&request) }.ok()?;
    let result = if medium.tymed == TYMED_HGLOBAL.0 as u32 {
        read_hglobal_handle(unsafe { medium.u.hGlobal }, MAX_VIRTUAL_FILE_BYTES + 1)
    } else if medium.tymed == TYMED_ISTREAM.0 as u32 {
        let stream = unsafe { medium.u.pstm.as_ref() };
        stream.and_then(read_stream)
    } else {
        None
    };
    unsafe { ReleaseStgMedium(&mut medium) };
    result
}

fn read_stream(stream: &windows::Win32::System::Com::IStream) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        let result = unsafe {
            stream.Read(
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                Some(&mut read),
            )
        };
        if result.is_err() {
            return None;
        }
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read as usize) > MAX_VIRTUAL_FILE_BYTES {
            output.resize(MAX_VIRTUAL_FILE_BYTES + 1, 0);
            break;
        }
        output.extend_from_slice(&buffer[..read as usize]);
    }
    Some(output)
}

fn read_utf16_format(format: u32) -> Option<String> {
    let bytes = read_hglobal(format)?;
    let mut words = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    if let Some(end) = words.iter().position(|word| *word == 0) {
        words.truncate(end);
    }
    Some(String::from_utf16_lossy(&words))
}

fn read_byte_string_format(format: u32) -> Option<String> {
    let mut bytes = read_hglobal(format)?;
    if let Some(end) = bytes.iter().position(|byte| *byte == 0) {
        bytes.truncate(end);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_file_drop(format: u32) -> Option<Vec<ClipboardFile>> {
    let handle = unsafe { GetClipboardData(format) }.ok()?;
    let drop = HDROP(handle.0);
    let count = unsafe { DragQueryFileW(drop, ALL_FILES, None) };
    if count == 0 || count > 10_000 {
        return None;
    }
    let mut files = Vec::with_capacity(count as usize);
    for index in 0..count {
        let length = unsafe { DragQueryFileW(drop, index, None) };
        if length == 0 || length > 32_767 {
            continue;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = unsafe { DragQueryFileW(drop, index, Some(&mut buffer)) };
        if copied == 0 {
            continue;
        }
        let path = PathBuf::from(String::from_utf16_lossy(&buffer[..copied as usize]));
        files.push(ClipboardFile::physical(path));
    }
    Some(files)
}

fn allocate_bytes(bytes: &[u8]) -> Result<HGLOBAL, String> {
    if bytes.is_empty() || bytes.len() > MAX_CLIPBOARD_VALUE_BYTES {
        return Err("Clipboard representation size is invalid.".into());
    }
    let handle =
        unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.map_err(|error| error.to_string())?;
    let pointer = unsafe { GlobalLock(handle) };
    if pointer.is_null() {
        unsafe {
            let _ = GlobalFree(Some(handle));
        }
        return Err("Could not lock clipboard memory.".into());
    }
    unsafe {
        copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(handle);
    }
    Ok(handle)
}

fn set_allocated(format: u32, handle: HGLOBAL) -> Result<(), String> {
    match unsafe { SetClipboardData(format, Some(HANDLE(handle.0))) } {
        Ok(_) => Ok(()),
        Err(error) => {
            unsafe {
                let _ = GlobalFree(Some(handle));
            }
            Err(error.to_string())
        }
    }
}

fn set_bytes(format: u32, value: &[u8]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(value.len() + 1);
    bytes.extend_from_slice(value);
    bytes.push(0);
    let handle = allocate_bytes(&bytes)?;
    set_allocated(format, handle)
}

fn set_utf16(format: u32, value: &str) -> Result<(), String> {
    let bytes = wide(value)
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let handle = allocate_bytes(&bytes)?;
    set_allocated(format, handle)
}

fn set_file_drop(files: &[ClipboardFile]) -> Result<(), String> {
    let bytes = file_drop_bytes(files)?;
    let handle = allocate_bytes(&bytes)?;
    set_allocated(CF_HDROP.0 as u32, handle)
}

fn file_drop_bytes(files: &[ClipboardFile]) -> Result<Vec<u8>, String> {
    let paths = files
        .iter()
        .filter_map(|file| file.original_path.as_ref())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Err("No restorable file path is available.".into());
    }
    let mut path_words = Vec::new();
    for path in paths {
        path_words.extend(path.as_os_str().to_string_lossy().encode_utf16());
        path_words.push(0);
    }
    path_words.push(0);

    let header = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: BOOL(0),
        fWide: BOOL(1),
    };
    let mut bytes = vec![0u8; size_of::<DROPFILES>() + path_words.len() * 2];
    unsafe {
        copy_nonoverlapping(
            (&header as *const DROPFILES).cast::<u8>(),
            bytes.as_mut_ptr(),
            size_of::<DROPFILES>(),
        );
    }
    let offset = size_of::<DROPFILES>();
    for (index, word) in path_words.into_iter().enumerate() {
        bytes[offset + index * 2..offset + index * 2 + 2].copy_from_slice(&word.to_le_bytes());
    }
    Ok(bytes)
}

fn set_dibv5(image: &ClipboardImage) -> Result<(), String> {
    let bytes = dibv5_bytes(image)?;
    let handle = allocate_bytes(&bytes)?;
    set_allocated(CF_DIBV5.0 as u32, handle)
}

fn dibv5_bytes(image: &ClipboardImage) -> Result<Vec<u8>, String> {
    let pixel_count = image
        .width
        .checked_mul(image.height)
        .ok_or_else(|| "Image dimensions overflow.".to_string())?;
    let image_size = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "Image dimensions overflow.".to_string())?;
    if image.rgba.len() != image_size || image_size > MAX_CLIPBOARD_VALUE_BYTES {
        return Err("Image pixels do not match its dimensions.".into());
    }
    let header = BITMAPV5HEADER {
        bV5Size: size_of::<BITMAPV5HEADER>() as u32,
        bV5Width: image.width as i32,
        // Positive height maximizes compatibility with Office; rows are stored bottom-up.
        bV5Height: image.height as i32,
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5SizeImage: image_size as u32,
        bV5RedMask: 0x00ff_0000,
        bV5GreenMask: 0x0000_ff00,
        bV5BlueMask: 0x0000_00ff,
        bV5AlphaMask: 0xff00_0000,
        bV5CSType: 0x7352_4742,
        bV5Intent: LCS_GM_IMAGES as u32,
        ..Default::default()
    };
    let mut bytes = vec![0u8; size_of::<BITMAPV5HEADER>() + image_size];
    unsafe {
        copy_nonoverlapping(
            (&header as *const BITMAPV5HEADER).cast::<u8>(),
            bytes.as_mut_ptr(),
            size_of::<BITMAPV5HEADER>(),
        );
    }
    let mut destination = size_of::<BITMAPV5HEADER>();
    for row in (0..image.height).rev() {
        for column in 0..image.width {
            let source = (row * image.width + column) * 4;
            bytes[destination] = image.rgba[source + 2];
            bytes[destination + 1] = image.rgba[source + 1];
            bytes[destination + 2] = image.rgba[source];
            bytes[destination + 3] = image.rgba[source + 3];
            destination += 4;
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{ClipboardFileAvailability, ClipboardFileKind};

    #[test]
    fn file_drop_is_wide_and_double_null_terminated() {
        let bytes = file_drop_bytes(&[ClipboardFile {
            display_name: "report.pdf".into(),
            original_path: Some(PathBuf::from(r"C:\work\report.pdf")),
            kind: ClipboardFileKind::File,
            size_bytes: None,
            bytes: None,
            availability: ClipboardFileAvailability::Available,
        }])
        .expect("file drop bytes");
        let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<DROPFILES>()) };
        let is_wide = header.fWide.0;
        assert_ne!(is_wide, 0);
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }

    #[test]
    fn dibv5_converts_rgba_to_bottom_up_bgra() {
        let bytes = dibv5_bytes(&ClipboardImage {
            width: 1,
            height: 2,
            rgba: vec![255, 0, 0, 255, 0, 0, 255, 128],
        })
        .expect("dib bytes");
        let pixels = &bytes[size_of::<BITMAPV5HEADER>()..];
        assert_eq!(pixels, &[255, 0, 0, 128, 0, 0, 255, 255]);
    }

    #[test]
    fn malformed_image_buffer_is_rejected() {
        assert!(dibv5_bytes(&ClipboardImage {
            width: 2,
            height: 2,
            rgba: vec![0; 7],
        })
        .is_err());
    }
}
