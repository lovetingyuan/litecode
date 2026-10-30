use std::{io::Write, sync::OnceLock, time::Instant};

static STARTED: OnceLock<Instant> = OnceLock::new();

// Opt in to a JSONL file when profiling a packaged app. Never log document contents or paths.
pub fn mark(phase: &str, started: Instant) {
    let origin = STARTED.get_or_init(Instant::now);
    let record = serde_json::json!({
        "event": "startup",
        "pid": std::process::id(),
        "phase": phase,
        "elapsedMs": origin.elapsed().as_secs_f64() * 1000.0,
        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
    });
    if cfg!(debug_assertions) {
        eprintln!("[startup] {record}");
    }
    if let Some(path) = std::env::var_os("LITECODE_STARTUP_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{record}");
        }
    }
}
