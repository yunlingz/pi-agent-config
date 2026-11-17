use std::{borrow::Cow, path::Path, sync::LazyLock};

use ast_grep_core::{
    Language, Pattern, PatternError,
    matcher::PatternBuilder,
    meta_var::MetaVariable,
    tree_sitter::{LanguageExt, StrDoc, TSLanguage},
};
use serde::Deserialize;

include!(concat!(env!("OUT_DIR"), "/linked_languages.rs"));

#[derive(Deserialize)]
struct Manifest {
    grammars: Vec<Grammar>,
}

#[derive(Deserialize)]
pub struct Grammar {
    pub name: String,
    pub aliases: Vec<String>,
    pub extensions: Vec<String>,
    pub expando: char,
}

pub static GRAMMARS: LazyLock<Vec<Grammar>> = LazyLock::new(|| {
    serde_json::from_str::<Manifest>(include_str!("../../grammars.json"))
        .expect("The packaged grammar manifest must be valid")
        .grammars
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum CodeLanguage {
    Bash,
    C,
    Cmake,
    Cpp,
    CSharp,
    Css,
    Dockerfile,
    Go,
    Html,
    Java,
    JavaScript,
    Json,
    Lua,
    Make,
    Powershell,
    Python,
    Rust,
    Toml,
    Tsx,
    TypeScript,
    Yaml,
    Zig,
}

pub type SupportLang = CodeLanguage;

pub const ALL_LANGUAGES: &[CodeLanguage] = &[
    CodeLanguage::Bash,
    CodeLanguage::C,
    CodeLanguage::Cmake,
    CodeLanguage::Cpp,
    CodeLanguage::CSharp,
    CodeLanguage::Css,
    CodeLanguage::Dockerfile,
    CodeLanguage::Go,
    CodeLanguage::Html,
    CodeLanguage::Java,
    CodeLanguage::JavaScript,
    CodeLanguage::Json,
    CodeLanguage::Lua,
    CodeLanguage::Make,
    CodeLanguage::Powershell,
    CodeLanguage::Python,
    CodeLanguage::Rust,
    CodeLanguage::Toml,
    CodeLanguage::Tsx,
    CodeLanguage::TypeScript,
    CodeLanguage::Yaml,
    CodeLanguage::Zig,
];

impl std::fmt::Display for CodeLanguage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

pub mod grammar;

impl CodeLanguage {
    pub fn sorted_aliases() -> Vec<&'static str> {
        let mut aliases: Vec<_> = GRAMMARS
            .iter()
            .flat_map(|grammar| grammar.aliases.iter().map(String::as_str))
            .collect();
        aliases.sort_unstable();
        aliases.dedup();
        aliases
    }

    pub fn from_alias(alias: &str) -> Option<Self> {
        let lowered = alias.trim().to_ascii_lowercase();
        GRAMMARS
            .iter()
            .position(|grammar| grammar.aliases.iter().any(|value| *value == lowered))
            .map(|index| ALL_LANGUAGES[index])
    }

    pub fn name(self) -> &'static str {
        &GRAMMARS[self as usize].name
    }

    pub fn canonical_name(self) -> &'static str {
        self.name()
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        Self::from_filename(path)
    }

    pub fn from_filename(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_str()?;
        let named = match name {
            "Makefile" | "makefile" | "GNUmakefile" => Some("make"),
            "CMakeLists.txt" => Some("cmake"),
            "Dockerfile" | "dockerfile" | "Containerfile" | "containerfile" => Some("dockerfile"),
            _ if name.starts_with("Dockerfile.") || name.starts_with("dockerfile.") => {
                Some("dockerfile")
            }
            _ => None,
        };
        if let Some(named) = named {
            return Self::from_alias(named);
        }
        let shell_name = name.strip_prefix('.').unwrap_or(name);
        if matches!(
            shell_name,
            "zshrc"
                | "zshenv"
                | "zprofile"
                | "zlogin"
                | "zlogout"
                | "zsh_aliases"
                | "bashrc"
                | "bash_profile"
                | "bash_login"
                | "bash_logout"
                | "bash_aliases"
                | "profile"
                | "kshrc"
                | "mkshrc"
                | "shrc"
        ) {
            return Self::from_alias("bash");
        }
        let extension = path.extension()?.to_str()?;
        if extension == "C" || extension == "H" {
            return Self::from_alias("cpp");
        }
        GRAMMARS
            .iter()
            .position(|grammar| {
                grammar
                    .extensions
                    .iter()
                    .any(|known| known.eq_ignore_ascii_case(extension))
            })
            .map(|index| ALL_LANGUAGES[index])
    }
}

impl Language for CodeLanguage {
    fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
        let expando = self.expando_char();
        if expando == '$' {
            return Cow::Borrowed(query);
        }
        // Preserve the reference language rules for single and variadic captures.
        let mut output = String::with_capacity(query.len());
        let mut dollars = 0;
        for character in query.chars() {
            if character == '$' {
                dollars += 1;
                continue;
            }
            let replace = matches!(character, 'A'..='Z' | '_') || dollars == 3;
            output.extend(std::iter::repeat_n(
                if replace { expando } else { '$' },
                dollars,
            ));
            dollars = 0;
            output.push(character);
        }
        output.extend(std::iter::repeat_n(
            if dollars == 3 { expando } else { '$' },
            dollars,
        ));
        Cow::Owned(output)
    }

    fn expando_char(&self) -> char {
        GRAMMARS[*self as usize].expando
    }

    fn extract_meta_var(&self, source: &str) -> Option<MetaVariable> {
        // JSON and TOML represent a quoted placeholder as one string node.
        let source = if matches!(self, Self::Json | Self::Toml) {
            source
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(source)
        } else {
            source
        };
        let expando = self.expando_char();
        let ellipsis: String = std::iter::repeat_n(expando, 3).collect();
        let valid = |character: char| matches!(character, 'A'..='Z' | '_' | '0'..='9');
        if let Some(name) = source.strip_prefix(&ellipsis) {
            if !name.chars().all(valid) {
                return None;
            }
            return Some(if name.is_empty() || name.starts_with('_') {
                MetaVariable::Multiple
            } else {
                MetaVariable::MultiCapture(name.to_owned())
            });
        }
        let name = source.strip_prefix(expando)?;
        let (name, named) = name
            .strip_prefix(expando)
            .map_or((name, true), |name| (name, false));
        if !name.starts_with(|character| matches!(character, 'A'..='Z' | '_'))
            || !name.chars().all(valid)
        {
            return None;
        }
        Some(if name.starts_with('_') {
            MetaVariable::Dropped(named)
        } else {
            MetaVariable::Capture(name.to_owned(), named)
        })
    }

    fn kind_to_id(&self, kind: &str) -> u16 {
        self.get_ts_language().id_for_node_kind(kind, true)
    }

    fn field_to_id(&self, field: &str) -> Option<u16> {
        self.get_ts_language()
            .field_id_for_name(field)
            .map(|id| id.get())
    }

    fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
        builder.build(|source| StrDoc::try_new(source, *self))
    }

    fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
        Self::from_filename(path.as_ref())
    }
}

impl LanguageExt for CodeLanguage {
    fn get_ts_language(&self) -> TSLanguage {
        linked_language(self.name()).expect("Every packaged language must have a linked grammar")
    }
}
