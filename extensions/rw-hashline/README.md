# rw-hashline

rw-hashline replaces CodeAnchor with two TypeScript implementation files and a one-line discovery entry.
It reuses Pi's native tool implementations.
It has no runtime package dependency beyond Pi's host-provided APIs and Node.js.
It has no AST tools, parser bundle, worker, WASM, Rust, C, or Git LFS artifact.

## Behavior

- `hashline_read` delegates reading, filename fallback, image processing, settings, truncation, and structured output to Pi.
- Text results add a quoted file header and numbered lines. `raw: true` returns native text and continuation notices.
- The UI retains native syntax highlighting, resource/skill/docs headers, images, and expansion.
- `hashline_edit` accepts only snapshot-checked line documents. Anchoring is mandatory for every edit through this tool.
- Line edits preserve untouched bytes, mixed newline styles, BOM, indentation, and intentional duplicate rows.
- Edit rows retain Pi's native diff presentation and pre-execution preview, with an explicit `hashline_edit · lines` header.
- Rejected edit rows keep the hashline tool name instead of being relabeled as native `edit`.
- Ordinary `write` remains the built-in tool. It keeps its complete behavior and UI.
- While enabled, rw-hashline removes native `read`/`edit` from active selection and blocks stale or nested calls.

### Line documents

Copy the header and original line numbers from `hashline_read`:

```text
["/project/notes.md"#A1B2C3D4E5F6]
PUT 2.=3:
+replacement line
+another replacement line
PUT >3:
+inserted line
CUT 5.=5
```

`PUT N.=M:` replaces an inclusive range. `PUT <N:` and `PUT >N:` insert before or after a line.
`PUT >$:` appends. `CUT N.=M` deletes an inclusive range without payload rows.
Single-line shorthand uses `PUT N:` or `CUT N`.
Multiple files use separate headers in one document. All sections validate before the first write.
If a filesystem write fails, earlier writes remain; the result does not claim rollback.

Headers use JSON-quoted paths, so brackets, quotes, whitespace, and newlines in filenames remain representable.
Tags use 12 hexadecimal SHA-256 characters. Validation checks the complete recorded digest of the original bytes.
Line edits require current snapshots and displayed lines. Fresh reads are required after edits.
Pi's native read exposes a final empty row; cutting that row removes the final newline.

There is no `N*` block selection, clipboard, move, rename, file deletion, or automatic payload repair.
Use ordinary filesystem tools for file operations. Use `write` for new files and justified complete rewrites.

### Mandatory editing contract

The only edit input is `{ "input": "..." }`, containing current file headers and PUT/CUT operations.
Native `path`/`edits[]`, top-level `oldText`/`newText`, and legacy exact-text shapes are rejected before writing.
There is no argument conversion or automatic fallback to another editing form.

For a substring change, replace the complete affected lines after inspecting them with `hashline_read`.
Notebook JSON uses the same line-editing contract; it has no separate replacement interface.
If a complete required line exceeds the read limit, anchored editing remains unavailable for that line.
The plugin rejects edits to undisplayed content; it must not bypass this restriction through `write` or scripts.
Native read/write behavior remains available. Full parity with native exact-text editing is intentionally not claimed.

## Controls and Powerline

- `/rw-hashline` toggles the plugin.
- `/rw-hashline on`, `/rw-hashline off`, and `/rw-hashline status` are explicit commands.
- New sessions default to on. The active branch stores its preference across reloads.
- Off disables hashline tools and activates available native `read`/`edit`, subject to explicit CLI exclusions.
- Powerline uses status key `rw-hashline` and displays `rw-hashline: on` or `rw-hashline: off`.

## Code reference

[`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline) is code reference material, not a runtime dependency or authoritative upstream.
`reference.json` records the inspected npm release, archive integrity, and relevant source files.
The inspected package requires Bun and native components, so rw-hashline does not import or vendor its implementation.
The small local implementation follows its basic PUT/CUT syntax, with explicit differences described above.

The maintenance check performs no startup requests and never modifies or updates code:

```text
node extensions/rw-hashline/check-reference.ts
```

A newer reference release is a signal for source review, not an instruction to adopt its behavior.

## Verification

Run these commands from the agent directory:

```text
node --test extensions/rw-hashline/hashline.test.ts
node extensions/rw-hashline/verify-integration.ts <installed-pi-package-directory>
node extensions/rw-hashline/verify-tui.ts <installed-pi-package-directory> <node-pty-directory> <powerline-directory>
node extensions/rw-hashline/verify-live.ts <installed-pi-package-directory>
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

Tests use the actual implementation and harmless temporary files. MCP stays disabled.
Strict checking follows the shared `TYPESCRIPT.md` and `tsconfig.json`.
Verification reports name the tested runtime and platform; they do not claim universal parity from finite samples.
