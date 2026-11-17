use crate::edit::engine::{EditMode, ModeEngine};

pub mod hashline;

pub fn engine_for(
    mode: EditMode,
    _allow_fuzzy: bool,
    _fuzzy_threshold: f64,
    enforce_seen_lines: bool,
    max_columns: usize,
) -> Box<dyn ModeEngine> {
    assert_eq!(
        mode,
        EditMode::Hashline,
        "CodeAnchor provides hashline only"
    );
    Box::new(hashline::HashlineEngine {
        enforce_seen_lines,
        max_columns,
    })
}

pub(crate) fn added_lines<'a>(rows: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut output = None::<String>;
    for line in rows {
        let Some(added) = line.strip_prefix('+') else {
            continue;
        };
        if line.starts_with("+++ ") {
            continue;
        }
        if let Some(output) = &mut output {
            output.push('\n');
            output.push_str(added);
        } else {
            output = Some(added.to_owned());
        }
    }
    output
}
