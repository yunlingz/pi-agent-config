use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    language::CodeLanguage,
    protocol::{Response, RewriteOperation},
};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceRequest {
    Search {
        paths: Vec<String>,
        cwd: String,
        pattern: String,
        language: Option<String>,
        skip: usize,
    },
    Preview {
        paths: Vec<String>,
        cwd: String,
        operations: Vec<RewriteOperation>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    #[serde(flatten)]
    pub matched: crate::protocol::Match,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub text: String,
    pub matches: Vec<SearchMatch>,
    pub total_matches: usize,
    pub files_searched: usize,
    pub files_with_matches: usize,
    pub limit_reached: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub tag: Option<String>,
    pub path: PathBuf,
    pub display: String,
    pub before: String,
    pub after: String,
    pub replacements: usize,
    pub diff: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub files: Vec<FileChange>,
    pub files_searched: usize,
    pub total_replacements: usize,
    pub warnings: Vec<String>,
    pub limit_reached: bool,
}

fn absolute(value: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(value.strip_prefix('@').unwrap_or(value));
    if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    }
}

pub fn candidates(
    paths: &[String],
    cwd: &Path,
    explicit_language: bool,
) -> Result<Vec<PathBuf>, String> {
    let mut result = BTreeSet::new();
    for value in paths {
        if value.contains("://") {
            return Err(format!(
                "Unsupported URL in CodeAnchor file search: {value}"
            ));
        }
        let path = absolute(value, cwd);
        let (root, selector) = if path.exists() {
            (path, None)
        } else if let Some(position) = value.find(['*', '?', '[', '{']) {
            let separator = value[..position].rfind(['/', '\\']);
            let (base, pattern) =
                separator.map_or((".", value.as_str()), |at| (&value[..at], &value[at + 1..]));
            (
                absolute(base, cwd),
                Some(
                    crate::file_pattern::Glob::new(&pattern.replace('\\', "/"))
                        .map_err(|error| error.to_string())?,
                ),
            )
        } else {
            return Err(format!("Path not found: {}", path.display()));
        };
        let metadata = std::fs::metadata(&root).map_err(|error| error.to_string())?;
        if metadata.is_file() {
            result.insert(std::fs::canonicalize(root).map_err(|error| error.to_string())?);
            continue;
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Search path must be a file or directory: {}",
                root.display()
            ));
        }
        let mut walk = ignore::WalkBuilder::new(&root);
        walk.hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false)
            .filter_entry(|entry| {
                !matches!(entry.file_name().to_str(), Some(".git" | "node_modules"))
            });
        for entry in walk.build() {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            if !explicit_language && CodeLanguage::from_path(entry.path()).is_none() {
                continue;
            }
            if let Some(selector) = &selector {
                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !selector.is_match(relative.as_bytes()) {
                    continue;
                }
            }
            result.insert(std::fs::canonicalize(entry.path()).map_err(|error| error.to_string())?);
        }
    }
    Ok(result.into_iter().collect())
}

fn display(path: &Path, cwd: &Path) -> String {
    let base = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_owned());
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn search(
    paths: &[String],
    cwd: &Path,
    pattern: &str,
    language: Option<&str>,
    skip: usize,
) -> Result<SearchResult, String> {
    let files = candidates(paths, cwd, language.is_some())?;
    let mut result = SearchResult {
        text: String::new(),
        matches: Vec::new(),
        total_matches: 0,
        files_searched: 0,
        files_with_matches: 0,
        limit_reached: false,
        warnings: Vec::new(),
    };
    for path in files {
        let name = display(&path, cwd);
        let outcome = (|| {
            let language = crate::ast::ops::resolve_language(language, &path)
                .map_err(|error| error.to_string())?;
            let source = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            crate::find(language, &source, pattern)
        })();
        result.files_searched += 1;
        match outcome {
            Ok(Response::Matches { matches, warnings }) => {
                result.warnings.extend(
                    warnings
                        .into_iter()
                        .map(|warning| format!("{name}: {warning}")),
                );
                if !matches.is_empty() {
                    result.files_with_matches += 1;
                }
                for matched in matches {
                    if result.total_matches >= skip && result.matches.len() < 50 {
                        result.matches.push(SearchMatch {
                            path: name.clone(),
                            matched,
                        });
                    }
                    result.total_matches += 1;
                }
            }
            Ok(_) => return Err("Unexpected AST search response".to_owned()),
            Err(error) => result.warnings.push(format!("{name}: {error}")),
        }
    }
    result.limit_reached = result.total_matches > skip.saturating_add(result.matches.len());
    Ok(result)
}

pub fn preview(
    paths: &[String],
    cwd: &Path,
    operations: &[RewriteOperation],
) -> Result<Plan, String> {
    if operations.is_empty() {
        return Err("`ops` must include at least one op entry".to_owned());
    }
    let mut patterns = BTreeSet::new();
    for operation in operations {
        if !patterns.insert(&operation.pattern) {
            return Err(format!("Duplicate rewrite pattern: {}", operation.pattern));
        }
    }
    let mut plan = Plan {
        files: Vec::new(),
        files_searched: 0,
        total_replacements: 0,
        warnings: Vec::new(),
        limit_reached: false,
    };
    for path in candidates(paths, cwd, false)? {
        if plan.files.len() >= 1000 {
            plan.limit_reached = true;
            break;
        }
        let name = display(&path, cwd);
        let outcome = (|| {
            let language = crate::ast::ops::resolve_language(None, &path)
                .map_err(|error| error.to_string())?;
            let before = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let guard = crate::edit::PathPolicy {
                cwd: cwd.to_owned(),
                home_dir: cwd.to_owned(),
                url_schemes: Vec::new(),
                url_alias_schemes: Vec::new(),
                plan_writable_roots: Vec::new(),
                plan_active: false,
                block_auto_generated: true,
            };
            if let Some(error) =
                guard.auto_generated_message(&name, &before.as_bytes()[..before.len().min(1024)])
            {
                return Err(error);
            }
            let rewritten = crate::rewrite(language, &before, operations)?;
            let Response::Rewrite {
                content: after,
                changes,
                ..
            } = rewritten
            else {
                return Err("Unexpected AST rewrite response".to_owned());
            };
            Ok((before, after, changes))
        })();
        plan.files_searched += 1;
        match outcome {
            Ok((before, after, replacements)) if replacements > 0 && before != after => {
                let diff = crate::edit::diff_string::generate_diff_string(
                    &before,
                    &after,
                    None,
                    &crate::edit::diff_string::BlockContextSource {
                        path: Some(&name),
                        lang: None,
                        streaming: false,
                    },
                )
                .diff;
                plan.total_replacements += replacements;
                plan.files.push(FileChange {
                    tag: None,
                    path,
                    display: name,
                    before,
                    after,
                    replacements,
                    diff,
                });
            }
            Ok(_) => {}
            Err(error) => plan.warnings.push(format!("{name}: {error}")),
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_globs_and_preview_use_real_files_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.ts"), "console.log(value);\n").unwrap();
        std::fs::write(directory.path().join("b.py"), "print(value)\n").unwrap();
        let paths = vec!["*.ts".to_owned()];
        let found = search(&paths, directory.path(), "console.log($VALUE)", None, 0).unwrap();
        assert_eq!(found.total_matches, 1);
        let plan = preview(
            &paths,
            directory.path(),
            &[RewriteOperation {
                pattern: "console.log($VALUE)".into(),
                replacement: "logger.info($VALUE)".into(),
            }],
        )
        .unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].after, "logger.info(value);\n");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("a.ts")).unwrap(),
            "console.log(value);\n"
        );
    }
}
