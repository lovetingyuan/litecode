use crate::error::{AppError, Result};
use encoding_rs::{GBK, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

pub const LARGE_FILE: u64 = 20 * 1024 * 1024;
pub const MAX_FILE: u64 = 100 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub encoding: String,
    pub eol: String,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn decode(bytes: &[u8], preferred: Option<&str>) -> Result<(String, String)> {
    let (text, encoding, errors) =
        if bytes.starts_with(&[0xff, 0xfe]) || preferred == Some("utf16le") {
            let data = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
            let (s, e) = UTF_16LE.decode_without_bom_handling(data);
            (s.into_owned(), "utf16le", e)
        } else if bytes.starts_with(&[0xfe, 0xff]) || preferred == Some("utf16be") {
            let data = bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(bytes);
            let (s, e) = UTF_16BE.decode_without_bom_handling(data);
            (s.into_owned(), "utf16be", e)
        } else if preferred == Some("gbk") {
            let (s, e) = GBK.decode_without_bom_handling(bytes);
            (s.into_owned(), "gbk", e)
        } else {
            let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
            let data = if bom { &bytes[3..] } else { bytes };
            let s = std::str::from_utf8(data).map_err(|_| {
                AppError::new(
                    "encoding",
                    "This file is not valid UTF-8. Reopen with GBK or UTF-16 encoding.",
                )
            })?;
            (s.to_string(), if bom { "utf8bom" } else { "utf8" }, false)
        };
    if errors {
        return Err(AppError::new(
            "encoding",
            "Invalid byte sequence for the selected encoding; file was not changed.",
        ));
    }
    if text.contains('\0') {
        return Err(AppError::new(
            "binary",
            "Binary files cannot be opened as text.",
        ));
    }
    Ok((text, encoding.into()))
}

pub fn encode(text: &str, encoding: &str) -> Result<Vec<u8>> {
    Ok(match encoding {
        "utf8" => text.as_bytes().to_vec(),
        "utf8bom" => [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
        "utf16le" => [
            vec![0xff, 0xfe],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat(),
        "utf16be" => [
            vec![0xfe, 0xff],
            text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        ]
        .concat(),
        "gbk" => {
            let (bytes, _, errors) = GBK.encode(text);
            if errors {
                return Err(AppError::new(
                    "encoding",
                    "This text contains characters that GBK cannot represent. Save as UTF-8.",
                ));
            }
            bytes.into_owned()
        }
        _ => return Err(AppError::new("encoding", "Unsupported encoding")),
    })
}

pub fn read(path: &Path, force: bool, encoding: Option<&str>) -> Result<DiskDocument> {
    let size = fs::metadata(path)?.len();
    if size > MAX_FILE {
        return Err(AppError::new(
            "fileTooLarge",
            "Files over 100 MiB require an external large-file editor.",
        ));
    }
    if size > LARGE_FILE && !force {
        return Err(AppError::new(
            "largeFile",
            format!(
                "This file is {:.1} MiB. Continue with language features and minimap disabled?",
                size as f64 / 1048576.0
            ),
        ));
    }
    let bytes = fs::read(path)?;
    let (text, encoding) = decode(&bytes, encoding)?;
    let eol = if text.contains("\r\n") { "CRLF" } else { "LF" }.into();
    Ok(DiskDocument {
        path: path.to_string_lossy().into(),
        text,
        revision: hash(&bytes),
        encoding,
        eol,
    })
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "Path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    if let Ok(meta) = fs::metadata(path) {
        temp.as_file().set_permissions(meta.permissions())?;
    }
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| AppError::from(e.error))?;
    Ok(())
}

pub fn save(path: &Path, text: &str, encoding: &str, expected: Option<&str>) -> Result<String> {
    match (fs::read(path), expected) {
        (Ok(bytes), Some(revision)) if hash(&bytes) == revision => (),
        (Err(e), None) if e.kind() == std::io::ErrorKind::NotFound => (),
        (Err(e), _) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {
            return Err(AppError::new(
                "conflict",
                "The file changed on disk. Compare or reload it before saving.",
            ));
        }
    }
    let bytes = encode(text, encoding)?;
    atomic_write(path, &bytes)?;
    Ok(hash(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoding_roundtrip_and_rejection() {
        for encoding in ["utf8", "utf8bom", "utf16le", "utf16be"] {
            let s = "中文🙂\r\nsecond line\n";
            assert_eq!(
                decode(&encode(s, encoding).unwrap(), Some(encoding))
                    .unwrap()
                    .0,
                s
            );
        }
        let s = "中文\r\n";
        assert_eq!(
            decode(&encode(s, "gbk").unwrap(), Some("gbk")).unwrap().0,
            s
        );
        assert!(encode("🙂", "gbk").is_err());
        assert!(decode(&[0xff], None).is_err());
    }
    #[test]
    fn writes_reject_conflicts_and_preserve_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("测试.txt");
        let r = save(&p, "original", "utf8", None).unwrap();
        fs::write(&p, "external").unwrap();
        assert_eq!(
            save(&p, "unsaved", "utf8", Some(&r)).unwrap_err().code,
            "conflict"
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), "external");
        assert!(save(&p, "oops", "utf8", None).is_err());
    }
}
