import {
  createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile, truncateHead, withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { registerControls, type ControlsContext } from "./controls.ts";
import { addonPath, NativeClient } from "./core-client.ts";
import type { NativeEdit, NativePlan, NativeRead, NativeSearch } from "./core-types.ts";
import { fileTracking, restoreCodeAnchorFiles, type FileTrackingDetails } from "./file-tracking.ts";
import type { GrammarManifest } from "./scripts/grammar-types.ts";
import { astEditRenderers, astSearchRenderers, hashlineRenderers, renderCompactResult } from "./render.ts";

function filePath(value: string, cwd: string): string {
  const mentioned = value.startsWith("@") ? value.slice(1) : value;
  const expanded = mentioned === "~" ? homedir() : mentioned.startsWith("~/") || mentioned.startsWith("~\\") ? resolve(homedir(), mentioned.slice(2)) : mentioned;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function lockFiles<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(paths)].sort();
  const next = (index: number): Promise<T> => {
    const path = sorted[index];
    return path === undefined ? operation() : withFileMutationQueue(path, () => next(index + 1));
  };
  return next(0);
}

export default async function registerCodeAnchor(pi: ExtensionAPI): Promise<void> {
  const binary = await addonPath();
  // The bundled manifest also supplies the core's grammar registry.
  const manifest = JSON.parse(await readFile(new URL("./grammars.json", import.meta.url), "utf8")) as GrammarManifest;
  const grammarDescription = [
    `Supported grammars (${manifest.grammars.length}): ${manifest.grammars.map(grammar => grammar.name).join(", ")}.`,
    "Language detection uses recognized filenames and extensions. JavaScript includes JSX; TSX is separate.",
    "JSONC, JSON5, SCSS, and unlisted grammars are unsupported. Grammar support does not guarantee every dialect or syntax version parses.",
  ].join(" ");
  let client = new NativeClient(binary);
  let enabled = true;
  const clearNativeState = async (): Promise<void> => {
    const previous = client;
    client = new NativeClient(binary);
    await previous.close();
  };
  pi.on("session_shutdown", clearNativeState);
  pi.on("session_tree", clearNativeState);
  pi.on("session_before_compact", event => restoreCodeAnchorFiles(event));

  const textResult = (text: string, details?: FileTrackingDetails) => {
    const output = truncateHead(text, { maxBytes: 49 * 1024, maxLines: 1900 });
    const notice = output.truncated ? "\n\n[Output truncated. Narrow paths or use read to inspect the relevant files.]" : "";
    return { content: [{ type: "text" as const, text: output.content + notice }], details };
  };

  function switchTools(next: boolean, context: ControlsContext): void {
    const builtinRead = createReadToolDefinition(context.cwd);
    const builtinEdit = createEditToolDefinition(context.cwd);
    const builtinWrite = createWriteToolDefinition(context.cwd);
    enabled = next;
    if (!next) {
      pi.registerTool(builtinRead);
      pi.registerTool(builtinEdit);
      pi.registerTool(builtinWrite);
      pi.setActiveTools(pi.getActiveTools().filter(name => name !== "ast_grep" && name !== "ast_edit"));
      return;
    }
    pi.registerTool({
      name: "read", label: "Read · CodeAnchor",
      description: "Read files with snapshot-tagged hashline anchors. Put optional line selectors in path: :N-M, :N+K, :N-, :-N, or comma ranges. :raw returns exact text without anchors; combine it with a range. Non-raw single ranges include surrounding context and syntax boundaries. Images use Pi's standard reader. Output is limited to 2000 lines or 50KB.",
      promptSnippet: "Inspect files and obtain snapshot-tagged hashline anchors",
      promptGuidelines: [
        "Use read to inspect implementations, control flow, and surrounding context after structural or text searches.",
        "Use read before edit or ast_edit. For hashline edit, copy the latest [path#TAG] header and source line numbers.",
        "A bare read can summarize code. Re-read needed omitted ranges; never invent hidden source or anchors.",
      ],
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      executionMode: "sequential",
      async execute(id, params, signal, onUpdate, ctx) {
        const path = filePath(params.path, ctx.cwd);
        const metadata = await stat(path).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (metadata && !metadata.isFile()) throw new Error("The read target must be a regular file");
        if (metadata && await detectSupportedImageMimeTypeFromFile(path)) return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
        const result = JSON.parse(await client.request({ action: "read", path, display: params.path, offset: params.offset, limit: params.limit }, signal)) as NativeRead;
        return { content: [{ type: "text", text: result.text }], details: fileTracking([filePath(result.path, ctx.cwd)], [], [params.path]) };
      },
    });
    pi.registerTool({
      name: "edit", label: "Edit · CodeAnchor",
      description: "Apply snapshot-checked hashline edits for context-specific changes. Prefer ast_edit when syntax defines the targets and transformation. Input starts with [path#TAG]. PUT N.=M: replaces lines with +payload rows; PUT <N: or PUT >N: inserts; CUT N.=M deletes; N* selects a syntax block. PUT >$: appends. CUT ranges and PUT targets can use @register. REM deletes a file; MV path moves it. Use write to create files.",
      promptSnippet: "Apply context-specific changes with snapshot-checked hashline anchors",
      promptGuidelines: [
        "Use edit for context-specific code, local control flow, prose, comments, and exact-line changes; prefer ast_edit for reliable syntax-defined transformations.",
        "Use edit with snapshot tags from read. Batch related operations under one file header; never invent a tag.",
        "When edit reports stale anchors, re-read the affected range before retrying. Keep replacements as small as correctness permits.",
        "When ast_edit is unsupported or unreliable, inspect current source with read and fall back to hashline edit.",
      ],
      parameters: Type.Object({ input: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        const request = { input: params.input, cwd: ctx.cwd, home: homedir() };
        const paths = JSON.parse(await client.request({ action: "inspect", ...request }, signal)) as string[];
        return lockFiles(paths, async () => {
          signal?.throwIfAborted();
          const result = JSON.parse(await client.request({ action: "apply", ...request, lockedPaths: paths }, signal)) as NativeEdit;
          return {
            content: [{ type: "text" as const, text: truncateHead(result.text).content }],
            isError: result.isError,
            details: { ...fileTracking([], result.files.flatMap(file => file.moveTo ? [file.absolute, file.moveTo] : [file.absolute])), diff: result.files.map(file => file.diff).join("\n\n"), patch: "", firstChangedLine: result.files[0]?.firstChangedLine ?? undefined, files: result.files },
          };
        });
      },
      ...hashlineRenderers,
    });
    pi.registerTool({
      name: "ast_grep", label: "AST Grep · CodeAnchor",
      description: `Prefer structural search for calls, constructors, imports, declarations, assignments, and repeated syntax during code exploration. Use $NAME for one capture and $$$NAME for multiple nodes. Paths accept files, directories, or globs; separate targets with semicolons. Returns 50 matches per page. ${grammarDescription}`,
      promptSnippet: "Prefer structural patterns for supported code exploration and call tracing",
      promptGuidelines: [
        "When ast_grep supports the language and syntax, prefer it for structural questions during explanations, investigations, reviews, and implementation.",
        "Use ast_grep for calls, constructors, imports, declarations, assignments, and repeated syntax; use read to inspect matched control flow.",
        "Use ls for immediate directory contents and find for filename/path globs; known paths can go directly to ast_grep or read.",
        "Prefer grep for text, literals, comments, configuration keys, logs, regex searches, and unsupported AST syntax.",
        "When dedicated search tools are unavailable or insufficient, use bash with rg; use git grep for committed files outside the checkout.",
        "Determine AST grammar support from active tool descriptions or bundled metadata; do not guess support from general Tree-sitter knowledge.",
        "Narrow ast_grep paths. For mixed-language directories, use suitable globs or automatic detection; do not force one grammar onto unrelated files.",
        "When expected ast_grep matches are absent, check path, language, and pattern; try a focused correction before text-search fallback.",
        "When AST parsing, matching, or execution remains unreliable, use grep, then bash with rg if needed; avoid unchanged failing queries.",
        "Treat ast_grep matches as syntax evidence, not type-resolved references or complete call graphs; disclose material coverage gaps.",
        "Choose ast_grep for useful evidence, not call quotas. Uncertain search coverage means zero matches do not prove absence.",
      ],
      parameters: Type.Object({
        pat: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String()),
        lang: Type.Optional(Type.String({ description: "Optional supported grammar name or alias; omitted means filename/extension detection. Applies to every selected file; narrow mixed-language paths." })),
        skip: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const result = JSON.parse(await client.request({ action: "search", paths: (params.path ?? ".").split(";").map(path => path.trim()).filter(Boolean), cwd: ctx.cwd, pattern: params.pat, language: params.lang, skip: params.skip ?? 0 }, signal)) as NativeSearch;
        const text = result.text;
        return textResult([text || "No matches found.", `${result.totalMatches} matches in ${result.filesWithMatches} files; ${result.filesSearched} files searched.`, ...result.warnings, ...(result.limitReached ? [`More matches remain. Continue with skip=${(params.skip ?? 0) + result.matches.length}.`] : [])].join("\n"), fileTracking([...new Set(result.matches.map(match => filePath(match.path, ctx.cwd)))], []));
      },
      ...astSearchRenderers,
    });
    pi.registerTool({
      name: "ast_edit", label: "AST Edit · CodeAnchor",
      description: `Prefer staged structural rewrites when syntax defines the targets and transformation, even for one occurrence. Use hashline edit for context-specific changes. Supply ops [{pat,out}] and paths. No files change during preview. Changed preview sources are rejected before writes. To apply, write a reason to xd://resolve; to discard, write a reason to xd://reject. ${grammarDescription}`,
      promptSnippet: "Preview syntax-defined transformations; use hashline edit for context-specific changes",
      promptGuidelines: [
        "Prefer ast_edit when syntax accurately defines the intended targets and transformation; match count alone must not determine the tool.",
        "Before unfamiliar or broad ast_edit rewrites, inspect the pattern with ast_grep; restrict paths and captures to authorized targets.",
        "Use ast_grep, not ast_edit, for read-only exploration. Identical names need not identify the same symbol.",
        "Review every ast_edit preview location, replacement, comment, and formatting change; narrow unintended matches before applying.",
        "When an ast_edit preview becomes stale, inspect current source and stage a new preview before resolving.",
        "Apply or discard a pending ast_edit preview before another editing method changes its affected files.",
        "After ast_edit or hashline edit, review the resulting diff and run applicable checks; edit application does not prove behavioral correctness.",
      ],
      parameters: Type.Object({ ops: Type.Array(Type.Object({ pat: Type.String({ minLength: 1 }), out: Type.String() }), { minItems: 1 }), paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const result = JSON.parse(await client.request({ action: "preview", paths: params.paths, cwd: ctx.cwd, operations: params.ops.map(op => ({ pattern: op.pat, replacement: op.out })) }, signal)) as NativePlan;
        const preview = result.files.map(file => `[${file.display}${file.tag ? `#${file.tag}` : ""}]\n${file.diff}`).join("\n\n");
        return textResult([result.files.length ? "Preview only; no files were modified. Use write to xd://resolve or xd://reject." : "No replacements made.", preview, `${result.totalReplacements} replacements in ${result.files.length} files.`, ...(result.limitReached ? ["File limit reached. Narrow paths and generate a new preview before applying."] : []), ...result.warnings].filter(Boolean).join("\n\n"), fileTracking(result.files.map(file => file.path), []));
      },
      ...astEditRenderers,
    });
    pi.registerTool<typeof builtinWrite.parameters, FileTrackingDetails | undefined>({
      ...builtinWrite,
      executionMode: "sequential",
      promptGuidelines: [
        ...(builtinWrite.promptGuidelines ?? []),
        "When CodeAnchor has an AST preview, write a reason to xd://resolve to apply it or xd://reject to discard it.",
        "Use write for new files or justified complete rewrites, not to bypass failed edit checks or AST/hashline safeguards.",
        "Do not bypass edit or ast_edit safeguards with shell replacement commands.",
      ],
      renderResult(result, options, theme, context) {
        if (context.args.path === "xd://resolve" || context.args.path === "xd://reject") {
          return renderCompactResult(result, options, theme, context);
        }
        return builtinWrite.renderResult?.({ ...result, details: undefined }, options, theme, context) ?? new Text("", 0, 0);
      },
      async execute(id, params, signal, update, ctx) {
        if (params.path !== "xd://resolve" && params.path !== "xd://reject") return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
        if (!params.content.trim()) throw new Error("Provide a reason to apply or discard the AST preview");
        const paths = params.path === "xd://resolve"
          ? JSON.parse(await client.request({ action: "pending_paths" }, signal)) as string[]
          : [];
        return lockFiles(paths, async () => {
          signal?.throwIfAborted();
          const result = JSON.parse(await client.request({ action: "resolve", apply: params.path === "xd://resolve" }, signal)) as NativeEdit;
          return { ...textResult(result.text, fileTracking([], result.files.map(file => file.absolute), [], [params.path])), isError: result.isError };
        });
      },
    });
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "read", "edit", "write", "ast_grep", "ast_edit"])]);
  }
  registerControls({
    on(name, handler) {
      switch (name) {
        case "session_start": return pi.on("session_start", (event, ctx) => handler(event, ctx));
        case "session_tree": return pi.on("session_tree", (event, ctx) => handler(event, ctx));
        case "session_shutdown": return pi.on("session_shutdown", (event, ctx) => handler(event, ctx));
      }
    },
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    registerCommand: (name, command) => pi.registerCommand(name, {
      ...command,
      handler: async (args, ctx) => command.handler(args, ctx),
    }),
  }, switchTools);
}
