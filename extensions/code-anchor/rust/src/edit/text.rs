//! Text encoding rules for the pinned hashline protocol.

use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

impl LineEnding {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
        }
    }
}

pub fn detect_line_ending(content: &str) -> LineEnding {
    let Some(lf) = content.find('\n') else {
        return LineEnding::Lf;
    };
    match content.find("\r\n") {
        Some(crlf) if crlf < lf => LineEnding::CrLf,
        _ => LineEnding::Lf,
    }
}

pub fn normalize_to_lf(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
}

pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::Lf => text.to_owned(),
        LineEnding::CrLf => text.replace('\n', "\r\n"),
    }
}

pub const BOM: &str = "\u{FEFF}";

pub fn strip_bom(content: &str) -> (&'static str, &str) {
    content
        .strip_prefix(BOM)
        .map_or(("", content), |rest| (BOM, rest))
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_crlf_and_lone_cr_without_changing_unicode() {
        assert_eq!(normalize_to_lf("a\r\nb\rc\n"), "a\nb\nc\n");
        assert_eq!(normalize_to_lf("\r\r\n界\r"), "\n\n界\n");
        assert!(matches!(normalize_to_lf("a\n"), Cow::Borrowed(_)));
    }

    #[test]
    fn preserves_bom_and_original_line_ending_policy() {
        let (bom, body) = strip_bom("\u{FEFF}a\r\n");
        assert_eq!(bom, BOM);
        assert_eq!(detect_line_ending(body), LineEnding::CrLf);
        assert_eq!(
            restore_line_endings(&normalize_to_lf(body), LineEnding::CrLf),
            body
        );
    }

    #[test]
    fn counts_javascript_utf16_units() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_len(&format!("{}😀", "a".repeat(64))), 66);
    }
}
