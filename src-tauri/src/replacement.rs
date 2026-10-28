use crate::sync::MutexExt;
use crate::{
    error::{AppError, Result},
    search::Query,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{State, WebviewWindow};

#[derive(Default)]
pub struct PlanningTasks(Mutex<HashMap<(String, String), Arc<AtomicBool>>>);

impl PlanningTasks {
    fn register(&self, label: &str, id: String) -> Result<()> {
        let mut tasks = self.0.lock_recover();
        if tasks.keys().any(|(owner, _)| owner == label) {
            return Err(AppError::new(
                "replacementBusy",
                "A replacement is already being planned",
            ));
        }
        tasks.insert((label.into(), id), Arc::new(AtomicBool::new(false)));
        Ok(())
    }

    fn get(&self, label: &str, id: String) -> Result<Arc<AtomicBool>> {
        self.0
            .lock_recover()
            .get(&(label.into(), id))
            .cloned()
            .ok_or_else(|| AppError::new("cancelled", "Replacement planning is no longer active"))
    }

    fn cancel(&self, label: &str, id: String, release: bool) {
        let mut tasks = self.0.lock_recover();
        let key = (label.into(), id);
        if let Some(task) = tasks.get(&key) {
            task.store(true, Ordering::Release);
        }
        if release {
            tasks.remove(&key);
        }
    }

    pub fn close_window(&self, label: &str) {
        self.0.lock_recover().retain(|(owner, _), task| {
            if owner != label {
                return true;
            }
            task.store(true, Ordering::Release);
            false
        });
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(AppError::new("cancelled", "Replacement planning cancelled"))
    } else {
        Ok(())
    }
}

struct PositionCursor {
    offset: usize,
    line: usize,
    column: usize,
}

impl PositionCursor {
    fn at(&mut self, text: &str, offset: usize, cancelled: &AtomicBool) -> Result<(usize, usize)> {
        let mut end = offset.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        // PCRE2 normally yields ordered ranges. Also preserve position semantics
        // for unusual patterns (e.g. lookaround with \K) that move backwards.
        if end < self.offset {
            *self = Self {
                offset: 0,
                line: 1,
                column: 1,
            };
        }
        for (index, c) in text[self.offset..end].chars().enumerate() {
            if index % 4096 == 0 {
                check_cancelled(cancelled)?;
            }
            if c == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += c.len_utf16();
            }
        }
        self.offset = end;
        Ok((self.line, self.column))
    }
}

#[derive(Deserialize, Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub text: String,
}

fn preserve(original: &str, replacement: String) -> String {
    if original.to_uppercase() == original {
        replacement.to_uppercase()
    } else if original.to_lowercase() == original {
        replacement.to_lowercase()
    } else {
        let mut chars = original.chars();
        if chars.next().is_some_and(|c| c.is_uppercase()) && chars.all(|c| !c.is_uppercase()) {
            let mut chars = replacement.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase())
                .unwrap_or_default()
        } else {
            replacement
        }
    }
}

fn expand(replacement: &str, captures: &pcre2::bytes::Captures<'_>, source: &str) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    let mut case = ' ';
    let mut single_case = ' ';
    while i < chars.len() {
        let mut piece = chars[i].to_string();
        if chars[i] == '\\' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'n' => piece = "\n".into(),
                'r' => piece = "\r".into(),
                't' => piece = "\t".into(),
                '\\' => piece = "\\".into(),
                'U' | 'L' => {
                    case = chars[i];
                    i += 1;
                    continue;
                }
                'u' | 'l' => {
                    single_case = chars[i];
                    i += 1;
                    continue;
                }
                'E' => {
                    case = ' ';
                    single_case = ' ';
                    i += 1;
                    continue;
                }
                c => piece = format!("\\{c}"),
            }
        } else if chars[i] == '$' && i + 1 < chars.len() {
            let full = captures.get(0).unwrap();
            match chars[i + 1] {
                '$' => {
                    piece = "$".into();
                    i += 1;
                }
                '&' | '0' => {
                    piece = String::from_utf8_lossy(full.as_bytes()).into();
                    i += 1;
                }
                '`' => {
                    piece = source[..full.start()].into();
                    i += 1;
                }
                '\'' => {
                    piece = source[full.end()..].into();
                    i += 1;
                }
                c if c.is_ascii_digit() => {
                    let first = c.to_digit(10).unwrap() as usize;
                    let mut index = first;
                    i += 1;
                    if i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
                        let candidate = first * 10 + chars[i + 1].to_digit(10).unwrap() as usize;
                        if candidate < captures.len() {
                            index = candidate;
                            i += 1;
                        }
                    }
                    piece = if index < captures.len() {
                        captures
                            .get(index)
                            .map(|c| String::from_utf8_lossy(c.as_bytes()).into_owned())
                            .unwrap_or_default()
                    } else {
                        format!("${index}")
                    };
                }
                _ => {}
            }
        }
        for c in piece.chars() {
            let mode = if single_case != ' ' {
                let mode = single_case;
                single_case = ' ';
                mode
            } else {
                case
            };
            match mode {
                'U' | 'u' => result.extend(c.to_uppercase()),
                'L' | 'l' => result.extend(c.to_lowercase()),
                _ => result.push(c),
            }
        }
        i += 1;
    }
    result
}

pub fn pattern(query: &Query) -> String {
    let base = if query.regex {
        query.text.clone()
    } else {
        regex::escape(&query.text)
    };
    let base = base.replace("\r\n", "\n").replace('\n', "\\r?\\n");
    if query.whole_word {
        format!("(?<!\\w)(?:{base})(?!\\w)")
    } else {
        base
    }
}

#[cfg(test)]
pub fn plan(
    text: &str,
    query: &Query,
    replacement: &str,
    preserve_case: bool,
) -> Result<Vec<Edit>> {
    plan_cancellable(
        text,
        query,
        replacement,
        preserve_case,
        &AtomicBool::new(false),
    )
}

fn plan_cancellable(
    text: &str,
    query: &Query,
    replacement: &str,
    preserve_case: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<Edit>> {
    plan_with_engine(text, query, replacement, preserve_case, cancelled, true)
}

fn plan_with_engine(
    text: &str,
    query: &Query,
    replacement: &str,
    preserve_case: bool,
    cancelled: &AtomicBool,
    jit: bool,
) -> Result<Vec<Edit>> {
    check_cancelled(cancelled)?;
    let regex = pcre2::bytes::RegexBuilder::new()
        .utf(true)
        .ucp(true)
        .multi_line(true)
        .caseless(!query.case_sensitive)
        // The interpreter rescans the remaining UTF subject on every match.
        // PCRE2's invalid-UTF-aware JIT avoids that quadratic validation work.
        .jit_if_available(jit)
        .build(&pattern(query))
        .map_err(|e| AppError::new("regex", e.to_string()))?;
    let mut edits = vec![];
    let mut cursor = PositionCursor {
        offset: 0,
        line: 1,
        column: 1,
    };
    for captures in regex.captures_iter(text.as_bytes()) {
        check_cancelled(cancelled)?;
        let captures = match captures {
            Ok(captures) => captures,
            // JIT has its own stack limit. Retry with the original interpreter
            // so valid patterns do not acquire a new failure mode.
            Err(_) if jit => {
                return plan_with_engine(text, query, replacement, preserve_case, cancelled, false);
            }
            Err(error) => return Err(AppError::new("regex", error.to_string())),
        };
        let m = captures.get(0).unwrap();
        let original = String::from_utf8_lossy(m.as_bytes());
        let mut replacement = if query.regex {
            expand(replacement, &captures, text)
        } else {
            replacement.into()
        };
        if preserve_case {
            replacement = preserve(&original, replacement);
        }
        let (line, column) = cursor.at(text, m.start(), cancelled)?;
        let (end_line, end_column) = cursor.at(text, m.end(), cancelled)?;
        edits.push(Edit {
            line,
            column,
            end_line,
            end_column,
            text: replacement,
        });
        if edits.len() >= 20_000 {
            break;
        }
    }
    check_cancelled(cancelled)?;
    Ok(edits)
}

#[tauri::command]
pub fn replacement_plan_begin(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<()> {
    state.replacement_plans.register(window.label(), request_id)
}

#[tauri::command]
pub fn replacement_plan_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
) {
    state
        .replacement_plans
        .cancel(window.label(), request_id, false);
}

#[tauri::command]
pub fn replacement_plan_release(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
) {
    state
        .replacement_plans
        .cancel(window.label(), request_id, true);
}

#[tauri::command]
pub async fn replacement_plan(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
    text: String,
    query: Query,
    replacement: String,
    preserve_case: bool,
) -> Result<Vec<Edit>> {
    let cancelled = state.replacement_plans.get(window.label(), request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        plan_cancellable(&text, &query, &replacement, preserve_case, &cancelled)
    })
    .await
    .map_err(|error| AppError::new("replacement", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query(text: &str, regex: bool) -> Query {
        Query {
            text: text.into(),
            regex,
            case_sensitive: false,
            whole_word: false,
            include: "".into(),
            exclude: "".into(),
            use_ignore: true,
            open_only: false,
            changed_only: false,
            follow_symlinks: false,
            encoding: None,
            context: 0,
        }
    }
    #[test]
    fn captures_case_and_lookbehind_use_whole_document() {
        let edits = plan(
            "prefix 中文🙂 name",
            &query("(?<=prefix )(中文)(🙂)", true),
            "\\U$1\\E-$2",
            false,
        )
        .unwrap();
        assert_eq!(
            edits[0],
            Edit {
                line: 1,
                column: 8,
                end_line: 1,
                end_column: 12,
                text: "中文-🙂".into()
            }
        );
        assert_eq!(
            plan("Hello HELLO hello", &query("hello", false), "world", true)
                .unwrap()
                .iter()
                .map(|e| &e.text)
                .collect::<Vec<_>>(),
            ["World", "WORLD", "world"]
        );
    }
    #[test]
    fn multiline_matches_crlf_and_literal_replacement_is_literal() {
        let edits = plan("a\r\nb", &query("a\nb", false), "$1\\n", false).unwrap();
        assert_eq!(edits[0].text, "$1\\n");
        assert_eq!(edits[0].end_line, 2);
    }

    #[test]
    fn cursor_preserves_utf16_crlf_and_zero_width_positions() {
        let text = "中文🙂x\r\nsecond🙂\n尾";
        let mut cursor = PositionCursor {
            offset: 0,
            line: 1,
            column: 1,
        };
        for offset in 0..=text.len() {
            assert_eq!(
                cursor.at(text, offset, &AtomicBool::new(false)).unwrap(),
                crate::search::byte_position(text, offset, 1)
            );
        }
        let edits = plan(text, &query("(?=🙂)|second🙂\\n尾", true), "x", false).unwrap();
        assert_eq!(
            (edits[0].line, edits[0].column, edits[0].end_column),
            (1, 3, 3)
        );
        assert_eq!(
            (
                edits[1].line,
                edits[1].column,
                edits[1].end_line,
                edits[1].end_column
            ),
            (2, 1, 3, 2)
        );
    }

    #[test]
    fn cancelled_plans_and_position_scans_return_no_partial_results() {
        let flag = AtomicBool::new(true);
        assert_eq!(
            plan_cancellable("a", &query("a", false), "x", false, &flag)
                .unwrap_err()
                .code,
            "cancelled"
        );
        let mut cursor = PositionCursor {
            offset: 0,
            line: 1,
            column: 1,
        };
        assert_eq!(
            cursor
                .at(&"中".repeat(10_000), 30_000, &flag)
                .unwrap_err()
                .code,
            "cancelled"
        );
    }

    #[test]
    fn planning_tasks_are_window_scoped_and_release_cancels_running_workers() {
        let tasks = PlanningTasks::default();
        tasks.register("one", "id".into()).unwrap();
        tasks.register("two", "id".into()).unwrap();
        assert!(tasks.register("one", "duplicate".into()).is_err());
        assert!(tasks.get("three", "id".into()).is_err());
        let one = tasks.get("one", "id".into()).unwrap();
        let two = tasks.get("two", "id".into()).unwrap();
        tasks.cancel("one", "id".into(), false);
        assert!(one.load(Ordering::Acquire));
        assert!(!two.load(Ordering::Acquire));
        tasks.cancel("one", "id".into(), true);
        assert!(tasks.get("one", "id".into()).is_err());
        tasks.register("one", "new".into()).unwrap();
        let new = tasks.get("one", "new".into()).unwrap();
        tasks.close_window("one");
        assert!(new.load(Ordering::Acquire));
        assert!(!two.load(Ordering::Acquire));
        tasks.close_window("two");
        assert!(two.load(Ordering::Acquire));
        assert!(tasks.0.lock_recover().is_empty());
    }

    #[test]
    fn caps_replacement_results_at_twenty_thousand() {
        assert_eq!(
            plan(&"a".repeat(20_001), &query("a", false), "x", false)
                .unwrap()
                .len(),
            20_000
        );
    }

    #[test]
    fn long_matches_keep_interpreter_compatibility_when_jit_runs_out_of_stack() {
        let text = "a".repeat(100_000);
        let query = query("(a|b)+", true);
        let flag = AtomicBool::new(false);
        let expected = plan_with_engine(&text, &query, "$1", false, &flag, false).unwrap();
        assert_eq!(plan(&text, &query, "$1", false).unwrap(), expected);
        assert_eq!(expected[0].end_column, 100_001);
        assert_eq!(expected[0].text, "a");
    }

    #[test]
    #[ignore = "Run explicitly to measure scattered-match planning; no CI time threshold"]
    fn scattered_match_planning_benchmark() {
        for n in [1_000, 4_000, 16_000] {
            let text = format!("needle{}\n", "x".repeat(506)).repeat(n);
            let mut query = query("needle", false);
            query.case_sensitive = true;
            let begin = std::time::Instant::now();
            let edits = plan(&text, &query, "new", false).unwrap();
            println!(
                "matches={n} bytes={} elapsed_ms={:.3}",
                text.len(),
                begin.elapsed().as_secs_f64() * 1000.0
            );
            assert_eq!(edits.len(), n);
            assert_eq!(
                (
                    edits[n - 1].line,
                    edits[n - 1].column,
                    edits[n - 1].end_column
                ),
                (n, 1, 7)
            );
        }
    }
}
