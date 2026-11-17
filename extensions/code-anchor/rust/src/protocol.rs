use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Languages,
    Parse {
        language: String,
        source: String,
    },
    Find {
        language: String,
        source: String,
        pattern: String,
    },
    Rewrite {
        language: String,
        source: String,
        operations: Vec<RewriteOperation>,
    },
    ContentTag {
        source: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RewriteOperation {
    pub pattern: String,
    pub replacement: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Languages {
        languages: Vec<String>,
    },
    Parse {
        language: String,
        root: String,
        has_error: bool,
    },
    Matches {
        matches: Vec<Match>,
        warnings: Vec<String>,
    },
    Rewrite {
        content: String,
        changes: usize,
        warnings: Vec<String>,
    },
    ContentTag {
        tag: String,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize)]
pub struct Match {
    pub text: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub captures: std::collections::BTreeMap<String, String>,
}
