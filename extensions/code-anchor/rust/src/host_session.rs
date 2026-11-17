use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::edit::{
    EditError, EditResult, EditStore, FileOp, ModeEngine, PathPolicy, Resolved, StagedFile,
    WriteResponse,
    files::{FileRead, FileSource},
    modes::hashline::{
        HashlineEngine,
        input::{Patch, SplitOptions},
    },
    session::finalize_file_with_limits,
    stream_json::ArgSnapshot,
    text::{detect_line_ending, normalize_to_lf, strip_bom},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFile {
    pub authored: String,
    pub path: String,
    pub content: Option<String>,
    pub exists: bool,
    #[serde(default)]
    pub bytes: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostRequest {
    Inspect {
        input: String,
        cwd: String,
    },
    ReadTarget {
        path: String,
    },
    Read {
        file: HostFile,
        offset: usize,
        limit: usize,
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        summarize: bool,
    },
    Stage {
        input: String,
        cwd: String,
        home: String,
        files: Vec<HostFile>,
    },
    Commit {
        generation: u64,
        index: usize,
        written: String,
    },
    Select {
        files: Vec<String>,
        pattern: Option<String>,
        language: Option<String>,
        ignores: Vec<IgnoreFile>,
        root: String,
        #[serde(default)]
        ignore_root: Option<String>,
        #[serde(default)]
        directories: bool,
    },
    Search {
        files: Vec<HostFile>,
        pattern: String,
        language: Option<String>,
        skip: usize,
    },
    Preview {
        files: Vec<HostFile>,
        operations: Vec<crate::protocol::RewriteOperation>,
    },
    Resolve {
        files: Vec<HostFile>,
    },
    PendingPaths,
    Reject,
    Abort,
    Reset,
}

#[derive(Deserialize)]
pub struct IgnoreFile {
    pub path: String,
    pub content: String,
}

struct AstPlan {
    paths: Vec<String>,
    operations: Vec<crate::protocol::RewriteOperation>,
    replacements: usize,
    counts: BTreeMap<String, usize>,
    before: BTreeMap<String, String>,
}

struct RewriteBatch {
    staged: Vec<StagedFile>,
    replacements: usize,
    warnings: Vec<String>,
    counts: BTreeMap<String, usize>,
    files_searched: usize,
    limit_reached: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePlan {
    pub path: String,
    pub display: String,
    pub operation: &'static str,
    pub move_to: Option<String>,
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_bytes: Option<Vec<u8>>,
    pub content: Option<String>,
}

struct HostFiles {
    policy: PathPolicy,
    files: BTreeMap<String, HostFile>,
}

impl HostFiles {
    fn lookup(&self, path: &str) -> Option<&HostFile> {
        self.files
            .get(path)
            .or_else(|| self.files.values().find(|file| file.path == path))
    }

    fn read_resolved(&self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
        let key = resolved.absolute.to_string_lossy();
        let file = self.lookup(&key).ok_or_else(|| {
            EditError::apply(format!("Host did not supply file: {}", resolved.display))
        })?;
        if let Some(bytes) = &file.bytes {
            let error = std::str::from_utf8(bytes)
                .expect_err("The host sends byte arrays only for undecodable content");
            return Err(EditError::InvalidUtf8 {
                display: resolved.display.clone(),
                valid_up_to: error.valid_up_to(),
            });
        }
        let Some(raw) = &file.content else {
            return Ok(None);
        };
        if let Some(message) = self
            .policy
            .auto_generated_message(&resolved.display, &raw.as_bytes()[..raw.len().min(1024)])
        {
            return Err(EditError::apply(message));
        }
        let notebook = crate::edit::notebook::is_notebook_path(&resolved.absolute);
        let (bom, body) = strip_bom(raw);
        let text = if notebook {
            normalize_to_lf(
                &crate::edit::notebook::notebook_to_editable_text(raw, &resolved.display)
                    .map_err(|error| EditError::apply(error.to_string()))?,
            )
            .into_owned()
        } else {
            normalize_to_lf(body).into_owned()
        };
        Ok(Some(Arc::new(FileRead {
            resolved: resolved.clone(),
            canonical: resolved.absolute.clone(),
            raw: raw.clone(),
            bom,
            ending: detect_line_ending(body),
            text,
            is_notebook: notebook,
        })))
    }
}

impl FileSource for HostFiles {
    fn policy(&self) -> &PathPolicy {
        &self.policy
    }
    fn resolve(&mut self, authored: &str, _must_exist: bool) -> EditResult<Resolved> {
        let file = self
            .lookup(authored)
            .ok_or_else(|| EditError::apply(format!("Host did not resolve path: {authored}")))?;
        Ok(Resolved {
            absolute: file.path.clone().into(),
            display: authored.to_owned(),
        })
    }
    fn exists(&mut self, path: &Path) -> bool {
        self.lookup(&path.to_string_lossy())
            .is_some_and(|file| file.exists)
    }
    fn read(&mut self, authored: &str) -> EditResult<Arc<FileRead>> {
        let resolved = self.resolve(authored, true)?;
        self.read_resolved(&resolved)?
            .ok_or_else(|| EditError::apply(format!("File not found: {authored}")))
    }
    fn try_read(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
        self.read_resolved(resolved)
    }
    fn clear(&mut self) {}
}

#[derive(Default)]
pub struct HostSession {
    store: EditStore,
    generation: u64,
    pending: Vec<Option<StagedFile>>,
    ast: Option<AstPlan>,
    output_bytes: usize,
    output_lines: usize,
}

impl HostSession {
    pub fn execute(&mut self, request: HostRequest) -> Result<serde_json::Value, String> {
        match request {
            HostRequest::Reset => {
                *self = Self::default();
                Ok(serde_json::Value::Null)
            }
            HostRequest::Abort => {
                self.pending.clear();
                Ok(serde_json::Value::Null)
            }
            HostRequest::Inspect { input, cwd } => {
                let patch = Patch::parse(
                    &input,
                    &SplitOptions {
                        cwd: Some(Path::new(&cwd)),
                        path: None,
                    },
                )
                .map_err(|error| error.to_string())?;
                let mut paths = BTreeSet::new();
                if patch.sections.is_empty() {
                    if let Some(path) = crate::edit::modes::hashline::input::first_header_path(
                        &input,
                        &SplitOptions {
                            cwd: Some(Path::new(&cwd)),
                            path: None,
                        },
                    ) {
                        paths.insert(path);
                    }
                }
                for section in patch.sections {
                    paths.insert(section.path.clone());
                    if let Some(tag) = &section.file_hash {
                        for candidate in self.store.paths_with_hash(tag) {
                            if candidate.file_name() == Path::new(&section.path).file_name() {
                                paths.insert(candidate.to_string_lossy().into_owned());
                            }
                        }
                    }
                    if let Some(crate::edit::modes::hashline::types::FileOp::Move { dest }) =
                        section.file_op().map_err(|error| error.to_string())?
                    {
                        paths.insert(dest.clone());
                    }
                }
                serde_json::to_value(paths).map_err(|error| error.to_string())
            }
            HostRequest::ReadTarget { path } => {
                let (path, selector) = crate::read_selector::split_target(&path)?;
                Ok(serde_json::json!({"path":path,"selector":selector}))
            }
            HostRequest::Read {
                file,
                offset,
                limit,
                selector,
                summarize,
            } => self.read(file, offset, limit, selector.as_deref(), summarize),
            HostRequest::Select {
                files,
                pattern,
                language,
                ignores,
                root,
                ignore_root,
                directories,
            } => {
                let matching_root = ignore_root.as_deref().unwrap_or(&root);
                let mut git_builder = ignore::gitignore::GitignoreBuilder::new(matching_root);
                let mut local_builder = ignore::gitignore::GitignoreBuilder::new(matching_root);
                for file in ignores {
                    let builder = if Path::new(&file.path)
                        .file_name()
                        .is_some_and(|name| name == ".ignore")
                    {
                        &mut local_builder
                    } else {
                        &mut git_builder
                    };
                    for line in file.content.lines() {
                        builder
                            .add_line(Some(file.path.clone().into()), line)
                            .map_err(|error| error.to_string())?;
                    }
                }
                let git = git_builder.build().map_err(|error| error.to_string())?;
                let local = local_builder.build().map_err(|error| error.to_string())?;
                let ignored = |path: &Path, directory: bool| {
                    let priority = local.matched(path, directory);
                    if priority.is_none() {
                        git.matched(path, directory).is_ignore()
                    } else {
                        priority.is_ignore()
                    }
                };
                let glob = pattern
                    .map(|pattern| crate::file_pattern::Glob::new(&pattern))
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let selected: Vec<_> = files
                    .into_iter()
                    .filter(|file| {
                        let path = Path::new(file);
                        if !directories
                            && language.is_none()
                            && crate::language::CodeLanguage::from_path(path).is_none()
                        {
                            return false;
                        }
                        if ignored(path, directories)
                            || path
                                .ancestors()
                                .skip(1)
                                .take_while(|parent| {
                                    parent.starts_with(matching_root)
                                        && *parent != Path::new(matching_root)
                                })
                                .any(|parent| ignored(parent, true))
                        {
                            return false;
                        }
                        let relative = path.strip_prefix(&root).unwrap_or(path).to_string_lossy();
                        glob.as_ref().is_none_or(|glob| {
                            if directories {
                                glob.may_match_under(relative.as_bytes())
                            } else {
                                glob.is_match(relative.as_bytes())
                            }
                        })
                    })
                    .collect();
                serde_json::to_value(selected).map_err(|error| error.to_string())
            }
            HostRequest::Search {
                files,
                pattern,
                language,
                skip,
            } => self.search(files, &pattern, language.as_deref(), skip),
            HostRequest::Preview { files, operations } => {
                let batch = self.rewrite_files(files, &operations)?;
                let preview: Vec<_> = batch.staged.iter().map(|file| serde_json::json!({"path":file.absolute,"display":file.display,"tag":crate::edit::store::file_hash(&file.before),"before":file.before,"after":file.after,"diff":file.diff})).collect();
                self.ast = if batch.staged.is_empty() {
                    None
                } else {
                    Some(AstPlan {
                        paths: batch
                            .staged
                            .iter()
                            .map(|file| file.absolute.to_string_lossy().into_owned())
                            .collect(),
                        operations,
                        replacements: batch.replacements,
                        counts: batch.counts,
                        before: batch
                            .staged
                            .iter()
                            .map(|file| {
                                (
                                    file.absolute.to_string_lossy().into_owned(),
                                    file.before_raw
                                        .clone()
                                        .expect("AST previews contain source text"),
                                )
                            })
                            .collect(),
                    })
                };
                Ok(
                    serde_json::json!({"files":preview,"totalReplacements":batch.replacements,"warnings":batch.warnings,"filesSearched":batch.files_searched,"limitReached":batch.limit_reached}),
                )
            }
            HostRequest::PendingPaths => Ok(serde_json::json!(
                self.ast
                    .as_ref()
                    .ok_or("No AST edit preview is pending")?
                    .paths
            )),
            HostRequest::Reject => {
                self.ast.take().ok_or("No AST edit preview is pending")?;
                Ok(serde_json::json!("Discarded the AST edit preview."))
            }
            HostRequest::Resolve { files } => {
                let ast = self.ast.take().ok_or("No AST edit preview is pending")?;
                let original_files_match = ast.before.iter().all(|(path, before)| {
                    files
                        .iter()
                        .any(|file| &file.path == path && file.content.as_ref() == Some(before))
                });
                if !original_files_match {
                    return Err("Preview is stale; no files were modified. Run ast_edit again before resolving.".to_owned());
                }
                let batch = self.rewrite_files(files, &ast.operations)?;
                if batch.replacements != ast.replacements
                    || batch.counts != ast.counts
                    || batch.limit_reached
                {
                    return Err("Preview is stale; no files were modified. Run ast_edit again before resolving.".to_owned());
                }
                self.generation += 1;
                let plan = self.plan(batch.staged);
                Ok(
                    serde_json::json!({"generation":self.generation,"files":plan,"warnings":batch.warnings,"replacements":batch.replacements}),
                )
            }
            HostRequest::Stage {
                input,
                cwd,
                home,
                files,
            } => {
                self.pending.clear();
                let mut files = HostFiles {
                    policy: PathPolicy {
                        cwd: cwd.into(),
                        home_dir: home.into(),
                        url_schemes: Vec::new(),
                        url_alias_schemes: Vec::new(),
                        plan_writable_roots: Vec::new(),
                        plan_active: false,
                        block_auto_generated: true,
                    },
                    files: files
                        .into_iter()
                        .map(|file| (file.authored.clone(), file))
                        .collect(),
                };
                let args = ArgSnapshot {
                    input: Some(input),
                    complete: true,
                    ..Default::default()
                };
                let engine = HashlineEngine {
                    enforce_seen_lines: true,
                    max_columns: 0,
                };
                let staged = engine
                    .stage(&args, &mut files, &self.store)
                    .map_err(|error| error.to_string())?;
                self.generation += 1;
                let mut plans = self.plan(staged);
                for plan in &mut plans {
                    if plan.operation == "delete" && plan.before.is_none() {
                        plan.before_bytes =
                            files.lookup(&plan.path).and_then(|file| file.bytes.clone());
                    }
                }
                Ok(serde_json::json!({"generation": self.generation, "files": plans}))
            }
            HostRequest::Commit {
                generation,
                index,
                written,
            } => {
                if generation != self.generation {
                    return Err("The edit write acknowledgement is stale".to_owned());
                }
                if self.pending.iter().take(index).any(Option::is_some) {
                    return Err("Write acknowledgements must follow file order".to_owned());
                }
                let file = self
                    .pending
                    .get_mut(index)
                    .and_then(Option::take)
                    .ok_or("Unknown or repeated write acknowledgement")?;
                let outcome = finalize_file_with_limits(
                    file,
                    WriteResponse {
                        written,
                        diagnostics_json: None,
                    },
                    &self.store,
                    (49_usize * 1024).saturating_sub(self.output_bytes),
                    1900_usize.saturating_sub(self.output_lines),
                );
                if !outcome.text.is_empty() {
                    self.output_bytes += outcome.text.len() + 2;
                    self.output_lines += outcome.text.lines().count() + 2;
                }
                Ok(serde_json::json!({"text":outcome.text,"file":{
                    "path":outcome.display,"absolute":outcome.absolute,"operation":outcome.op.as_str(),"moveTo":outcome.move_to,
                    "diff":outcome.diff,"firstChangedLine":outcome.first_changed_line,"oldText":outcome.old_text,
                    "newText":outcome.new_text,"parseRegressed":outcome.parse_regressed
                }}))
            }
        }
    }

    fn plan(&mut self, staged: Vec<StagedFile>) -> Vec<WritePlan> {
        self.output_bytes = 0;
        self.output_lines = 0;
        let plans = staged
            .iter()
            .map(|file| WritePlan {
                path: file.absolute.to_string_lossy().into_owned(),
                display: file.display.clone(),
                operation: if file.op == FileOp::Noop {
                    "noop"
                } else {
                    file.op.as_str()
                },
                move_to: file
                    .move_to
                    .as_ref()
                    .map(|file| file.absolute.to_string_lossy().into_owned()),
                before: file.before_raw.clone(),
                before_bytes: None,
                content: file.persisted.clone(),
            })
            .collect();
        self.pending = staged.into_iter().map(Some).collect();
        plans
    }

    fn rewrite_files(
        &mut self,
        files: Vec<HostFile>,
        operations: &[crate::protocol::RewriteOperation],
    ) -> Result<RewriteBatch, String> {
        let mut patterns = BTreeSet::new();
        for op in operations {
            if !patterns.insert(&op.pattern) {
                return Err(format!("Duplicate rewrite pattern: {}", op.pattern));
            }
        }
        let mut staged = Vec::new();
        let mut replacements = 0;
        let mut warnings = Vec::new();
        let mut counts = BTreeMap::new();
        let files_searched = files.len();
        let mut limit_reached = false;
        for file in files {
            if staged.len() >= 1000 {
                limit_reached = true;
                break;
            }
            let Some(before) = file.content else { continue };
            let policy = PathPolicy {
                cwd: PathBuf::new(),
                home_dir: PathBuf::new(),
                url_schemes: Vec::new(),
                url_alias_schemes: Vec::new(),
                plan_writable_roots: Vec::new(),
                plan_active: false,
                block_auto_generated: true,
            };
            if let Some(message) = policy.auto_generated_message(
                &file.authored,
                &before.as_bytes()[..before.len().min(1024)],
            ) {
                warnings.push(message);
                continue;
            }
            let language = match crate::ast::ops::resolve_language(None, Path::new(&file.path)) {
                Ok(language) => language,
                Err(error) => {
                    warnings.push(format!("{}: {error}", file.authored));
                    continue;
                }
            };
            let outcome = crate::rewrite(language, &before, operations)?;
            match outcome {
                crate::protocol::Response::Rewrite {
                    content: after,
                    changes,
                    warnings: issues,
                } => {
                    warnings.extend(
                        issues
                            .into_iter()
                            .map(|issue| format!("{}: {issue}", file.authored)),
                    );
                    if changes == 0 {
                        continue;
                    }
                    let normalized_before = normalize_to_lf(strip_bom(&before).1).into_owned();
                    let normalized_after = normalize_to_lf(strip_bom(&after).1).into_owned();
                    self.store
                        .record(Path::new(&file.path), &normalized_before, Some(&[0]));
                    counts.insert(file.path.clone(), changes);
                    let mut item =
                        StagedFile::new(file.authored.clone(), file.path.into(), FileOp::Update);
                    item.diff = crate::edit::diff_string::generate_diff_string(
                        &normalized_before,
                        &normalized_after,
                        None,
                        &crate::edit::diff_string::BlockContextSource {
                            path: Some(&file.authored),
                            lang: None,
                            streaming: false,
                        },
                    )
                    .diff;
                    item.before = normalized_before;
                    item.after = normalized_after;
                    item.before_raw = Some(before);
                    item.persisted = Some(after);
                    item.header = crate::edit::HeaderKind::HashlineTag;
                    item.record_snapshot = true;
                    replacements += changes;
                    staged.push(item);
                }
                _ => return Err("Unexpected AST rewrite response".to_owned()),
            }
        }
        Ok(RewriteBatch {
            staged,
            replacements,
            warnings,
            counts,
            files_searched,
            limit_reached,
        })
    }

    fn search(
        &mut self,
        files: Vec<HostFile>,
        pattern: &str,
        language: Option<&str>,
        skip: usize,
    ) -> Result<serde_json::Value, String> {
        let mut matches = Vec::new();
        let mut warnings = Vec::new();
        let mut text = String::new();
        let mut total = 0;
        let mut files_searched = 0;
        let mut with_matches = 0;
        for file in files {
            let Some(source) = &file.content else {
                continue;
            };
            files_searched += 1;
            let outcome = crate::ast::ops::resolve_language(language, Path::new(&file.path))
                .map_err(|error| error.to_string())
                .and_then(|language| crate::find(language, source, pattern));
            match outcome {
                Ok(crate::protocol::Response::Matches {
                    matches: found,
                    warnings: issues,
                }) => {
                    warnings.extend(
                        issues
                            .into_iter()
                            .map(|warning| format!("{}: {warning}", file.authored)),
                    );
                    if !found.is_empty() {
                        with_matches += 1;
                    }
                    let mut shown = BTreeSet::new();
                    for matched in found {
                        if total >= skip && matches.len() < 50 {
                            shown.extend(matched.start_line..=matched.end_line);
                            let mut value = serde_json::to_value(&matched).unwrap();
                            value["path"] = serde_json::json!(file.authored);
                            matches.push(value);
                        }
                        total += 1;
                    }
                    if !shown.is_empty() {
                        let normalized = normalize_to_lf(strip_bom(source).1);
                        let tag = crate::edit::store::file_hash(&normalized);
                        text.push_str(&format!("[{}#{tag}]\n", file.authored));
                        let mut seen = vec![0_u32];
                        for (index, line) in normalized.split('\n').enumerate() {
                            if shown.contains(&(index + 1)) {
                                let row = format!("{}:{line}\n", index + 1);
                                if text.len() + row.len() > 49 * 1024 {
                                    break;
                                }
                                text.push_str(&row);
                                seen.push((index + 1) as u32);
                            }
                        }
                        self.store
                            .record(Path::new(&file.path), &normalized, Some(&seen));
                    }
                }
                Err(error) => warnings.push(format!("{}: {error}", file.authored)),
                _ => {}
            }
        }
        Ok(
            serde_json::json!({"text":text,"matches":matches,"totalMatches":total,"filesSearched":files_searched,"filesWithMatches":with_matches,"warnings":warnings,"limitReached":total>skip.saturating_add(matches.len())}),
        )
    }

    fn read(
        &mut self,
        file: HostFile,
        offset: usize,
        limit: usize,
        selector: Option<&str>,
        summarize: bool,
    ) -> Result<serde_json::Value, String> {
        if offset == 0 || limit == 0 {
            return Err("Read offset and limit must be positive".to_owned());
        }
        let raw = file
            .content
            .as_deref()
            .ok_or_else(|| format!("File not found: {}", file.authored))?;
        let notebook = crate::edit::notebook::is_notebook_path(Path::new(&file.path));
        let source = if notebook {
            crate::edit::notebook::notebook_to_editable_text(raw, &file.authored)
                .map_err(|error| error.to_string())?
        } else {
            raw.to_owned()
        };
        let source = normalize_to_lf(strip_bom(&source).1);
        let tag = crate::edit::store::file_hash(&source);
        if summarize && selector.is_none() {
            if let Some((body, seen)) =
                crate::read_summary::render(&source, &file.path, &file.authored)
            {
                self.store
                    .record(&PathBuf::from(&file.path), &source, Some(&seen));
                return Ok(
                    serde_json::json!({"path":file.authored,"text":format!("[{}#{tag}]\n{body}",file.authored),"tag":tag,"totalLines":source.split_terminator('\n').count(),"firstLine":1,"lastLine":seen.last().copied().unwrap_or(0),"truncated":false}),
                );
            }
        }
        let parsed = selector
            .map(crate::read_selector::parse)
            .transpose()?
            .flatten();
        let raw_mode = parsed.as_ref().is_some_and(|parsed| parsed.raw);
        let mut lines: Vec<_> = source.split('\n').collect();
        if lines.len() > 1 && source.ends_with('\n') {
            lines.pop();
        }
        let explicit = parsed
            .as_ref()
            .is_some_and(|parsed| !parsed.ranges.is_empty());
        let mut ranges = parsed
            .as_ref()
            .filter(|parsed| !parsed.ranges.is_empty())
            .map(|parsed| parsed.resolved(lines.len()))
            .unwrap_or_else(|| vec![(offset, offset.saturating_add(limit.min(2000) - 1))]);
        let single = ranges.len() == 1;
        if explicit && !raw_mode {
            if single {
                ranges[0].0 = ranges[0].0.saturating_sub(1).max(1);
                ranges[0].1 = ranges[0].1.saturating_add(3).min(lines.len());
            }
            let boundaries = crate::ast::block::enclosing_block_boundaries(
                crate::ast::block::EnclosingBoundaryOptions {
                    code: source.to_string(),
                    lang: None,
                    path: Some(file.path.clone()),
                    ranges: ranges
                        .iter()
                        .map(|(start, end)| crate::ast::block::LineRange {
                            start_line: *start as u32,
                            end_line: *end as u32,
                        })
                        .collect(),
                },
            )
            .ok()
            .flatten()
            .unwrap_or_default();
            ranges.extend(
                boundaries
                    .into_iter()
                    .map(|line| (line as usize, line as usize)),
            );
        }
        let mut selected = BTreeSet::new();
        for (start, end) in ranges {
            if start <= lines.len() {
                selected.extend(start..=end.min(lines.len()));
            }
        }
        let mut text = if raw_mode {
            String::new()
        } else {
            format!("[{}#{tag}]\n", file.authored)
        };
        let raw_lines: Vec<_> = (if notebook { source.as_ref() } else { raw })
            .split_inclusive('\n')
            .map(str::to_owned)
            .collect();
        let mut seen = vec![0_u32];
        let mut last = 0;
        let mut first = 0;
        let mut displayed = 0;
        let mut clipped = false;
        for number in selected.iter().copied() {
            if displayed >= 2000 {
                clipped = true;
                break;
            }
            if last > 0 && number > last + 1 && !raw_mode {
                text.push_str("…\n");
            }
            let row = if raw_mode {
                let raw_row = raw_lines.get(number - 1).map_or("", String::as_str);
                if Some(&number) == selected.last() && number < lines.len() {
                    raw_row
                        .strip_suffix("\r\n")
                        .or_else(|| raw_row.strip_suffix('\n'))
                        .unwrap_or(raw_row)
                        .to_owned()
                } else {
                    raw_row.to_owned()
                }
            } else {
                format!("{number}:{}\n", lines[number - 1])
            };
            if text.len() + row.len() > 49 * 1024 {
                clipped = true;
                break;
            }
            text.push_str(&row);
            seen.push(number as u32);
            last = number;
            if first == 0 {
                first = number;
            }
            displayed += 1;
        }
        let truncated = clipped || (!explicit && last < lines.len());
        if truncated && !raw_mode {
            text.push_str(&format!(
                "\n[Showing lines {first}-{last} of {}. Continue with {}:{}-.]",
                lines.len(),
                file.authored,
                last + 1
            ));
        }
        self.store
            .record(&PathBuf::from(&file.path), &source, Some(&seen));
        Ok(
            serde_json::json!({"path":file.authored,"text":text,"tag":tag,"totalLines":lines.len(),"firstLine":first,"lastLine":last,"truncated":truncated}),
        )
    }
}
