pub mod ast;
pub mod diff;
pub mod edit;
pub mod file_pattern;
pub mod host_session;
pub mod language;
mod protocol;
pub mod read_selector;
pub mod read_summary;
#[cfg(not(target_arch = "wasm32"))]
pub mod workspace;
#[cfg(target_arch = "wasm32")]
extern crate alloc;
#[cfg(target_arch = "wasm32")]
mod wasm_allocator;
#[cfg(target_arch = "wasm32")]
mod wasm_api;

use std::collections::BTreeMap;

use ast_grep_core::{
    MatchStrictness, Pattern,
    meta_var::MetaVariable,
    source::Edit,
    tree_sitter::{LanguageExt, StrDoc},
};
use protocol::{Match, Request, Response, RewriteOperation};

fn resolve_language(name: &str) -> Result<language::CodeLanguage, String> {
    language::CodeLanguage::from_alias(name).ok_or_else(|| {
        let supported = language::GRAMMARS
            .iter()
            .map(|grammar| grammar.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!("Unsupported language '{name}'. Supported: {supported}")
    })
}

fn compile_pattern(source: &str, language: language::CodeLanguage) -> Result<Pattern, String> {
    ast::ops::compile_pattern(source, None, &MatchStrictness::Smart, language)
        .map_err(|error| error.to_string())
}

fn find(language: language::CodeLanguage, source: &str, pattern: &str) -> Result<Response, String> {
    let pattern = compile_pattern(pattern, language)?;
    let document = language.ast_grep(source);
    let root = document.root();
    let mut warnings = Vec::new();
    if root.dfs().any(|node| node.is_error() || node.is_missing()) {
        warnings.push("parse error (syntax tree contains error nodes)".to_owned());
    }
    if pattern.has_error() {
        warnings.push(format!("pattern is not valid {} on its own (contains an ERROR node); matches may be missing or unexpected", language.name()));
    }
    let mut matches = Vec::new();
    for matched in root.find_all(pattern) {
        let range = matched.range();
        let start = matched.start_pos();
        let end = matched.end_pos();
        let mut captures = BTreeMap::new();
        for variable in matched.get_env().get_matched_variables() {
            match variable {
                MetaVariable::Capture(name, _) => {
                    if let Some(node) = matched.get_env().get_match(&name) {
                        captures.insert(name, node.text().into_owned());
                    }
                }
                MetaVariable::MultiCapture(name) => {
                    let nodes = matched.get_env().get_multiple_matches(&name);
                    if let (Some(first), Some(last)) = (nodes.first(), nodes.last()) {
                        captures.insert(
                            name,
                            source[first.range().start..last.range().end].to_owned(),
                        );
                    }
                }
                _ => {}
            }
        }
        matches.push(Match {
            text: matched.text().into_owned(),
            start_byte: range.start,
            end_byte: range.end,
            start_line: start.line() + 1,
            start_column: start.column(matched.get_node()) + 1,
            end_line: end.line() + 1,
            end_column: end.column(matched.get_node()) + 1,
            captures,
        });
    }
    matches.sort_by_key(|matched| (matched.start_byte, matched.end_byte));
    Ok(Response::Matches { matches, warnings })
}

fn rewrite(
    language: language::CodeLanguage,
    source: &str,
    operations: &[RewriteOperation],
) -> Result<Response, String> {
    let mut warnings = Vec::new();
    let mut rules = Vec::new();
    for operation in operations {
        match compile_pattern(&operation.pattern, language) {
            Ok(pattern) => {
                if pattern.has_error() {
                    warnings.push(format!(
                        "{}: pattern contains an ERROR node",
                        operation.pattern
                    ));
                }
                rules.push((&operation.replacement, pattern));
            }
            Err(error) => warnings.push(format!("{}: {error}", operation.pattern)),
        }
    }
    let document = StrDoc::try_new(source, language)?;
    let ast = ast_grep_core::AstGrep::doc(document);
    if ast
        .root()
        .dfs()
        .any(|node| node.is_error() || node.is_missing())
    {
        warnings.push("parse error (syntax tree contains error nodes)".to_owned());
        return Ok(Response::Rewrite {
            content: source.to_owned(),
            changes: 0,
            warnings,
        });
    }
    let mut edits: Vec<Edit<String>> = Vec::new();
    for (replacement, pattern) in rules {
        for matched in ast.root().find_all(pattern) {
            edits.push(matched.replace_by(replacement.as_str()));
        }
    }
    edits.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then(left.deleted_length.cmp(&right.deleted_length))
            .then(left.inserted_text.cmp(&right.inserted_text))
    });
    edits.dedup_by(|left, right| {
        left.position == right.position
            && left.deleted_length == right.deleted_length
            && left.inserted_text == right.inserted_text
    });
    let mut content = String::new();
    let mut copied = 0;
    for edit in &edits {
        let start = edit.position;
        let end = start
            .checked_add(edit.deleted_length)
            .ok_or("Computed edit range is out of bounds")?;
        if start < copied {
            return Err(
                "Overlapping replacements detected; refine pattern to avoid ambiguous edits"
                    .to_owned(),
            );
        }
        if end > source.len() || !source.is_char_boundary(start) || !source.is_char_boundary(end) {
            return Err("Computed edit range is out of bounds".to_owned());
        }
        content.push_str(&source[copied..start]);
        content.push_str(
            std::str::from_utf8(&edit.inserted_text)
                .map_err(|error| format!("Replacement text is not valid UTF-8: {error}"))?,
        );
        copied = end;
    }
    content.push_str(&source[copied..]);
    Ok(Response::Rewrite {
        content,
        changes: edits.len(),
        warnings,
    })
}

fn content_tag(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut hasher = xxhash_rust::xxh32::Xxh32::new(0);
    let mut run_start = 0;
    let mut line_start = 0;
    for segment in source.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let kept = line.trim_end_matches([' ', '\t', '\r']).len();
        if kept < line.len() {
            hasher.update(&bytes[run_start..line_start + kept]);
            run_start = line_start + line.len();
        }
        line_start += segment.len();
    }
    hasher.update(&bytes[run_start..]);
    format!("{:04X}", hasher.digest() & 0xffff)
}

fn dispatch(request: Request) -> Result<Response, String> {
    match request {
        Request::Languages => Ok(Response::Languages {
            languages: language::GRAMMARS
                .iter()
                .map(|grammar| grammar.name.clone())
                .collect(),
        }),
        Request::Parse { language, source } => {
            let language = resolve_language(&language)?;
            let document = StrDoc::try_new(&source, language)?;
            Ok(Response::Parse {
                language: language.name().to_owned(),
                root: document.tree.root_node().kind().to_owned(),
                has_error: document.tree.root_node().has_error(),
            })
        }
        Request::Find {
            language,
            source,
            pattern,
        } => find(resolve_language(&language)?, &source, &pattern),
        Request::Rewrite {
            language,
            source,
            operations,
        } => rewrite(resolve_language(&language)?, &source, &operations),
        Request::ContentTag { source } => Ok(Response::ContentTag {
            tag: content_tag(&source),
        }),
    }
}

pub fn api_version() -> u32 {
    1
}

#[cfg(not(target_arch = "wasm32"))]
pub fn execute(request: String) -> Result<String, String> {
    let response = std::panic::catch_unwind(|| {
        let parsed =
            serde_json::from_str::<Request>(&request).map_err(|error| error.to_string())?;
        dispatch(parsed)
    });
    let response = match response {
        Ok(Ok(response)) => response,
        Ok(Err(message)) => Response::Error { message },
        Err(_) => Response::Error {
            message: "CodeAnchor core failed to complete the request".to_owned(),
        },
    };
    serde_json::to_string(&response).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_a_compatible_linked_parser() {
        for grammar in language::GRAMMARS.iter() {
            let language = resolve_language(&grammar.name).unwrap();
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(&language.get_ts_language()).unwrap();
            assert!(parser.parse("", None).is_some(), "{}", grammar.name);
        }
    }

    #[test]
    fn every_language_parses_a_nonempty_source_fixture() {
        let examples: BTreeMap<String, String> =
            serde_json::from_str(include_str!("../../tests/languages.json")).unwrap();
        assert_eq!(examples.len(), language::GRAMMARS.len());
        for grammar in language::GRAMMARS.iter() {
            let source = examples.get(&grammar.name).unwrap();
            let doc = StrDoc::try_new(source, resolve_language(&grammar.name).unwrap()).unwrap();
            assert!(!doc.tree.root_node().has_error(), "{}", grammar.name);
        }
    }

    #[test]
    fn every_selected_language_captures_and_rewrites_real_source() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            source: String,
            pattern: String,
            replacement: String,
            expected: String,
        }
        let examples: BTreeMap<String, Fixture> =
            serde_json::from_str(include_str!("../../tests/language-operations.json")).unwrap();
        assert_eq!(examples.len(), language::ALL_LANGUAGES.len());
        for (name, fixture) in examples {
            let lang = resolve_language(&name).unwrap();
            let Response::Matches { matches, warnings } =
                find(lang, &fixture.source, &fixture.pattern).unwrap()
            else {
                panic!("Wrong search response")
            };
            assert_eq!(matches.len(), 1, "{name}: {warnings:?}");
            assert!(
                matches[0].captures.contains_key("VALUE"),
                "{name}: missing capture"
            );
            assert!(warnings.is_empty(), "{name}: {warnings:?}");
            let Response::Rewrite {
                content,
                changes,
                warnings,
            } = rewrite(
                lang,
                &fixture.source,
                &[RewriteOperation {
                    pattern: fixture.pattern,
                    replacement: fixture.replacement,
                }],
            )
            .unwrap()
            else {
                panic!("Wrong rewrite response")
            };
            assert_eq!(content, fixture.expected, "{name}");
            assert_eq!(changes, 1, "{name}");
            assert!(warnings.is_empty(), "{name}: {warnings:?}");
        }
    }

    #[test]
    fn json_object_patterns_remain_objects_and_escaped_strings_preserve_captures() {
        let language = resolve_language("json").unwrap();
        let Response::Matches { matches, warnings } =
            find(language, r#"[{"value":1}]"#, r#"{"value": $VALUE}"#).unwrap()
        else {
            panic!("Wrong search response")
        };
        assert!(warnings.is_empty());
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text, r#"{"value":1}"#);
        assert_eq!(
            matches[0].captures.get("VALUE").map(String::as_str),
            Some("1")
        );
        let source = r#"{"path":"C:\\", "value": 1}"#;
        let pattern = r#"{"path":"C:\\", "value": $VALUE}"#;
        let Response::Matches { matches, warnings } = find(language, source, pattern).unwrap()
        else {
            panic!("Wrong search response")
        };
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].captures.get("VALUE").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn structural_search_captures_unicode_without_losing_byte_offsets() {
        let response = find(
            resolve_language("js").unwrap(),
            "const value = '雪';\nconsole.log(value);",
            "console.log($VALUE)",
        )
        .unwrap();
        let Response::Matches { matches, .. } = response else {
            panic!("wrong response")
        };
        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].captures.get("VALUE").map(String::as_str),
            Some("value")
        );
        assert_eq!(matches[0].start_line, 2);
        assert_eq!(matches[0].start_byte, 21);
    }

    #[test]
    fn structural_rewrite_substitutes_captures() {
        let response = rewrite(
            resolve_language("javascript").unwrap(),
            "console.log(answer);",
            &[RewriteOperation {
                pattern: "console.log($VALUE)".into(),
                replacement: "logger.info($VALUE)".into(),
            }],
        )
        .unwrap();
        let Response::Rewrite {
            content, changes, ..
        } = response
        else {
            panic!("wrong response")
        };
        assert_eq!(content, "logger.info(answer);");
        assert_eq!(changes, 1);
    }

    #[test]
    fn tags_ignore_only_trailing_horizontal_whitespace() {
        assert_eq!(
            content_tag("alpha  \n beta\t\r\n"),
            content_tag("alpha\n beta\n")
        );
        assert_ne!(content_tag("alpha\nbeta\n"), content_tag("alpha\n beta\n"));
    }
}
