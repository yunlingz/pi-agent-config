//! Hashline rendering of structural summaries from the pinned OMP read implementation.

use crate::ast::summary::{SummaryOptions, summarize_code};

enum Unit {
    Line(u32, String),
    Elided(u32, u32),
    Merged(u32, u32, String, String),
}

fn brace_pair(head: &str, tail: &str) -> bool {
    let close = match head.trim_end().chars().last() {
        Some('{') => '}',
        Some('(') => ')',
        Some('[') => ']',
        _ => return false,
    };
    let mut tail = tail.trim().chars();
    tail.next() == Some(close)
        && tail.all(|character| matches!(character, ';' | ',' | ')' | ']' | '}'))
}

pub fn render(source: &str, path: &str, display: &str) -> Option<(String, Vec<u32>)> {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "txt" | "md" | "markdown" | "mdx")
        || source.len() > 2 * 1024 * 1024
    {
        return None;
    }
    let total = source.split_terminator('\n').count();
    if !(100..=20_000).contains(&total) {
        return None;
    }
    let summary = summarize_code(SummaryOptions {
        code: source.to_owned(),
        path: Some(path.to_owned()),
        lang: None,
        min_body_lines: Some(4),
        min_comment_lines: Some(6),
        unfold_until_lines: Some(50),
        unfold_limit_lines: Some(100),
    })
    .ok()?;
    if !summary.parsed || !summary.elided {
        return None;
    }
    let mut raw = Vec::new();
    for segment in summary.segments {
        if segment.kind == "elided" {
            raw.push(Unit::Elided(segment.start_line, segment.end_line));
        } else if let Some(text) = segment.text.filter(|text| !text.is_empty()) {
            for (index, line) in text.split('\n').enumerate() {
                raw.push(Unit::Line(
                    segment.start_line + index as u32,
                    line.to_owned(),
                ));
            }
        }
    }
    let mut units = Vec::new();
    let mut iter = raw.into_iter().peekable();
    while let Some(unit) = iter.next() {
        if matches!(unit, Unit::Elided(..)) {
            if let (Some(Unit::Line(start, head)), Some(Unit::Line(end, tail))) =
                (units.last(), iter.peek())
            {
                if brace_pair(head, tail) {
                    let merged = Unit::Merged(*start, *end, head.clone(), tail.clone());
                    units.pop();
                    iter.next();
                    units.push(merged);
                    continue;
                }
            }
        }
        units.push(unit);
    }
    let mut rows = Vec::new();
    let mut seen = vec![0];
    let mut omitted = 0;
    let mut ranges = Vec::new();
    for unit in units {
        match unit {
            Unit::Line(number, text) => {
                rows.push(format!("{number}:{text}"));
                seen.push(number);
            }
            Unit::Elided(start, end) => {
                rows.push("…".to_owned());
                omitted += end - start + 1;
                ranges.push((start, end));
            }
            Unit::Merged(start, end, head, tail) => {
                rows.push(format!(
                    "{start}-{end}:{} … {}",
                    head.trim_end(),
                    tail.trim()
                ));
                seen.extend([start, end]);
                omitted += end.saturating_sub(start + 1);
                ranges.push((start, end));
            }
        }
    }
    let examples = ranges
        .iter()
        .take(2)
        .map(|(start, end)| format!("{start}-{end}"))
        .collect::<Vec<_>>()
        .join(",");
    let conjunction = if ranges.len() > 2 { ", e.g." } else { " with" };
    rows.push(format!(
        "\n[…{omitted}ln elided; re-read needed ranges{conjunction} {display}:{examples}]"
    ));
    let text = rows.join("\n");
    (text.len() <= 49 * 1024).then_some((text, seen))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folds_a_long_body_and_marks_only_the_displayed_boundaries_seen() {
        let source = format!(
            "function example() {{\n{}}}\n",
            "  console.log(value);\n".repeat(130)
        );
        let (text, seen) = render(&source, "example.ts", "example.ts").unwrap();
        assert!(text.contains("1-132:function example() { … }"));
        assert!(text.contains("example.ts:1-132"));
        assert!(seen.contains(&1) && seen.contains(&132) && !seen.contains(&2));
    }
}
