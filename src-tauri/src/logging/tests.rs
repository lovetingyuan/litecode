use super::*;

#[test]
fn credentials_are_redacted_and_paths_remain_readable() {
    let text = redact(
        "https://user:password@example.com/path?token=secret&ok=1 Authorization: Bearer abc123 api_key=private C:\\project\\file.ts",
    );
    for secret in ["user:password", "=secret", "abc123", "private"] {
        assert!(!text.contains(secret), "{text}");
    }
    assert!(text.contains("C:\\project\\file.ts"));
    assert!(text.contains("ok=1"));
}

#[test]
fn records_are_json_lines_with_a_strict_byte_limit() {
    let input = json!({"event": "file_failed", "message": "\u{0001}".repeat(30_000), "stack": "中🙂".repeat(10_000), "text": "private document"});
    let line = encode(&input.to_string(), Level::Error);
    assert!(line.len() < MAX_RECORD, "{}", line.len());
    assert!(!line.contains('\n'));
    let record: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(record["event"], "file_failed");
    assert_eq!(record["level"], "error");
    assert!(record["timestamp"].is_string());
    assert!(record["operationId"].is_string());
    assert!(record.get("text").is_none());
}

