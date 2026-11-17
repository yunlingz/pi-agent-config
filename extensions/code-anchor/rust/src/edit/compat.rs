pub trait StripPair {
    fn strip_pair<P: ToString>(&self, prefix: P, suffix: P) -> Option<&str>;
}

impl StripPair for str {
    fn strip_pair<P: ToString>(&self, prefix: P, suffix: P) -> Option<&str> {
        self.strip_prefix(&prefix.to_string())?
            .strip_suffix(&suffix.to_string())
    }
}
