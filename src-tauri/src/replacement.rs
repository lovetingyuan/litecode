use crate::{
    error::{AppError, Result},
    search::{Query, byte_position},
};
use serde::{Deserialize, Serialize};

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

pub fn plan(
    text: &str,
    query: &Query,
    replacement: &str,
    preserve_case: bool,
) -> Result<Vec<Edit>> {
    let regex = pcre2::bytes::RegexBuilder::new()
        .utf(true)
        .ucp(true)
        .multi_line(true)
        .caseless(!query.case_sensitive)
        .build(&pattern(query))
        .map_err(|e| AppError::new("regex", e.to_string()))?;
    let mut edits = vec![];
    for captures in regex.captures_iter(text.as_bytes()) {
        let captures = captures.map_err(|e| AppError::new("regex", e.to_string()))?;
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
        let (line, column) = byte_position(text, m.start(), 1);
        let (end_line, end_column) = byte_position(text, m.end(), 1);
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
    Ok(edits)
}

#[tauri::command]
pub fn replacement_plan(
    text: String,
    query: Query,
    replacement: String,
    preserve_case: bool,
) -> Result<Vec<Edit>> {
    plan(&text, &query, &replacement, preserve_case)
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
}
