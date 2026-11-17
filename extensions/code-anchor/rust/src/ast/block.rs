//! Adapted from the pinned OMP reference. See THIRD-PARTY-NOTICES.
//! Resolve the syntactic block that begins on a given source line.
//!
//! Powers the hashline `replace block N:` operator: given a 1-indexed line,
//! parse the source with tree-sitter and return the line span of the outermost
//! named node that *begins* on that line (excluding the whole-file root). Brace
//! languages anchor a construct's block to its opening line, so pointing at the
//! line that opens an `if` / `function` / `struct` resolves to that construct's
//! full span; pointing at a continuation line or a lone closing delimiter
//! resolves to nothing.

use std::collections::BTreeSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Point, TreeCursor};

use crate::ast::{
    parse_cache::{MAX_ENTRY_SOURCE_BYTES, parse_cached},
    summary::{node_content_end_line, node_start_line, resolve_language},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRangeOptions {
    /// Source code to inspect.
    pub code: String,
    /// Language alias (e.g. "rust", "typescript") used before path inference.
    pub lang: Option<String>,
    /// File path used to infer language by extension when `lang` is omitted.
    pub path: Option<String>,
    /// 1-indexed source line the block must begin on.
    pub line: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockRange {
    /// 1-indexed inclusive first line of the resolved block.
    pub start_line: u32,
    /// 1-indexed inclusive last line of the resolved block.
    pub end_line: u32,
}

/// Count of leading space/tab bytes on `row` (0-indexed), i.e. the byte column
/// of the first content character. Returns `None` when `row` is out of range
/// or the line is blank / whitespace-only — there is no block to resolve there.
fn first_content_column(code: &str, row: usize) -> Option<usize> {
    let line = code.split('\n').nth(row)?;
    for (col, byte) in line.bytes().enumerate() {
        if byte != b' ' && byte != b'\t' {
            return Some(col);
        }
    }
    None
}

/// Resolve the block beginning on `options.line`.
///
/// Returns `None` (a soft "no block here", surfaced as a hard error one layer
/// up) when the language is unrecognized, the line is out of range / blank, no
/// node begins on that line, or the resolved subtree contains a syntax error.
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
    let BlockRangeOptions {
        code,
        lang,
        path,
        line,
    } = options;
    if line == 0 || code.is_empty() {
        return Ok(None);
    }
    let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
        return Ok(None);
    };
    let row = (line - 1) as usize;
    let Some(col) = first_content_column(&code, row) else {
        return Ok(None);
    };

    let Some(tree) = parse_cached(&code, language, path.as_deref())? else {
        return Ok(None);
    };
    let root = tree.root_node();

    // Query a one-column-wide range over the first content character rather
    // than a zero-width point. Some grammars (e.g. tree-sitter-swift) insert a
    // zero-width separator node at the start of a statement that follows a
    // blank line. An empty point range at that node's start gets absorbed into
    // the invisible node, which has no children and is not "relevant", so
    // `named_descendant_for_point_range` bubbles back up to the last visible
    // ancestor (the enclosing body, or the file root). That made `replace
    // block` on a line like `var body: some View {` preceded by a blank line
    // resolve to the whole enclosing type body and then fail. Spanning the
    // first character skips the zero-width node (its end is < the range end)
    // and forces the descent into the node that begins on `row`.
    let point = Point::new(row, col);
    let point_end = Point::new(row, col + 1);
    let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
        return Ok(None);
    };
    // A leaf whose own start row is earlier than `row` means `point` landed on
    // a continuation line or a closing delimiter of a block that opened earlier
    // — there is no block *beginning* on line N.
    if leaf.start_position().row != row {
        return Ok(None);
    }
    // Climb to the outermost named ancestor that still begins on `row`,
    // excluding the whole-file root. The first parent that starts before `row`
    // stops the climb, and so does a statement-sequence container: it begins
    // exactly where its first statement does, so adopting it would swallow
    // every following sibling statement.
    let mut node = leaf;
    while let Some(parent) = node.parent() {
        if parent.id() == root.id() {
            break;
        }
        if parent.start_position().row != row {
            break;
        }
        if is_statement_sequence(parent, node) {
            break;
        }
        node = parent;
    }
    // Refuse degenerate error-recovery spans: a missing brace can make
    // tree-sitter wrap a huge region in an ERROR node. Checking only the
    // resolved node's subtree (not the whole file) keeps an unrelated syntax
    // error elsewhere from disabling the feature.
    if node.has_error() {
        return Ok(None);
    }
    Ok(Some(BlockRange {
        start_line: node_start_line(node),
        end_line: node_content_end_line(node),
    }))
}

/// Is `parent` a statement-sequence container that `node` merely opens? These
/// nodes wrap the sibling statements or entries of a body without a token of
/// their own, so they begin exactly where their first child does: Go and
/// PowerShell `statement_list`, Python/Starlark/Lua `block`, Ruby
/// `body_statement`, Swift/Kotlin `statements`, HCL/CMake `body`, Scala
/// `indented_block`, YAML `block_mapping`/`block_sequence`, Kotlin
/// `import_list`, PowerShell `hash_literal_body`.
///
/// The container is matched by kind because grammars expose no uniform
/// structural marker: field-less prefix runs such as Java/Kotlin/Swift
/// `modifiers` (one annotation per line) look identical but must be climbed
/// through to reach the declaration. Braced `block`s never match because they
/// begin at `{`; requiring the next sibling to start a later row at `node`'s
/// column also rules out a leading label (`'a: {` in Rust). Extras (comments)
/// are skipped when looking for that next sibling, so `if … {} // note` and
/// comment-only lines — even dedented ones — still stop the climb. When only
/// extras follow `node`, the container merely adds those trailing comments to
/// `node`'s span, so the climb stops there too rather than swallowing them.
fn is_statement_sequence(parent: Node<'_>, node: Node<'_>) -> bool {
    if !matches!(
        parent.kind(),
        "statement_list"
            | "block"
            | "body_statement"
            | "statements"
            | "body"
            | "indented_block"
            | "block_mapping"
            | "block_sequence"
            | "import_list"
            | "hash_literal_body"
    ) || parent.start_byte() != node.start_byte()
    {
        return false;
    }
    let end_row = node.end_position().row;
    let mut next = node.next_named_sibling();
    let mut skipped_extra = false;
    while let Some(sibling) = next.filter(|s| s.is_extra()) {
        skipped_extra = true;
        next = sibling.next_named_sibling();
    }
    match next {
        Some(next) => {
            let next_start = next.start_position();
            next_start.row > end_row && next_start.column == node.start_position().column
        }
        None => skipped_extra,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineRange {
    /// 1-indexed inclusive first visible line.
    pub start_line: u32,
    /// 1-indexed inclusive last visible line.
    pub end_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnclosingBoundaryOptions {
    /// Source code to inspect.
    pub code: String,
    /// Language alias (e.g. "rust", "typescript") used before path inference.
    pub lang: Option<String>,
    /// File path used to infer language by extension when `lang` is omitted.
    pub path: Option<String>,
    /// 1-indexed inclusive visible line ranges (the lines actually shown).
    pub ranges: Vec<LineRange>,
}

/// Sort, drop invalid, and merge adjacent/overlapping ranges so visibility
/// tests can binary-search a non-overlapping list.
fn normalize_ranges(mut ranges: Vec<LineRange>) -> Vec<LineRange> {
    ranges.retain(|range| range.start_line > 0 && range.end_line >= range.start_line);
    ranges.sort_by(|a, b| {
        a.start_line
            .cmp(&b.start_line)
            .then(a.end_line.cmp(&b.end_line))
    });
    let mut merged: Vec<LineRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(last) = merged.last_mut()
            && range.start_line <= last.end_line.saturating_add(1)
        {
            last.end_line = last.end_line.max(range.end_line);
            continue;
        }
        merged.push(range);
    }
    merged
}

fn is_visible(merged: &[LineRange], line: u32) -> bool {
    merged
        .binary_search_by(|range| {
            if line < range.start_line {
                std::cmp::Ordering::Greater
            } else if line > range.end_line {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Does any visible line fall inside the inclusive line span `[start, end]`?
fn intersects_visible(merged: &[LineRange], start: u32, end: u32) -> bool {
    // `merged` is sorted and non-overlapping, so the first range that can
    // possibly overlap is the first one whose `end_line` reaches `start`.
    let idx = merged.partition_point(|range| range.end_line < start);
    merged.get(idx).is_some_and(|range| range.start_line <= end)
}

/// Depth-first walk collecting boundary lines from every multi-line named node
/// that straddles a visible-range edge. A single reused [`TreeCursor`] keeps
/// the traversal allocation-free.
fn collect_boundaries(cursor: &mut TreeCursor<'_>, merged: &[LineRange], out: &mut BTreeSet<u32>) {
    let node = cursor.node();
    // Prune whole subtrees that cannot contribute. A node contributes only when
    // one of its own endpoint lines is visible, and both of those lines lie
    // inside its raw row span; every descendant's span is contained in this
    // one, so a span holding no visible line rules out this node *and*
    // everything beneath it. Without the prune the walk is O(nodes in file)
    // even though the answer is bounded by the window size — which made the
    // traversal cost roughly twice the parse on a large file.
    let raw_start = node.start_position().row.saturating_add(1) as u32;
    let raw_end = node.end_position().row.saturating_add(1) as u32;
    if !intersects_visible(merged, raw_start, raw_end) {
        return;
    }
    // Skip the whole-file root: its only "boundary" is EOF, never a useful
    // matching line (mirrors `block_range_at` excluding the root).
    if node.is_named() && node.parent().is_some() {
        let start = node_start_line(node);
        let end = node_content_end_line(node);
        if end > start {
            let start_visible = is_visible(merged, start);
            let end_visible = is_visible(merged, end);
            // Opener shown, closer off-window → surface the closer (and vice
            // versa). A node fully inside or fully outside the window adds
            // nothing.
            if start_visible && !end_visible {
                out.insert(end);
            } else if end_visible && !start_visible {
                out.insert(start);
            }
        }
    }
    if cursor.goto_first_child() {
        loop {
            collect_boundaries(cursor, merged, out);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        cursor.goto_parent();
    }
}

/// Generalize "show the matching bracket" to every tree-sitter block: for each
/// multi-line named node whose span crosses the visible window, return the
/// boundary line sitting *outside* that window.
///
/// - node opens on a visible line but closes past the window → its closing line
/// - node closes on a visible line but opens before the window → its opening
///   line
///
/// Because the trigger is an endpoint *inside* the window, the result is
/// bounded by the window size (not nesting depth), exactly like a bracket scan
/// — but it also covers indentation languages (Python) and uses real syntactic
/// spans.
///
/// Returns `None` when the language is unrecognized or the source fails to
/// parse / carries a syntax error (caller falls back to a lexical bracket
/// scan); `Some(sorted unique boundary lines)` otherwise (possibly empty).
pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
    let EnclosingBoundaryOptions {
        code,
        lang,
        path,
        ranges,
    } = options;
    let merged = normalize_ranges(ranges);
    if code.is_empty() || merged.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
        return Ok(None);
    };
    let Some(tree) = parse_cached(&code, language, path.as_deref())? else {
        return Ok(None);
    };
    let root = tree.root_node();
    // A file-level syntax error makes error-recovery spans unreliable; defer to
    // the lexical scanner rather than emit boundaries off a broken tree.
    if root.has_error() {
        return Ok(None);
    }

    let mut boundaries = BTreeSet::new();
    let mut cursor = root.walk();
    collect_boundaries(&mut cursor, &merged, &mut boundaries);
    Ok(Some(boundaries.into_iter().collect()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeSpan {
    /// 1-indexed inclusive first line of the node.
    pub start_line: u32,
    /// 1-indexed inclusive last content line of the node.
    pub end_line: u32,
    /// Tree-sitter grammar node kind (e.g. `attribute_item`, `function_item`).
    pub kind: String,
}

/// Parse `code` into the shared tree cache.
///
/// The next block query over the same source and language is then a cache
/// hit. Does nothing for empty source or an unrecognized language, where the
/// queries never parse either, nor for a source over
/// [`MAX_ENTRY_SOURCE_BYTES`], where a typical tree would not fit the cache's
/// memory budget (it would be discarded and parsed again by the query).
pub fn warm_parse(code: &str, lang: Option<&str>, path: Option<&str>) -> Result<()> {
    if !code.is_empty()
        && code.len() <= MAX_ENTRY_SOURCE_BYTES
        && let Some(language) = resolve_language(lang, path)
    {
        parse_cached(code, language, path)?;
    }
    Ok(())
}

/// Named-node chain containing `options.line`, innermost-first, excluding the
/// whole-file root.
///
/// The chain descends through the line's first content character, so
/// single-line nodes beginning on the line (attributes, decorators, one-line
/// statements) come first, followed by every enclosing construct up to — but
/// not including — the file root. Callers use it to classify a line by grammar
/// node kind and to enumerate enclosing construct end lines.
///
/// ERROR and MISSING recovery nodes are skipped rather than failing the whole
/// chain: an unrelated syntax error elsewhere in the file leaves healthy
/// ancestors' spans meaningful.
///
/// Returns `None` when the language is unrecognized, the line is out of
/// range / blank, or the source fails to parse entirely.
pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
    let BlockRangeOptions {
        code,
        lang,
        path,
        line,
    } = options;
    if line == 0 || code.is_empty() {
        return Ok(None);
    }
    let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
        return Ok(None);
    };
    let row = (line - 1) as usize;
    let Some(col) = first_content_column(&code, row) else {
        return Ok(None);
    };
    let Some(tree) = parse_cached(&code, language, path.as_deref())? else {
        return Ok(None);
    };
    let root = tree.root_node();
    // One-column-wide range for the same zero-width-node reason as
    // `block_range_at` above.
    let point = Point::new(row, col);
    let point_end = Point::new(row, col + 1);
    let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
        return Ok(None);
    };
    let mut chain = Vec::new();
    let mut node = Some(leaf);
    while let Some(current) = node {
        if current.id() == root.id() {
            break;
        }
        if current.is_named() && !current.is_error() && !current.is_missing() {
            chain.push(NodeSpan {
                start_line: node_start_line(current),
                end_line: node_content_end_line(current),
                kind: current.kind().to_string(),
            });
        }
        node = current.parent();
    }
    Ok(Some(chain))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(code: &str, path: &str, line: u32) -> Option<BlockRange> {
        block_range_at(BlockRangeOptions {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            line,
        })
        .expect("block resolution succeeds")
    }

    fn chain(code: &str, path: &str, line: u32) -> Vec<NodeSpan> {
        node_chain_at(BlockRangeOptions {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            line,
        })
        .expect("chain resolution succeeds")
        .expect("language recognized and line non-blank")
    }

    const RUST_ANNOTATED: &str = "mod m {\n   impl S {\n      #[napi]\n      fn f(&self) -> u32 \
	                              {\n         1\n      }\n   }\n}\n";

    /// A consumer classifying an attribute row must find a single-line
    /// `attribute_item` in the chain at that line.
    #[test]
    fn chain_names_rust_attribute_row() {
        let spans = chain(RUST_ANNOTATED, "x.rs", 3);
        assert!(
            spans
                .iter()
                .any(|s| s.kind == "attribute_item" && s.start_line == 3 && s.end_line == 3),
            "{spans:?}"
        );
    }

    /// A consumer relocating past enclosing constructs needs the chain at a
    /// construct's opening line to carry every enclosing end line,
    /// innermost-first. Wrapper nodes (`block`, `declaration_list`) share end
    /// lines with their construct; consumers dedupe.
    #[test]
    fn chain_orders_enclosing_ends_innermost_first() {
        let spans = chain(RUST_ANNOTATED, "x.rs", 4);
        let mut ends: Vec<u32> = spans
            .iter()
            .filter(|s| s.end_line > 4)
            .map(|s| s.end_line)
            .collect();
        ends.dedup();
        // fn f ends on 6, impl on 7, mod on 8.
        assert_eq!(ends, vec![6, 7, 8]);
    }

    /// TypeScript decorators are children of the declaration they precede; the
    /// chain at the decorator line must still surface the single-line
    /// `decorator` node.
    #[test]
    fn chain_names_ts_decorator_row() {
        let code = "/** d */\n@Injectable()\nclass Service {}\n";
        let spans = chain(code, "x.ts", 2);
        assert!(
            spans
                .iter()
                .any(|s| s.kind == "decorator" && s.start_line == 2 && s.end_line == 2),
            "{spans:?}"
        );
    }

    /// Blank lines carry no chain; unknown languages resolve to `None`.
    #[test]
    fn chain_declines_blank_lines_and_unknown_languages() {
        let blank = node_chain_at(BlockRangeOptions {
            code: "a\n\nb\n".to_string(),
            lang: None,
            path: Some("x.ts".to_string()),
            line: 2,
        })
        .unwrap();
        assert_eq!(blank, None);
        let unknown = node_chain_at(BlockRangeOptions {
            code: "a\n".to_string(),
            lang: None,
            path: Some("x.unknownext".to_string()),
            line: 1,
        })
        .unwrap();
        assert_eq!(unknown, None);
    }

    const TS_EXAMPLE: &str = "function x() {\n  if (y) {\n  }\n}\n";

    #[test]
    fn resolves_inner_if_block() {
        assert_eq!(
            resolve(TS_EXAMPLE, "x.ts", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 3
            })
        );
    }

    #[test]
    fn resolves_enclosing_function_block() {
        assert_eq!(
            resolve(TS_EXAMPLE, "x.ts", 1),
            Some(BlockRange {
                start_line: 1,
                end_line: 4
            })
        );
    }

    #[test]
    fn lone_closing_brace_resolves_to_nothing() {
        // Line 3 is `  }` — the closing delimiter of a block that opened on an
        // earlier line, so no block *begins* there.
        assert_eq!(resolve(TS_EXAMPLE, "x.ts", 3), None);
    }

    #[test]
    fn blank_line_resolves_to_nothing() {
        let code = "function x() {\n\n  return 1;\n}\n";
        assert_eq!(resolve(code, "x.ts", 2), None);
    }

    #[test]
    fn out_of_range_line_resolves_to_nothing() {
        assert_eq!(resolve(TS_EXAMPLE, "x.ts", 99), None);
        assert_eq!(resolve(TS_EXAMPLE, "x.ts", 0), None);
    }

    #[test]
    fn unrecognized_extension_resolves_to_nothing() {
        assert_eq!(resolve(TS_EXAMPLE, "x.unknownext", 2), None);
    }

    #[test]
    fn resolves_zsh_if_block_in_extensionless_rc_file() {
        // Regression: an extensionless shell rc file (`zshrc`/`.zshrc`) must
        // infer the bash grammar so `replace block` / `insert after block`
        // works. Previously `Path::extension` returned `None`, leaving block
        // ops permanently unresolvable on these files.
        let code = "ZSH_COMPDUMP=x\nif [[ -f \"$ZSH_COMPDUMP\" ]]; then\n  compinit -C\nelse\n  \
		            compinit\nfi\n";
        let span = Some(BlockRange {
            start_line: 2,
            end_line: 6,
        });
        assert_eq!(resolve(code, "modules/zsh/zshrc", 2), span);
        assert_eq!(resolve(code, ".zshrc", 2), span);
        assert_eq!(resolve(code, "/home/u/.bashrc", 2), span);
    }

    #[test]
    fn resolves_top_level_python_def() {
        let code = "x = 1\ndef greet():\n    return 1\n";
        assert_eq!(
            resolve(code, "g.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 3
            })
        );
    }

    #[test]
    fn resolves_inner_python_block() {
        // Point at the `for` loop inside the function body. The suite's first
        // statement is `total = 0` (line 2), so the `for` at line 3 is not the
        // suite's first child and climbs only to the `for_statement`, not the
        // whole function suite.
        let code =
            "def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
        assert_eq!(
            resolve(code, "f.py", 3),
            Some(BlockRange {
                start_line: 3,
                end_line: 4
            })
        );
    }

    #[test]
    fn go_leading_statement_excludes_following_siblings() {
        // tree-sitter-go wraps a block body in a `statement_list` that begins
        // exactly at its first statement; the leading `if` must not resolve to
        // the whole list and swallow the statements after it.
        let code = "package p\n\nfunc f() error {\n\tif err := step(); err != nil {\n\t\treturn \
		            err\n\t}\n\tother()\n\treturn nil\n}\n";
        assert_eq!(
            resolve(code, "x.go", 4),
            Some(BlockRange {
                start_line: 4,
                end_line: 6
            })
        );
        assert_eq!(
            resolve(code, "x.go", 3),
            Some(BlockRange {
                start_line: 3,
                end_line: 9
            })
        );
    }

    #[test]
    fn python_leading_statement_excludes_following_siblings() {
        let code = "def f(x):\n    if x:\n        return 1\n    y = 2\n    return y\n";
        assert_eq!(
            resolve(code, "f.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 3
            })
        );
    }

    #[test]
    fn leading_statement_with_trailing_comment_excludes_following_siblings() {
        // A comment on the statement's last row is a named sibling; it must not
        // hide the next statement and let the climb swallow the whole body.
        let go = "package p\n\nfunc f() error {\n\tif err := step(); err != nil {\n\t\treturn \
		          err\n\t} // note\n\tother()\n\treturn nil\n}\n";
        assert_eq!(
            resolve(go, "x.go", 4),
            Some(BlockRange {
                start_line: 4,
                end_line: 6
            })
        );
        let py = "def f(x):\n    y = 2  # note\n    z = 3\n    return y\n";
        assert_eq!(
            resolve(py, "f.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 2
            })
        );
    }

    #[test]
    fn leading_statement_with_dedented_comment_excludes_following_siblings() {
        // A comment-only line at a different column is still an extra between
        // statements; it must not hide the next statement and let the climb
        // swallow the whole body.
        let code = "def f(x):\n    y = 2\n# dedented\n    z = 3\n    return y\n";
        assert_eq!(
            resolve(code, "f.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 2
            })
        );
    }

    // Only comments follow the body's last statement: the container adds
    // nothing but those comments, so they must stay outside the block.
    #[test]
    fn python_last_statement_with_trailing_comments_excludes_them() {
        let one = "def f(x):\n    y = 2\n    # trailing\n";
        assert_eq!(
            resolve(one, "f.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 2
            })
        );
        let two = "def f(x):\n    y = 2\n    # one\n    # two\n";
        assert_eq!(
            resolve(two, "f.py", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 2
            })
        );
    }

    #[test]
    fn omitted_ruby_parser_returns_no_syntax_block() {
        let code = "def f\n  x = 1\n  # c\nend\n";
        assert_eq!(resolve(code, "f.rb", 2), None);
    }

    #[test]
    fn yaml_last_entry_with_trailing_comment_excludes_it() {
        let top = "a: 1\n# c\n";
        assert_eq!(
            resolve(top, "c.yml", 1),
            Some(BlockRange {
                start_line: 1,
                end_line: 1
            })
        );
        let nested = "jobs:\n  build: 1\n  # c\nother: 2\n";
        assert_eq!(
            resolve(nested, "c.yml", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 2
            })
        );
    }

    #[test]
    fn yaml_first_top_level_key_resolves_only_its_entry() {
        let code = "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  build: {}\n";
        assert_eq!(
            resolve(code, "ci.yml", 1),
            Some(BlockRange {
                start_line: 1,
                end_line: 1
            })
        );
        assert_eq!(
            resolve(code, "ci.yml", 3),
            Some(BlockRange {
                start_line: 3,
                end_line: 4
            })
        );
    }

    #[test]
    fn java_stacked_annotations_still_resolve_the_declaration() {
        // One annotation per line forms a `modifiers` run that also begins at
        // its first child; unlike a statement list it must be climbed through.
        let code = "class A {\n  @Override\n  @Deprecated\n  public void f() {\n    g();\n  }\n}\n";
        assert_eq!(
            resolve(code, "A.java", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 6
            })
        );
    }

    #[test]
    fn resolves_nested_block_to_outermost_on_line() {
        // Point at the inner `if` line; it resolves the whole `if` block
        // (header through its closing brace), not just the call inside it.
        let code = "function f() {\n  if (a) {\n    g();\n  }\n}\n";
        assert_eq!(
            resolve(code, "f.ts", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 4
            })
        );
    }

    #[test]
    fn multi_statement_line_resolves_first_statement_node() {
        // `let a = 1; let b = 2;` — pointing at the line resolves the first
        // statement that begins at the line's first content column.
        let code = "let a = 1; let b = 2;\n";
        let range = resolve(code, "m.ts", 1);
        assert!(
            range.is_some(),
            "expected a block on a single-statement-bearing line"
        );
        assert_eq!(range.unwrap().start_line, 1);
    }

    #[test]
    fn continuation_line_resolves_to_nothing() {
        // A bare argument-continuation line whose first content does not open a
        // new named node beginning on that row.
        let code = "foo(\n  a,\n  b,\n);\n";
        // Line 2 (`  a,`) is an argument — `a` is an identifier beginning on the
        // row, so it DOES resolve. Use the closing `);` line instead, which is
        // a continuation/closer of the call begun earlier.
        assert_eq!(resolve(code, "c.ts", 4), None);
    }

    #[test]
    fn error_subtree_resolves_to_nothing() {
        // Missing closing brace: the function's subtree carries an ERROR, so we
        // refuse to resolve a degenerate recovery span.
        let code = "function broken() {\n  if (y) {\n}\n";
        assert_eq!(resolve(code, "b.ts", 1), None);
    }

    #[test]
    fn resolves_rust_struct_block() {
        let code = "struct A;\nstruct B {\n    x: u32,\n}\n";
        assert_eq!(
            resolve(code, "r.rs", 2),
            Some(BlockRange {
                start_line: 2,
                end_line: 4
            })
        );
    }

    #[test]
    fn omitted_parsers_return_no_syntax_block() {
        for (path, code) in [
            ("g.swift", "func greet() {\n    print(\"hi\")\n}\n"),
            ("init.el", "(defun greet ()\n  (message \"hi\"))\n"),
            (".emacs", "(let ((value 1))\n  value)\n"),
        ] {
            assert_eq!(resolve(code, path, 1), None, "{path}");
            assert_eq!(boundaries(code, path, &[(1, 1)]), None, "{path}");
        }
        assert_eq!(
            block_range_at(BlockRangeOptions {
                code: "(defun greet () t)".to_owned(),
                lang: Some("emacs-lisp".to_owned()),
                path: None,
                line: 1,
            })
            .unwrap(),
            None
        );
    }

    fn boundaries(code: &str, path: &str, ranges: &[(u32, u32)]) -> Option<Vec<u32>> {
        enclosing_block_boundaries(EnclosingBoundaryOptions {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            ranges: ranges
                .iter()
                .map(|&(start_line, end_line)| LineRange {
                    start_line,
                    end_line,
                })
                .collect(),
        })
        .expect("boundary resolution succeeds")
    }

    const TS_FN: &str = "function outer() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  \
	                     return a + b + c;\n}\nafter();\n";

    #[test]
    fn surfaces_closing_brace_for_visible_opener() {
        // Window is the opening line only; its block closes on line 6.
        assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), Some(vec![6]));
    }

    #[test]
    fn surfaces_opening_brace_for_visible_closer() {
        // Window is the closing line only; its block opens on line 1.
        assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
    }

    #[test]
    fn interior_only_window_adds_no_boundary() {
        // Neither the opener (1) nor the closer (6) is visible, so the bracket
        // scan would add nothing — and neither do we.
        assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
    }

    #[test]
    fn whole_file_window_adds_no_boundary() {
        assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 7)]), Some(vec![]));
    }

    #[test]
    fn python_indentation_block_uses_syntactic_span() {
        // Python has no closing delimiter — the def's span ends at the last
        // body line. Showing the `def` header surfaces that end line.
        let code = "def greet(name):\n    a = 1\n    b = 2\n    return a + b\n";
        assert_eq!(boundaries(code, "g.py", &[(1, 1)]), Some(vec![4]));
    }

    #[test]
    fn syntax_error_falls_back_to_none() {
        let code = "function broken() {\n  if (y) {\n";
        assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None);
    }

    #[test]
    fn unrecognized_language_falls_back_to_none() {
        assert_eq!(boundaries(TS_FN, "x.unknownext", &[(1, 1)]), None);
    }

    const MD_DOC: &str = "# H1\nintro\n\n## H2 alpha\nbody a\nmore a\n\n### H3 deep\ndeep \
	                      body\n\n## H2 beta\nbody b\n";

    #[test]
    fn omitted_markdown_parser_does_not_expand_sections() {
        for line in [1, 4, 8] {
            assert_eq!(resolve(MD_DOC, "plan.md", line), None);
        }
    }

    #[test]
    fn markdown_blank_line_resolves_to_nothing() {
        // A blank separator line opens no section.
        assert_eq!(resolve(MD_DOC, "plan.md", 3), None);
    }

    // ── parse cache ───────────────────────────────────────────────────────────
    //
    // These cover the process-global cache end to end. The cache is shared with
    // the rest of this crate's suite running in parallel, so nothing here
    // asserts on occupancy or counters — only on boundary values, which must
    // come out identical no matter what else happens to be resident. Occupancy,
    // eviction, and LRU order are asserted deterministically on private `Cache`
    // instances in `parse_cache::tests`.

    use crate::ast::parse_cache::clear_parse_cache;

    #[test]
    fn repeat_query_yields_identical_boundaries() {
        clear_parse_cache();
        let first = boundaries(TS_FN, "x.ts", &[(1, 1)]);
        let second = boundaries(TS_FN, "x.ts", &[(1, 1)]);

        assert_eq!(first, Some(vec![6]));
        assert_eq!(
            second, first,
            "identical input must yield identical boundaries"
        );

        // A different window over the same bytes must still be answered per
        // window: the cache holds the tree, not the boundary list, which is why
        // a result cache would not have worked.
        assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
        assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
        assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), first);
    }

    #[test]
    fn same_bytes_under_two_languages_do_not_share_a_tree() {
        // Valid Python, a syntax error as TypeScript. If the language were not
        // part of the cache key, whichever call ran first would answer for both.
        let code = "def greet(name):\n    a = 1\n    return a\n";

        clear_parse_cache();
        let py_cold = boundaries(code, "x.py", &[(1, 1)]);
        clear_parse_cache();
        let ts_cold = boundaries(code, "x.ts", &[(1, 1)]);
        assert_eq!(py_cold, Some(vec![3]));
        assert_eq!(ts_cold, None);

        clear_parse_cache();
        assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
        assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);

        // Reverse order, to rule out an order-dependent answer.
        clear_parse_cache();
        assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);
        assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
    }

    #[test]
    fn single_byte_difference_yields_different_boundaries() {
        // Equal length, one byte apart: the second form replaces the newline
        // after `a()` with `;`, folding four lines into three. The `len` field in
        // the cache key cannot separate these — only the content hash and the
        // verified byte comparison can.
        let four_lines = "function f() {\n  a()\n  b()\n}\n";
        let three_lines = "function f() {\n  a();  b()\n}\n";
        assert_eq!(
            four_lines.len(),
            three_lines.len(),
            "fixtures must be equal length"
        );
        assert_eq!(
            four_lines
                .bytes()
                .zip(three_lines.bytes())
                .filter(|(a, b)| a != b)
                .count(),
            1,
            "fixtures must differ by exactly one byte"
        );

        clear_parse_cache();
        assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
        assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
        // Again with both resident, in the opposite order.
        assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
        assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
    }

    #[test]
    fn syntax_error_stays_none_across_repeat_calls() {
        // The error tree *is* cached, so repeated "does this parse" probes get
        // the speedup too; `None` comes from the caller's own `has_error()` check
        // reading that tree, not from refusing to cache it.
        let code = "function broken() {\n  if (y) {\n";
        clear_parse_cache();
        assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "first call");
        assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "second call");
        assert_eq!(
            boundaries(code, "b.ts", &[(1, 2)]),
            None,
            "different window, still none"
        );
    }

    #[test]
    fn cached_error_tree_matches_uncached_verdicts_for_both_callers() {
        // `enclosing_block_boundaries` rejects any file-level error;
        // `block_range_at` rejects only errors inside the resolved subtree. Both
        // now read that verdict off one shared cached tree, so each must still
        // reach the answer it reached from its own cold parse.
        let code = "function ok() {\n  a();\n}\nfunction broken( {\n";

        clear_parse_cache();
        let cold_boundaries = boundaries(code, "x.ts", &[(1, 1)]);
        clear_parse_cache();
        let cold_range = resolve(code, "x.ts", 1);
        assert_eq!(
            cold_boundaries, None,
            "a file-level error disables boundaries"
        );

        clear_parse_cache();
        for pass in 0..2 {
            assert_eq!(
                boundaries(code, "x.ts", &[(1, 1)]),
                cold_boundaries,
                "pass {pass}"
            );
            assert_eq!(resolve(code, "x.ts", 1), cold_range, "pass {pass}");
        }
    }
}
