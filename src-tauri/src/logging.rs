use crate::{error::Result, sync::MutexExt};
use log::Level;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

const MAX_RECORD: usize = 16 * 1024;
static READY: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static RECENT: LazyLock<Mutex<HashMap<String, (Instant, u64)>>> = LazyLock::new(Mutex::default);
static URL_CREDENTIALS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+@([^\s/]+)").unwrap());
static SECRETS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)((?:[?&]|\b)(?:[a-z0-9_-]*(?:token|password|passwd|secret|authorization|credential|signature|api[_-]?key)|sig)[\s"']*[:=][\s"']*)(?:bearer\s+|basic\s+)?[^\s&"'<>;,]+"#).unwrap()
});
static AUTH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic)\s+[a-z0-9_./+=-]+").unwrap());

pub struct LogStatus(pub Option<String>);

fn truncate(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn redact(value: &str) -> String {
    let value = URL_CREDENTIALS.replace_all(value, "${1}[REDACTED]@${2}");
    let value = SECRETS.replace_all(&value, "${1}[REDACTED]");
    AUTH.replace_all(&value, "${1} [REDACTED]").into_owned()
}

fn encode(message: &str, level: Level) -> String {
    let input =
        serde_json::from_str::<Value>(message).unwrap_or_else(|_| json!({"message": message}));
    let mut record = json!({
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level.as_str().to_lowercase(),
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "source": "backend",
        "event": "native_error",
        "operationId": format!("{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)),
    });
    // Only these fields can enter the file; never serialize arbitrary error objects or IPC arguments.
    for field in [
        "source",
        "event",
        "operationId",
        "window",
        "command",
        "path",
        "code",
        "message",
        "stack",
    ] {
        if let Some(value) = input[field].as_str() {
            record[field] = Value::String(truncate(
                &redact(value),
                if field == "message" { 8192 } else { 4096 },
            ));
        }
    }
    if let Some(count) = input["suppressed"].as_u64() {
        record["suppressed"] = count.into();
    }
    let mut encoded = record.to_string();
    // JSON escaping and UTF-8 can expand strings; cap the serialized record, including its newline.
    if encoded.len() >= MAX_RECORD {
        record.as_object_mut().unwrap().remove("stack");
        for field in [
            "message",
            "command",
            "path",
            "operationId",
            "event",
            "window",
            "code",
            "source",
        ] {
            if let Some(value) = record[field].as_str() {
                record[field] = truncate(value, 256).into();
            }
        }
        record["truncated"] = true.into();
        encoded = record.to_string();
    }
    encoded
}

fn prune_archives(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut archives: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_prefix("litecode_")?;
            let date = stem.strip_suffix(".bak").unwrap_or(stem);
            let date = date.strip_suffix(".log")?;
            chrono::NaiveDateTime::parse_from_str(date, "%Y-%m-%d_%H-%M-%S").ok()?;
            Some((date.to_owned(), !name.ends_with(".bak"), entry.path()))
        })
        .collect();
    archives.sort();
    for (_, _, path) in archives.iter().take(archives.len().saturating_sub(4)) {
        // Best effort: a logging failure must not re-enter the logger.
        let _ = std::fs::remove_file(path);
    }
}

fn builder(directory: Option<&Path>, max_size: u128) -> tauri_plugin_log::Builder {
    let mut targets = vec![Target::new(TargetKind::Stderr)];
    if let Some(directory) = directory {
        targets.push(Target::new(TargetKind::Folder {
            path: directory.to_owned(),
            file_name: Some("litecode".into()),
        }));
        // The plugin creates .log.bak files on same-second rotation but excludes
        // them from KeepSome's cleanup. Bound those collision archives as well.
        let directory = directory.to_owned();
        prune_archives(&directory);
        targets.push(Target::new(TargetKind::Dispatch(
            tauri_plugin_log::fern::Dispatch::new().chain(tauri_plugin_log::fern::Output::call(
                move |_| prune_archives(&directory),
            )),
        )));
    }
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Warn)
        .filter(|metadata| {
            metadata.target() == "litecode" || metadata.target().starts_with("webview")
        })
        .targets(targets)
        .max_file_size(max_size)
        .rotation_strategy(RotationStrategy::KeepSome(4))
        .format(|out, message, record| {
            out.finish(format_args!(
                "{}",
                encode(&message.to_string(), record.level())
            ))
        })
}

fn attach(
    app: &AppHandle,
    directory: Option<&Path>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let (_, level, logger) = builder(directory, 2 * 1024 * 1024).split(app)?;
    tauri_plugin_log::attach_logger(level, logger)?;
    Ok(())
}

pub fn init(app: &AppHandle, data_dir: &Path) {
    // Plugin setup holds Tauri's plugin-store lock. Configure the global logger
    // here without recursively registering a plugin from instance's setup hook.
    let warning = match attach(app, Some(&data_dir.join("logs"))) {
        Ok(()) => {
            READY.store(true, Ordering::Release);
            None
        }
        Err(error) => {
            let warning = format!(
                "Could not initialize error log files: {}",
                redact(&error.to_string())
            );
            eprintln!("{warning}");
            if attach(app, None).is_ok() {
                READY.store(true, Ordering::Release);
            }
            Some(warning)
        }
    };
    app.manage(LogStatus(warning));
}

pub fn record(level: Level, event: &str, window: Option<&str>, code: &str, message: &str) {
    if matches!(
        code,
        "cancelled"
            | "workspaceTrust"
            | "formatterTrust"
            | "languageTrust"
            | "updateBusy"
            | "gitBusy"
            | "toolBusy"
            | "searchBusy"
    ) {
        return;
    }
    // Parser diagnostics and tool output may quote document contents. Retain only their category.
    let message = if matches!(
        code,
        "json" | "encoding" | "regex" | "lspProtocol" | "formatter" | "install"
    ) {
        "Operation failed; parser or tool output omitted"
    } else {
        message
    };
    let message = truncate(&redact(message), 8192);
    let key = format!(
        "{event}:{}:{code}:{}",
        window.unwrap_or_default(),
        truncate(&message, 512)
    );
    let now = Instant::now();
    let suppressed = {
        let mut recent = RECENT.lock_recover();
        if let Some((time, count)) = recent.get_mut(&key)
            && now.duration_since(*time) < Duration::from_secs(30)
        {
            *count += 1;
            return;
        }
        let suppressed = recent.remove(&key).map_or(0, |(_, count)| count);
        if recent.len() >= 128 {
            recent.retain(|_, (time, _)| now.duration_since(*time) < Duration::from_secs(30));
        }
        if recent.len() >= 128 {
            recent.clear();
        }
        recent.insert(key, (now, 0));
        suppressed
    };
    let message = json!({"event": event, "window": window, "code": code, "message": message, "suppressed": suppressed}).to_string();
    if READY.load(Ordering::Acquire) {
        log::log!(target: "litecode", level, "{message}");
    } else {
        eprintln!("{}", encode(&message, level));
    }
}

pub fn error(event: &str, window: Option<&str>, code: &str, message: &str) {
    record(Level::Error, event, window, code, message);
}

pub fn warning(event: &str, window: Option<&str>, message: &str) {
    record(Level::Warn, event, window, "recovery", message);
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Panic payloads can contain assertion operands/source text. Keep location and backtrace only.
        let payload = info
            .payload()
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| info.payload().downcast_ref::<&str>().copied());
        if let Some(message) =
            payload.and_then(|message| message.strip_prefix("Failed to setup app: "))
        {
            error("application_setup_failed", None, "tauri", message);
        }
        error(
            "rust_panic",
            None,
            "panic",
            &format!(
                "Panic at {}\n{}",
                info.location().map(|l| l.to_string()).unwrap_or_default(),
                std::backtrace::Backtrace::force_capture()
            ),
        );
        log::logger().flush();
        previous(info);
    }));
}

#[tauri::command]
pub fn open_logs_directory(app: AppHandle, state: State<'_, crate::state::AppState>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let directory = state.data_dir.join("logs");
    std::fs::create_dir_all(&directory)?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|error| crate::error::AppError::new("logs", error.to_string()))
}

#[cfg(test)]
mod tests;
