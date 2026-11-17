use anyhow::Result;
use tree_sitter::{Language, Parser, Tree};

use super::CodeLanguage;
use ast_grep_core::tree_sitter::LanguageExt;

pub trait LanguageGrammar {
    fn grammar(&self) -> NativeGrammar;
}

pub struct NativeGrammar(CodeLanguage);

#[derive(Debug, thiserror::Error)]
pub enum GrammarError {
    #[error("the {language} grammar is not installed")]
    NotInstalled { language: &'static str },
    #[error("the {language} grammar is invalid: {reason}")]
    Invalid {
        language: &'static str,
        reason: String,
    },
}

impl NativeGrammar {
    pub fn load(self) -> Result<Language, GrammarError> {
        Ok(self.0.get_ts_language())
    }
}

impl LanguageGrammar for CodeLanguage {
    fn grammar(&self) -> NativeGrammar {
        NativeGrammar(*self)
    }
}

pub fn parse(language: &Language, source: &str, old_tree: Option<&Tree>) -> Result<Option<Tree>> {
    let mut parser = Parser::new();
    parser.set_language(language)?;
    Ok(parser.parse(source, old_tree))
}
