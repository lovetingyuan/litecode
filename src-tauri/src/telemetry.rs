use std::sync::Arc;

pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var("SENTRY_NATIVE_DSN")
        .ok()
        .or_else(|| option_env!("SENTRY_NATIVE_DSN").map(str::to_owned))?;
    let dsn = dsn.parse().ok()?;
    let environment = if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    };
    let mut options = sentry::ClientOptions::new()
        .release(concat!("litecode@", env!("CARGO_PKG_VERSION")))
        .environment(environment)
        .attach_stacktrace(true);
    options.dsn = Some(dsn);
    options.before_send = Some(Arc::new(|mut event| {
        // Panic payloads can contain editor contents or local paths.
        for exception in &mut event.exception.values {
            exception.value = Some("LiteCode native panic".into());
        }
        Some(event)
    }));
    Some(sentry::init(options))
}
