use crate::{
    error::{AppError, Result},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};
use tauri::{
    Manager,
    http::{Request, Response, StatusCode},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    #[default]
    Text,
    Image,
    Svg,
    Video,
    Audio,
    Binary,
}

impl FileKind {
    pub fn is_text(self) -> bool {
        matches!(self, Self::Text | Self::Svg)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub kind: FileKind,
    pub size: u64,
    pub stamp: String,
}

pub fn media_type(path: &Path) -> Option<(FileKind, &'static str)> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "jpg" | "jpe" | "jpeg" => (FileKind::Image, "image/jpeg"),
            "png" => (FileKind::Image, "image/png"),
            "bmp" => (FileKind::Image, "image/bmp"),
            "gif" => (FileKind::Image, "image/gif"),
            "ico" => (FileKind::Image, "image/x-icon"),
            "webp" => (FileKind::Image, "image/webp"),
            "avif" => (FileKind::Image, "image/avif"),
            "svg" => (FileKind::Svg, "image/svg+xml"),
            "mp4" => (FileKind::Video, "video/mp4"),
            "webm" => (FileKind::Video, "video/webm"),
            "mp3" => (FileKind::Audio, "audio/mpeg"),
            "wav" => (FileKind::Audio, "audio/wav"),
            "ogg" | "oga" => (FileKind::Audio, "audio/ogg"),
            _ => return None,
        },
    )
}

pub fn inspect(path: &Path) -> Result<FileInfo> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(AppError::new("path", "This path is not a file."));
    }
    let kind = if let Some((kind, _)) = media_type(path) {
        kind
    } else {
        // Detect binary files before applying the text editor's size limits. UTF-16
        // BOMs must be checked before NULs, since valid UTF-16 contains NUL bytes.
        let mut sample = Vec::new();
        File::open(path)?.take(8192).read_to_end(&mut sample)?;
        let utf16 = sample.starts_with(&[0xff, 0xfe]) || sample.starts_with(&[0xfe, 0xff]);
        let invalid_utf8 = std::str::from_utf8(&sample)
            .err()
            .is_some_and(|e| e.error_len().is_some());
        let binary = !utf16
            && (invalid_utf8
                || sample.contains(&0)
                || sample.starts_with(b"%PDF-")
                || sample.starts_with(b"PK\x03\x04")
                || sample.starts_with(b"\x7fELF")
                || sample.starts_with(b"\x1f\x8b")
                || sample.iter().any(|&b| b < 9 || (b > 13 && b < 32)));
        if binary {
            FileKind::Binary
        } else {
            FileKind::Text
        }
    };
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(FileInfo {
        kind,
        size: metadata.len(),
        stamp: format!("{}-{modified}", metadata.len()),
    })
}

// Chromium requests a single byte range for playback and seeking. Bound each
// response so even a range covering a multi-gigabyte video stays inexpensive.
const RANGE_CHUNK: u64 = 2 * 1024 * 1024;
fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() {
            len - 1
        } else {
            end.parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || end < start {
        return None;
    }
    Some((start, end.min(start.saturating_add(RANGE_CHUNK - 1))))
}

pub fn response(path: &Path, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let (_, mime) =
        media_type(path).ok_or_else(|| AppError::new("media", "Unsupported media type"))?;
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut builder = Response::builder()
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
    if request.method() != "GET" && request.method() != "HEAD" {
        return Ok(builder
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Vec::new())
            .unwrap());
    }
    let range = request.headers().get("range");
    let (start, count) = if let Some(range) = range {
        let Some((start, end)) = range.to_str().ok().and_then(|r| byte_range(r, len)) else {
            return Ok(builder
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap());
        };
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header("Content-Range", format!("bytes {start}-{end}/{len}"));
        (start, end - start + 1)
    } else {
        (0, len)
    };
    builder = builder.header("Content-Length", count);
    let mut bytes = Vec::new();
    if request.method() != "HEAD" {
        file.seek(SeekFrom::Start(start))?;
        file.take(count).read_to_end(&mut bytes)?;
    }
    Ok(builder.body(bytes).unwrap())
}

fn authorized_response(
    state: &AppState,
    label: &str,
    request: &Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let query = format!("path={encoded}");
    let path = url::form_urlencoded::parse(query.as_bytes())
        .next()
        .ok_or_else(|| AppError::new("path", "Invalid media path"))?
        .1
        .into_owned();
    let path = state.authorize(label, &path)?;
    response(&path, request)
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
        let app = context.app_handle().clone();
        let label = context.webview_label().to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let result = authorized_response(&app.state::<AppState>(), &label, &request);
            responder.respond(result.unwrap_or_else(|e| {
                Response::builder()
                    .status(if e.code == "access" { 403 } else { 404 })
                    .body(Vec::new())
                    .unwrap()
            }));
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_preserves_utf16_and_handles_large_media() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("图片 #+.SVG");
        fs::write(&image, "<svg/>").unwrap();
        assert_eq!(inspect(&image).unwrap().kind, FileKind::Svg);
        assert_eq!(media_type(Path::new("test.JpEg")).unwrap().1, "image/jpeg");
        let text = dir.path().join("text");
        fs::write(&text, [0xff, 0xfe, 65, 0]).unwrap();
        assert_eq!(inspect(&text).unwrap().kind, FileKind::Text);
        fs::write(&text, b"%PDF-1.4").unwrap();
        assert_eq!(inspect(&text).unwrap().kind, FileKind::Binary);
        let video = dir.path().join("large.mp4");
        File::create(&video)
            .unwrap()
            .set_len(crate::files::MAX_FILE + 1)
            .unwrap();
        assert_eq!(inspect(&video).unwrap().size, crate::files::MAX_FILE + 1);
    }
    #[test]
    fn ranges_and_head_match_the_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.mp3");
        fs::write(&path, b"0123456789").unwrap();
        for (range, expected) in [
            ("bytes=2-5", "2345"),
            ("bytes=8-", "89"),
            ("bytes=-3", "789"),
        ] {
            let r = response(
                &path,
                &Request::builder()
                    .header("Range", range)
                    .body(vec![])
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(r.status(), 206);
            assert_eq!(r.body(), expected.as_bytes());
        }
        for range in [
            "bytes=10-",
            "bytes=8-2",
            "bytes=-0",
            "bytes=0-1,4-5",
            "invalid",
        ] {
            let r = response(
                &path,
                &Request::builder()
                    .header("Range", range)
                    .body(vec![])
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(r.status(), 416);
        }
        let r = response(
            &path,
            &Request::builder().method("HEAD").body(vec![]).unwrap(),
        )
        .unwrap();
        assert_eq!(r.headers()["Content-Length"], "10");
        assert!(r.body().is_empty());
        assert_eq!(byte_range("bytes=0-", u64::MAX), Some((0, RANGE_CHUNK - 1)));
    }
    #[test]
    fn protocol_authorizes_each_window_and_decodes_special_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("图片 #+&=.PNG");
        fs::write(&path, b"image bytes").unwrap();
        let state = AppState::default();
        state
            .windows
            .lock()
            .unwrap()
            .insert("allowed".into(), Default::default());
        state
            .windows
            .lock()
            .unwrap()
            .insert("other".into(), Default::default());
        state.grant("allowed", &path).unwrap();
        let encoded: String =
            url::form_urlencoded::byte_serialize(path.to_str().unwrap().as_bytes()).collect();
        let request = Request::builder()
            .uri(format!("http://media.localhost/{encoded}?v=123"))
            .body(vec![])
            .unwrap();
        let response = authorized_response(&state, "allowed", &request).unwrap();
        assert_eq!(response.body(), b"image bytes");
        assert_eq!(response.headers()["Content-Type"], "image/png");
        assert_eq!(
            authorized_response(&state, "other", &request)
                .unwrap_err()
                .code,
            "access"
        );
        assert!(authorized_response(&state, "missing", &request).is_err());
    }
}
