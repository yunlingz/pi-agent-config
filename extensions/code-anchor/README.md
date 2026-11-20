# CodeAnchor

CodeAnchor is a Pi extension with an owned Rust/WebAssembly core.
Its current local implementation meets the approved development checks and loads globally by default.
Publication remains a separate step.
It has no OMP package, native addon, WASI, or Wasmtime dependency at runtime.
The behavioral reference is pinned in `reference.json`.

## Required portability contract

One identical package must run on Linux, Windows, macOS, and WSL.
Every platform receives the same WASM bytes, TypeScript adapter, bundled parsers, and runtime resources.
There must be no platform-specific package, native binary selection, runtime download, or runtime compilation.
Platform differences belong in standard Node filesystem and path handling, not separate distributions.
Development acceptance requires verification on Windows and Linux under WSL, which are available on the current machine.
The support goal remains all four environments. Unavailable macOS and independent Linux checks do not block development acceptance.
Before claiming an environment is verified, test the same package there.
Verified coverage is reported below.
Normal WASM loading includes compilation by the JavaScript engine; no user-side Rust or C build is permitted.

## Current status

Pi automatically discovers the global `index.ts` entry point.
New sessions enable CodeAnchor by default; existing sessions load it after `/reload`.
The on/off command retains each active branch's preference across reloads.
Isolated integration and terminal checks use automatic discovery without an explicit CodeAnchor extension path.
The 22-grammar implementation passes 393 Rust tests on Windows.
The complete saved offline workflow passes on Windows and Linux under Debian WSL: 156 unit tests and six integrations each.
Strict TypeScript checks pass for maintained files under the shared configuration.
Seven isolated live workflows and real manual compaction pass on both environments with the configured model and reasoning level.
Each extended live run completed 12 actual tool calls; its 19 regular-request hooks exclude native compaction requests.
Actual Pi terminal tests pass on Windows ConPTY and a Linux pseudoterminal under WSL.
They cover keyboard commands, full-screen output, Powerline, reload, resize, tools, and graceful shutdown.
The identical artifact passes 33 focused tests on Windows and Debian WSL at Node.js 22.19.0.
The real Pi fixture integration also passes on both environments at that baseline.
Development acceptance is complete for the approved local-code scope and available environments.
macOS and independent Linux-host execution remain unverified because those hosts are unavailable here.
OMP-only application resource stores and complete OMP language coverage are outside the approved scope.
The current WASM contains 20,790,801 bytes with SHA-256 `78e70d9d30723b56e908df02c58c6dff3087d9e699e7660d81826aeb1d398ac6`.

## Runtime architecture

```text
Pi → TypeScript adapter → Node worker → Rust/WASM core
                                │
                             node:fs
                                │
                         Host filesystem
```

Node loads `wasm/code_anchor_core.wasm` with standard `WebAssembly.compile` and `WebAssembly.instantiate`.
The same artifact is intended for compatible Node runtimes on Linux, WSL, Windows, and macOS.
Windows and Debian WSL runtime checks have passed; macOS and independent Linux-host checks remain unverified.
Users do not need Rust, LLVM, parser downloads, native library packages, or OMP.
Pi, a compatible Node runtime, and normal supported OS facilities remain prerequisites.

Rust owns the 22 parsers, hashline snapshots, matching, rewrite plans, edit validation, result formatting, and write acknowledgement state.
The TypeScript host resolves paths, supplies file contents, acquires Pi's file locks, performs writes/moves/deletes, and acknowledges completed operations.
A CodeAnchor hook supplies read/modified-file metadata to Pi's compaction preparation.
It replaces selector and staged-resolution pseudo-paths with filesystem paths; installed Pi code stays unchanged.
It is a narrow interface, not a filesystem emulator or a WASI implementation.
The C compatibility layer has explicit clock and diagnostic-output imports only.
Source provenance for that layer is in `rust/platform/provenance.json`.

Parsing runs outside Pi's UI thread.
Cancelling read-only work can discard the worker and its snapshots; subsequent edits can require a new read.
Cancellation stops a mutation before its first host write when the cancellation message arrives in time.
Once the write batch starts, the adapter waits for it to finish before releasing file locks.
A trapped WASM instance is discarded instead of reused.
Edit responses are bounded before Rust records displayed anchors. Hidden rewritten rows require a new read before editing.
Partial write failures retain successful acknowledgements, stop later operations, and report failure without claiming rollback.
Host filesystem functions retain the user's real permissions; WASM does not make file writes automatically safe.

## Tools and controls

When on, CodeAnchor registers `hashline_read`, `hashline_edit`, `ast_grep`, and `ast_edit` as distinct tools.
It disables and blocks native `read` and `edit`, including calls through Pi's nested tool pipeline.
Pi's `defaultTools` selects `write`, `grep`, `find`, and `ls`; CodeAnchor manages its own tools.
Ordinary `write` operations remain Pi operations; the adapter handles staged AST resolution URLs.
Local read paths accept single ranges, range lists, tails, open ranges, and `:raw` compounds.
Bare code reads use the pinned structural summarizer for eligible long files.
Summary omissions are not counted as displayed edit anchors; the footer gives concrete ranges to re-read.

Known file ranges use `hashline_read` directly. Supported code structures use `ast_grep`, followed by source inspection.
Unsupported languages and dialects use text search and hashline reading or editing, without a forced related grammar.
Syntax-defined transformations use `ast_edit`, including single-occurrence changes; context-dependent changes use `hashline_edit` with current anchors.
Text search prefers Pi's built-in `grep`, then ripgrep (`rg`) through available execution, then another available method.
File discovery prefers Pi's `find` and `ls`; `rg --files` is the fallback when those tools cannot meet the requirement.
Tool descriptions and active prompt guidelines carry the full selection, inspection, editing, and recovery rules.
These search recommendations do not assume shell access or install search programs automatically.
When off, CodeAnchor disables its four tools and restores native `write` metadata without activating native `read` or `edit`.
Native read and write renderers still handle their corresponding results, including collapsed and expanded views.
Hashline edits, AST results, and AST resolution use ten-row previews with Pi's expansion shortcut.
Preview limits count wrapped terminal rows; expanded views retain the complete tool result.
Hashline edit headers show target paths instead of the native edit tool's incompatible argument placeholder.
UI folding does not change model-facing content, anchors, file tracking, or existing tool-output limits.

- `/code-anchor` toggles the extension.
- `/code-anchor on`, `/code-anchor off`, and `/code-anchor status` are explicit forms.
- New sessions default to on. The active branch stores the preference across reloads.
- When off, the native `read`/`edit` guard is inactive. Native tools require explicit selection and remain separate from CodeAnchor.
- Powerline shows `code-anchor: on` or `code-anchor: off` in its dedicated item.

`ast_edit` previews changes without writing.
Writing a reason to `xd://resolve` validates the preview, reruns the rewrite, and applies it; `xd://reject` discards it.
When reviewed source bytes or per-file matches change, resolution rejects the stale preview before writing.
This deliberately improves on the reference behavior, which can report staleness after applying a rerun.

Current AST scope supports local files, directories, and globs.
Pinned OMP source supplies reference behavior for retained local-code workflows, not its complete application platform.
OMP equality is not a requirement. Tested safety, simplicity, or performance improvements take precedence; material differences are documented.

## Selected grammars

| Group | Bundled grammars |
| --- | --- |
| Web source | JavaScript with JSX, TypeScript, TSX |
| Backend and systems | Python, Go, Rust, Java, C, C++, C#, Zig |
| Scripting | Bash, Lua, PowerShell |
| Web, data, and build formats | HTML, CSS, JSON, YAML, TOML, Dockerfile, CMake, Makefile |

JavaScript and JSX share one grammar. TypeScript and TSX have separate grammars.
CMake detection includes `CMakeLists.txt` and `.cmake` files.
Make detection includes `Makefile`, `makefile`, `GNUmakefile`, `.mk`, and `.mak` files.
JSON5, JSONC, SCSS, and all other unlisted grammars are excluded.
Both AST tool descriptions derive their grammar names and count from `grammars.json` at extension load.
The `ast_grep.lang` description explains explicit grammar selection and automatic filename detection.
Aliases remain accepted; grammar support does not guarantee every dialect or syntax version parses.
Unsupported text files still support ordinary reads and hashline edits; AST summaries fall back to ordinary text.
Ordinary grep remains available. Unsupported files are not silently routed to CSS or JSON parsers.
Bash extension aliases do not guarantee complete support for every shell dialect.

## Source and artifacts

Rust source, pinned grammar inputs, fixtures, and TypeScript remain ordinary Git files.
The final `wasm/*.wasm` artifact is assigned to Git LFS by the repository's `.gitattributes`.
`.build/`, compiler outputs, and downloaded grammar archives stay ignored.
No platform-specific `.node` artifacts are shipped.

A source checkout needs Git LFS to obtain real binary contents:

```text
git lfs install
git lfs pull
```

Git LFS is a checkout requirement, not a runtime dependency.
An archive containing LFS pointer text is not an accepted installation package.
The loader reports pointer text rather than trying to execute it.
Remote storage and bandwidth policies are outside the local filter check.

## Build and verification

Run commands from the agent directory:

```text
node --use-env-proxy extensions/code-anchor/scripts/build.ts prepare
node extensions/code-anchor/scripts/build.ts test
node extensions/code-anchor/scripts/build.ts build
node --test extensions/code-anchor/controls.test.ts extensions/code-anchor/wasm.test.ts
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node extensions/code-anchor/verify-integration.ts <installed-pi-package-directory>
node extensions/code-anchor/verify-live.ts <installed-pi-package-directory>
node extensions/code-anchor/verify-live-session.ts <installed-pi-package-directory>
node extensions/code-anchor/scripts/verify-tool-selection.ts <installed-pi-package-directory>
node extensions/code-anchor/verify-tui.ts <installed-pi-package-directory> <node-pty-package-directory> <powerline-package-directory>
node extensions/code-anchor/verify-performance.ts 100
node extensions/code-anchor/verify-performance.ts 1000
```

The build machine needs a selected Rust SDK, `wasm32-unknown-unknown`, and a WASM-capable C compiler.
`CODE_ANCHOR_LLVM` can select LLVM's binary directory.
On Windows, Cargo build scripts also need the host SDK's library paths, normally supplied by a developer terminal.
The build does not install prerequisites or change global toolchain defaults.

`grammars.json` pins grammar versions and archive hashes.
The modified Go grammar is tracked with its source and generated parser.
Tree-sitter 0.25.10 is vendored with a narrow build-script patch; its parser engine is not upgraded.
The platform layer uses pinned string/wide-character routines, a shared Rust allocator, and a real formatter rather than no-op formatting functions.
The final module's imports are checked during the build and actual runtime tests.

Release settings retain ordinary stripping, LTO, and size-oriented optimization.
The user-selected reduction removes unlisted grammars; it does not use custom table compression, UPX packing, or nightly standard-library rebuilds.
All 22 selected parsers remain included. Git LFS changes repository storage, not installed artifact size.

The saved offline workflow includes the toggle tests, final-WASM checks, pinned disk-backed fixtures, Powerline rendering, and real Pi integration with a local fixture provider.
`verify-live.ts` additionally checks a raw read and exact marker reply with the configured provider, model, and reasoning level.
That read-only live check passed without changing model settings.
`verify-live-session.ts` additionally checks multi-turn hashline editing, AST search, preview application, preview discard, off/reload, and re-enabled raw reads.
It also performs native manual compaction, checks persisted file metadata, reloads, and verifies a fresh hashline edit.
Its temporary project settings retain no recent history for that compaction case; global settings remain unchanged.
Live tests use temporary fixtures and retain the configured provider, model, and reasoning level.
They do not certify every model-generated edit.
`scripts/verify-tool-selection.ts` checks twelve natural tasks without global instructions or tool names in task prompts.
It checks tool order, known ranges, misleading literals, unsupported syntax, both editing methods, and explicitly selected native fallback.
`verify-tool-policy.ts` checks actual Pi CLI activation, restrictions, reload, and resumed native loadouts without external model requests.
Integration checks cover guidance from all five CodeAnchor tool definitions in Pi's prompt and local provider requests.
They check guidance removal, unchanged native `read`/`edit` definitions, and native `write` restoration when off, plus guidance restoration after re-enable and reload.
The live session verifier checks active guidance after real manual compaction and reload.
The integration verifier also renders actual tool results through Pi's renderer resolution and tool component.
It checks folding, expansion, resizing, wide characters, target headers, and unchanged model-facing results at 24, 60, and 120 columns.

`verify-tui.ts` starts the actual Pi CLI through an existing `node-pty` installation and loads the installed Powerline extension.
The test uses automatic CodeAnchor discovery, isolated settings, synthetic source, a local fixture provider, and no credentials or network requests.
It verifies real keyboard commands, tool results, on/off status, reload, explicit native fallback, resizing, and shutdown.
The checked sizes are 120 columns by 36 rows and 60 columns by 24 rows in full-screen mode.
Assertions inspect terminal output, lifecycle events, and filesystem bytes. Human visual review and other terminal emulators remain unverified.
On WSL, the same verifier passed through the installed util-linux `script` command and a disposable Node terminal driver.
That driver supplied terminal input, resize, and exit events; Pi executed the actual CodeAnchor tools.
The terminal drivers and fixture provider are verification-only resources, not CodeAnchor runtime dependencies.
`wasm.test.ts` checks the final artifact and actual host filesystem operations, not a copy of the Rust algorithms.
The Rust suites retain hashline fixtures from the pinned reference and test the shared edit finalizer.
Node.js 22 declarations are the static baseline.
Official Node.js 22.19.0 archives were SHA-256 verified and used from isolated temporary directories on Windows and WSL.
WSL integration and live checks used unmodified Pi 1.5.1 files copied to task-owned Linux storage.
Loading Pi from Windows-mounted storage exceeded an integration deadline; the same workflow passed with the local Linux copy.
No CodeAnchor source rebuild or platform-specific artifact was needed.
The WSL grep fallback used an official ripgrep 14.1.1 archive verified against its upstream SHA-256 sidecar.
All temporary runtimes, host copies, archives, drivers, and fixtures were removed; installed tools and the permanent PATH were unchanged.

Strict checking additionally uses `@types/webassembly-js-api@0.0.3` in the task-owned checking directory.
Version 2.0.0 is a stub whose dependency is unavailable through the approved registry.
The declaration package is not a runtime dependency and is not installed in the agent repository.

## Performance measurements

`verify-performance.ts` measures the real worker, core, host writes, and event-loop delay with temporary fixtures.
On Windows x64 at Node.js 24.22.1, the 1,000-file fixture contained 673,000 source bytes and 30,000 matches.
Measured medians were 128 ms for worker startup, 2.58 ms for warm reads, and 21.8 ms for read-plus-hashline-edit.
Searching all files took 1.69 seconds; previewing all replacements took 5.29 seconds.
One resolution and write of all 1,000 files took 8.96 seconds.
The host event-loop delay had a 16.55 ms p99 and a 23.95 ms maximum during this run.
The ending process RSS was 217,051,136 bytes, including worker resources; this is not peak-memory usage.
The run overlapped other validation processes. Small sample counts and synthetic input do not establish production latency guarantees.
No fixed performance target or comparison with OMP was established.
Parser and write safety checks remain enabled.

`scripts/notices.ts` collects notices from pinned sources and refuses incomplete distribution output.
The retained grammar and Cargo inventory has complete collected notices, including the portable C compatibility layer.
Excluded SCSS and JSON5 grammars are not part of this distribution.
