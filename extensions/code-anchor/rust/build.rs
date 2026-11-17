use std::{collections::BTreeMap, env, fs, path::PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
struct GrammarSource {
    name: String,
    package: String,
    symbol: String,
    parser: PathBuf,
    scanner: Option<PathBuf>,
    include: Vec<PathBuf>,
}

fn main() {
    let bare_wasm = env::var("TARGET").as_deref() == Ok("wasm32-unknown-unknown");
    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo did not provide the target OS");
    let release = env::var("PROFILE").as_deref() == Ok("release");
    let platform = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("platform");
    if bare_wasm {
        let mut compiler = cc::Build::new();
        compiler
            .include(platform.join("include"))
            .include(&platform)
            .std("c11")
            .opt_level_str("s")
            .warnings(false)
            .file(platform.join("libc.c"))
            .file(platform.join("host.c"))
            .file(platform.join("printf/printf.c"))
            .compile("code_anchor_platform");
    }
    if release && target_os == "windows" {
        println!("cargo:rustc-cdylib-link-arg=/OPT:REF");
        println!("cargo:rustc-cdylib-link-arg=/OPT:ICF");
    }
    println!("cargo:rerun-if-env-changed=CODE_ANCHOR_GRAMMAR_SOURCES");
    let manifest = env::var_os("CODE_ANCHOR_GRAMMAR_SOURCES")
        .expect("Run the CodeAnchor build script to provide verified grammar sources");
    println!(
        "cargo:rerun-if-changed={}",
        PathBuf::from(&manifest).display()
    );
    let sources: Vec<GrammarSource> = serde_json::from_slice(
        &fs::read(manifest).expect("Cannot read the grammar source manifest"),
    )
    .expect("Invalid grammar source manifest");
    assert!(!sources.is_empty(), "No grammar sources supplied");

    let mut packages: BTreeMap<&str, Vec<&GrammarSource>> = BTreeMap::new();
    for source in &sources {
        packages.entry(&source.package).or_default().push(source);
    }
    for (name, grammars) in packages {
        let mut files = BTreeMap::new();
        let mut includes = Vec::new();
        for grammar in grammars {
            files.insert(grammar.parser.clone(), false);
            if let Some(scanner) = &grammar.scanner {
                let cpp = scanner.extension().is_some_and(|ext| ext != "c");
                files.insert(scanner.clone(), cpp);
            }
            includes.extend(grammar.include.iter().cloned());
        }
        includes.sort();
        includes.dedup();
        for cpp in [false, true] {
            let files: Vec<_> = files.iter().filter(|(_, is_cpp)| **is_cpp == cpp).collect();
            if files.is_empty() {
                continue;
            }
            let mut compiler = cc::Build::new();
            compiler.includes(&includes).warnings(false);
            if bare_wasm {
                compiler.include(platform.join("include"));
            }
            if release {
                compiler.opt_level_str("s").debug(false);
                if compiler.get_compiler().is_like_msvc() {
                    compiler.flag("/Gw").flag("/Gy");
                }
            }
            if cpp {
                compiler
                    .cpp(true)
                    .std("c++17")
                    .flag_if_supported("-fno-exceptions");
                if target_os == "linux" {
                    compiler
                        .cpp_link_stdlib("stdc++")
                        .cpp_link_stdlib_static(true);
                }
            } else {
                compiler.std("c11");
            }
            for (file, _) in files {
                println!("cargo:rerun-if-changed={}", file.display());
                compiler.file(file);
            }
            compiler.compile(&format!(
                "code_anchor_{}_{}",
                name.replace('-', "_"),
                if cpp { "cpp" } else { "c" }
            ));
        }
    }

    let mut generated = String::new();
    generated.push_str("unsafe extern \"C\" {\n");
    for source in &sources {
        generated.push_str(&format!(
            "    fn tree_sitter_{}() -> *const ();\n",
            source.symbol
        ));
    }
    generated.push_str("}\n\npub fn linked_language(name: &str) -> Option<tree_sitter::Language> {\n    let constructor = match name {\n");
    for source in &sources {
        generated.push_str(&format!(
            "        {:?} => tree_sitter_{},\n",
            source.name, source.symbol
        ));
    }
    generated.push_str("        _ => return None,\n    };\n    // Each constructor comes from the verified Tree-sitter grammar sources compiled above.\n    Some(unsafe { tree_sitter_language::LanguageFn::from_raw(constructor) }.into())\n}\n");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo did not provide OUT_DIR"));
    fs::write(output.join("linked_languages.rs"), generated)
        .expect("Cannot write linked grammar table");
}
