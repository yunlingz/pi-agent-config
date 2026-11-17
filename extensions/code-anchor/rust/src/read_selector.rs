//! Local text selectors from the pinned OMP read contract.

use regex::Regex;
use std::sync::LazyLock;

static CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$").unwrap());

#[derive(Debug, Clone)]
pub struct Range {
    pub start: usize,
    pub end: Option<usize>,
    pub tail: bool,
}
#[derive(Debug, Default)]
pub struct Selector {
    pub raw: bool,
    pub ranges: Vec<Range>,
}

fn integer(value: &str) -> Result<usize, String> {
    let number: usize = value
        .parse()
        .map_err(|_| "Line selector is too large".to_owned())?;
    if number == 0 {
        return Err("Line selector 0 is invalid; lines are 1-indexed. Use :1.".to_owned());
    }
    if number > u32::MAX as usize {
        return Err("Line selector exceeds the supported line range".to_owned());
    }
    Ok(number)
}

pub fn parse(value: &str) -> Result<Option<Selector>, String> {
    let chunks: Vec<_> = value.split(':').collect();
    let raw = chunks.iter().any(|chunk| chunk.eq_ignore_ascii_case("raw"));
    if chunks.len() > 2 || (chunks.len() == 2 && !raw) {
        return Ok(None);
    }
    let ranges: Vec<_> = chunks
        .into_iter()
        .filter(|chunk| !chunk.eq_ignore_ascii_case("raw"))
        .collect();
    if ranges.is_empty() {
        return Ok(Some(Selector {
            raw,
            ranges: Vec::new(),
        }));
    }
    let chunks: Vec<_> = ranges[0].split(',').collect();
    let pin = raw || chunks.len() > 1;
    let mut selector = Selector {
        raw,
        ranges: Vec::new(),
    };
    for chunk in chunks {
        if let Some(tail) = chunk.strip_prefix('-') {
            if tail.bytes().all(|byte| byte.is_ascii_digit()) && !tail.is_empty() {
                selector.ranges.push(Range {
                    start: integer(tail)?,
                    end: None,
                    tail: true,
                });
                continue;
            }
        }
        let Some(matched) = CHUNK.captures(chunk) else {
            return Ok(None);
        };
        let start = integer(&matched[1])?;
        let rhs = matched
            .get(3)
            .map(|value| integer(value.as_str()))
            .transpose()?;
        let end = match matched.get(2).map(|value| value.as_str()) {
            Some("+") => Some(
                start
                    .checked_add(
                        rhs.ok_or_else(|| format!("Invalid range {start}+0: count must be >= 1."))?
                            - 1,
                    )
                    .ok_or("Line range overflow")?,
            ),
            Some(_) => rhs,
            None if pin => Some(start),
            None => None,
        };
        if end.is_some_and(|end| end < start) {
            return Err(format!(
                "Invalid range {start}-{}: end must be >= start.",
                end.unwrap()
            ));
        }
        selector.ranges.push(Range {
            start,
            end,
            tail: false,
        });
    }
    Ok(Some(selector))
}

pub fn split_target(target: &str) -> Result<(&str, Option<&str>), String> {
    // Prefer a complete compound selector before its final raw/range component.
    let positions: Vec<_> = target.match_indices(':').map(|(index, _)| index).collect();
    for index in positions {
        let suffix = &target[index + 1..];
        if parse(suffix)?.is_some() && index > 0 {
            return Ok((&target[..index], Some(suffix)));
        }
    }
    Ok((target, None))
}

impl Selector {
    pub fn resolved(&self, total: usize) -> Vec<(usize, usize)> {
        let mut ranges: Vec<_> = self
            .ranges
            .iter()
            .map(|range| {
                if range.tail {
                    (
                        total.saturating_sub(range.start).saturating_add(1).max(1),
                        total.max(1),
                    )
                } else {
                    (range.start, range.end.unwrap_or(total.max(range.start)))
                }
            })
            .collect();
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in ranges {
            if let Some(previous) = merged.last_mut() {
                if start <= previous.1.saturating_add(1) {
                    previous.1 = previous.1.max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        merged
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_tails_compounds_and_windows_drives_follow_the_reference_rules() {
        for (value, expected) in [
            ("2-4", vec![(2, 4)]),
            ("2+3", vec![(2, 4)]),
            ("2", vec![(2, 10)]),
            ("2,7", vec![(2, 2), (7, 7)]),
            ("-3", vec![(8, 10)]),
            ("1-2,-2", vec![(1, 2), (9, 10)]),
            ("raw:2", vec![(2, 2)]),
            ("2-:raw", vec![(2, 10)]),
        ] {
            assert_eq!(
                parse(value).unwrap().unwrap().resolved(10),
                expected,
                "{value}"
            );
        }
        assert_eq!(
            split_target("C:/path/file.ts:raw:2-4").unwrap(),
            ("C:/path/file.ts", Some("raw:2-4"))
        );
        assert!(parse("0").is_err());
        assert!(parse("5-2").is_err());
        assert!(parse("2+0").is_err());
    }
}
