//! Reference-compatible similarity for stale-anchor recovery.

fn levenshtein_slices<T: PartialEq>(a: &[T], b: &[T]) -> usize {
    if a == b {
        return 0;
    }
    let mut start = 0;
    let shared_limit = a.len().min(b.len());
    while start < shared_limit && a[start] == b[start] {
        start += 1;
    }
    let mut a_end = a.len();
    let mut b_end = b.len();
    while a_end > start && b_end > start && a[a_end - 1] == b[b_end - 1] {
        a_end -= 1;
        b_end -= 1;
    }
    let mut longer = &a[start..a_end];
    let mut shorter = &b[start..b_end];
    if longer.is_empty() {
        return shorter.len();
    }
    if shorter.is_empty() {
        return longer.len();
    }
    if shorter.len() > longer.len() {
        std::mem::swap(&mut longer, &mut shorter);
    }

    let mut row: Vec<usize> = (0..=shorter.len()).collect();
    for (line, a_elem) in longer.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = line + 1;
        for (column, b_elem) in shorter.iter().enumerate() {
            let cell = column + 1;
            let above = row[cell];
            row[cell] = if a_elem == b_elem {
                diagonal
            } else {
                (above + 1).min(row[cell - 1] + 1).min(diagonal + 1)
            };
            diagonal = above;
        }
    }
    row[shorter.len()]
}

pub fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a.is_ascii() && b.is_ascii() {
        let max_len = a.len().max(b.len());
        let dist = levenshtein_slices(a.as_bytes(), b.as_bytes());
        return 1.0 - dist as f64 / max_len as f64;
    }
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let max_len = a_chars.len().max(b_chars.len());
    1.0 - levenshtein_slices(&a_chars, &b_chars) as f64 / max_len as f64
}
