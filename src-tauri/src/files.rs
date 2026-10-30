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
    #[cfg(windows)]
    let (mut temp, replacing) = windows_atomic::prepare(path, parent)?;
    #[cfg(not(windows))]
    let mut temp = {
        let temp = tempfile::NamedTempFile::new_in(parent)?;
        match fs::metadata(path) {
            Ok(meta) => temp.as_file().set_permissions(meta.permissions())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        temp
    };
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    #[cfg(windows)]
    if replacing {
        let temp = temp.into_temp_path();
        windows_atomic::replace(path, &temp)?;
        return Ok(());
    }
    #[cfg(windows)]
    temp.persist_noclobber(path)
        .map_err(|e| AppError::from(e.error))?;
    #[cfg(not(windows))]
    temp.persist(path).map_err(|e| AppError::from(e.error))?;
    Ok(())
}

#[cfg(windows)]
mod windows_atomic {
    use crate::error::windows_io;
    use std::{
        fs::File,
        io,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        path::Path,
    };
    use windows::{
        Win32::{
            Security::{
                DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetFileSecurityW,
                OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
                SECURITY_ATTRIBUTES, SetSecurityDescriptorControl,
            },
            Storage::FileSystem::{
                CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
                FILE_SHARE_WRITE, REPLACE_FILE_FLAGS, ReplaceFileW,
            },
        },
        core::PCWSTR,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn prepare(
        path: &Path,
        parent: &Path,
    ) -> io::Result<(tempfile::NamedTempFile, bool)> {
        match std::fs::metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((tempfile::NamedTempFile::new_in(parent)?, false));
            }
            Err(error) => return Err(error),
            Ok(_) => (),
        }
        let name = wide(path);
        let info =
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION;
        let mut needed = 0;
        let _ = unsafe { GetFileSecurityW(PCWSTR(name.as_ptr()), info.0, None, 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0u32; (needed as usize).div_ceil(4)];
        let descriptor = PSECURITY_DESCRIPTOR(storage.as_mut_ptr().cast());
        unsafe {
            GetFileSecurityW(
                PCWSTR(name.as_ptr()),
                info.0,
                Some(descriptor),
                needed,
                &mut needed,
            )
            .ok()
            .map_err(windows_io)?;
            // Do not inherit extra access from the temporary file's parent directory.
            SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                .map_err(windows_io)?;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let temp = tempfile::Builder::new().make_in(parent, |path| {
            let name = wide(path);
            let handle = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    0xC0000000,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    Some(&attributes),
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            }
            .map_err(windows_io)?;
            Ok(unsafe { File::from_raw_handle(handle.0) })
        })?;
        Ok((temp, true))
    }

    pub(super) fn replace(path: &Path, temp: &Path) -> io::Result<()> {
        let backup_dir = tempfile::Builder::new()
            .prefix(".litecode-save-")
            .tempdir_in(path.parent().unwrap())?;
        let backup_path = backup_dir.path().join("original");
        let backup = wide(&backup_path);
        let destination = wide(path);
        let temp = wide(temp);
        // ReplaceFile preserves the original DACL and other file metadata; fail closed on ACL errors.
        let result = unsafe {
            ReplaceFileW(
                PCWSTR(destination.as_ptr()),
                PCWSTR(temp.as_ptr()),
                PCWSTR(backup.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        }
        .map_err(windows_io);
        if let Err(error) = result {
            // Some ReplaceFile failures leave the original under the backup name.
            if backup_path.try_exists().unwrap_or(true) {
                if !path.try_exists().unwrap_or(true)
                    && crate::file_moves::rename_no_replace(&backup_path, path).is_ok()
                {
                    return Err(error);
                }
                let preserved = backup_dir.keep().join("original");
                return Err(io::Error::other(format!(
                    "{error}; original preserved in {}",
                    preserved.display()
                )));
            }
            return Err(error);
        }
        Ok(())
    }
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

    #[cfg(windows)]
    #[test]
    fn atomic_save_preserves_acl_and_protects_temporary_content() {
        use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
        fn acl(path: &Path, setup: &str) -> String {
            let script = format!(
                "$ErrorActionPreference = 'Stop'; $p = $env:LITECODE_ACL_TEST_PATH; {setup}; [System.IO.File]::GetAccessControl($p).Sddl"
            );
            let result = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .env("LITECODE_ACL_TEST_PATH", path)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            String::from_utf8(result.stdout).unwrap().trim().to_string()
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("restricted.txt");
        fs::write(&path, "original").unwrap();
        let original = acl(
            &path,
            "$a = [System.IO.File]::GetAccessControl($p); $a.SetAccessRuleProtection($true, $false); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'); $a.AddAccessRule($rule); [System.IO.File]::SetAccessControl($p, $a)",
        );
        let (temp, replacing) = windows_atomic::prepare(&path, dir.path()).unwrap();
        assert!(replacing);
        assert_eq!(temp.as_file().metadata().unwrap().len(), 0);
        assert_eq!(
            acl(temp.path(), "").replace("D:PAI", "D:P"),
            original.replace("D:PAI", "D:P")
        );
        drop(temp);
        atomic_write(&path, b"secret").unwrap();
        assert_eq!(acl(&path, ""), original);
        assert_eq!(fs::read(&path).unwrap(), b"secret");

        let inherited = acl(
            &path,
            "$a = [System.IO.File]::GetAccessControl($p); $a.SetAccessRuleProtection($false, $true); [System.IO.File]::SetAccessControl($p, $a)",
        );
        atomic_write(&path, b"updated").unwrap();
        assert_eq!(acl(&path, ""), inherited);
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&path)
            .unwrap();
        assert!(atomic_write(&path, b"must not replace").is_err());
        drop(held);
        assert_eq!(fs::read(&path).unwrap(), b"updated");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
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
