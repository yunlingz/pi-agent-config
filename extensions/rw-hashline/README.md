# rw-hashline

rw-hashline replaces CodeAnchor with two TypeScript implementation files and a one-line discovery entry.
It reuses Pi's native tool implementations.
It has no runtime package dependency beyond Pi's host-provided APIs and Node.js.
It has no AST tools, parser bundle, worker, WASM, Rust, C, or Git LFS artifact.

## Behavior

- `hashline_read` delegates reading, filename fallback, image processing, settings, truncation, and structured output to Pi.
- Text results add a quoted file header and numbered lines. `raw: true` returns native text and continuation notices.
- The UI retains native syntax highlighting, resource/skill/docs headers, images, and expansion.
- `hashline_edit` accepts literal line documents or native exact-text replacements through the same tool.
- Line edits preserve untouched bytes, mixed newline styles, BOM, indentation, and intentional duplicate rows.
- Exact-text edits reuse Pi's native matching, errors, newline handling, and diff metadata.
- Edit rows retain Pi's native diff presentation and pre-execution preview.
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

### Exact-text form

```json
{
  "path": "notes.md",
  "edits": [{ "oldText": "before", "newText": "after" }]
}
```

This form preserves native edit capabilities for substrings, very long lines, and notebook JSON.
It retains Pi's argument preparation for existing exact-text call shapes.
It is not a bypass for rejected line edits; re-read and correct stale or unsafe requests.

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
