import {
  createReadToolDefinition, createWriteToolDefinition,
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
    "Language detection uses recognized filenames and extensions. JavaScript includes JSX; TypeScript and TSX use separate grammars.",
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
  const toolNames = ["hashline_read", "hashline_edit", "ast_grep", "ast_edit"];
  // Pi's activation API does not retain negative --tools modifiers for dynamic registrations.
  let cliTools: string[] = [];
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--") break;
    if (arg === "--tools" || arg === "-t") cliTools = (process.argv[++index] ?? "").split(",").map(value => value.trim());
  }
  const excluded = new Set<string>();
  for (const name of cliTools) {
    if (name.startsWith("-")) excluded.add(name.slice(1));
    else if (name.startsWith("+")) excluded.delete(name.slice(1));
  }
  const nativeConflict = (name: string) => name === "read" || name === "edit";
  pi.on("tool_call", event => {
    if (enabled && nativeConflict(event.toolName)) {
      return { block: true, reason: "CodeAnchor is on. Use hashline_read or hashline_edit instead of native read or edit." };
    }
  });
  const hideNativeTools = () => {
    if (!enabled) return;
    const active = pi.getActiveTools();
    if (active.some(name => nativeConflict(name) || excluded.has(name))) {
      pi.setActiveTools(active.filter(name => !nativeConflict(name) && !excluded.has(name)));
    }
  };
  pi.on("before_agent_start", hideNativeTools);
  pi.on("tool_execution_end", hideNativeTools);

  const textResult = (text: string, details?: FileTrackingDetails) => {
    const output = truncateHead(text, { maxBytes: 49 * 1024, maxLines: 1900 });
    const notice = output.truncated ? "\n\n[Output truncated. Narrow paths or use hashline_read to inspect the relevant files.]" : "";
    return { content: [{ type: "text" as const, text: output.content + notice }], details };
  };

  function registerTools(cwd: string): void {
    const builtinRead = createReadToolDefinition(cwd);
    const builtinWrite = createWriteToolDefinition(cwd);
    const readParameters = Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    });
    pi.registerTool<typeof readParameters, FileTrackingDetails>({
      name: "hashline_read", label: "Hashline Read · CodeAnchor",
      description: "Read files with snapshot-tagged line anchors. If the file and relevant lines are known, open that range directly. Text reading does not require AST grammar support. Bare code reads can summarize supported syntax; unsupported syntax remains ordinary text. Inspect relevant implementations before editing. For hashline_edit, obtain current snapshot tags and line anchors from hashline_read. Put optional line selectors in path: :N-M, :N+K, :N-, :-N, or comma ranges. :raw returns exact text without anchors; combine it with a range. Non-raw single ranges include surrounding context and supported syntax boundaries. Images use Pi's standard reader. Output is limited to 2000 lines or 50KB.",
      promptSnippet: "Inspect known file ranges directly and obtain snapshot-tagged anchors for hashline edits",
      promptGuidelines: [
        "Use hashline_read to inspect implementations, control flow, arguments, and data transformations after structural or text searches.",
        "When the file and relevant lines are known, use hashline_read directly without repeated discovery or search.",
        "Use hashline_read for text files even when AST tools do not support their language or syntax.",
        "Use hashline_read before hashline_edit or ast_edit. For hashline_edit, copy its latest [path#TAG] header and source line numbers.",
        "If hashline_read summarizes needed source, open the omitted ranges. Never infer hidden source or invent anchors.",
        "When practical, batch independent hashline_read calls.",
      ],
      renderCall(args, theme) {
        const range = args.offset === undefined ? "" : `:${args.offset}${args.limit === undefined ? "-" : `+${args.limit}`}`;
        return new Text(`${theme.fg("toolTitle", theme.bold("hashline_read"))} ${theme.fg("accent", args.path)}${range}`, 0, 0);
      },
      renderResult(result, options, theme, context) {
        return builtinRead.renderResult?.({ ...result, details: undefined }, options, theme, context) ?? new Text("", 0, 0);
      },
      parameters: readParameters,
      executionMode: "sequential",
      async execute(id, params, signal, onUpdate, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const path = filePath(params.path, ctx.cwd);
        const metadata = await stat(path).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (metadata && !metadata.isFile()) throw new Error("The read target must be a regular file");
        if (metadata && await detectSupportedImageMimeTypeFromFile(path)) {
          const result = await createReadToolDefinition(ctx.cwd).execute(id, params, signal, undefined, ctx);
          return { ...result, details: fileTracking([path], []) };
        }
        const result = JSON.parse(await client.request({ action: "read", path, display: params.path, offset: params.offset, limit: params.limit }, signal)) as NativeRead;
        return { content: [{ type: "text", text: result.text }], details: fileTracking([filePath(result.path, ctx.cwd)], [], [params.path]) };
      },
    });
    pi.registerTool({
      name: "hashline_edit", label: "Hashline Edit · CodeAnchor",
      description: "Apply snapshot-checked edits to text files. Use hashline_edit for unsupported syntax and changes that depend on local context, comments, prose, or surrounding lines. Obtain current snapshot tags and line anchors from hashline_read. When supported syntax accurately defines the target and replacement, prefer ast_edit, even for one occurrence. Input starts with [path#TAG]. PUT N.=M: replaces lines with +payload rows; PUT <N: or PUT >N: inserts; CUT N.=M deletes. N* selects a syntax block when supported. PUT >$: appends. CUT ranges and PUT targets can use @register. REM deletes a file; MV path moves it. Use Pi's file-writing tool (write) to create files.",
      promptSnippet: "Edit unsupported syntax or context-dependent content using current hashline anchors",
      promptGuidelines: [
        "Use hashline_edit for unsupported syntax, context-specific code, local control flow, prose, comments, and exact-line changes.",
        "For hashline_edit, use current snapshot tags and source line numbers from hashline_read. Batch related operations under one file header.",
        "Never invent hashline_edit tags or omitted source. When stale anchors fail, open the affected range with hashline_read before retrying.",
        "For unsupported syntax-block selectors, use ordinary line operations with hashline_edit.",
        "When ast_edit is unsupported or unreliable, inspect current source with hashline_read and use hashline_edit.",
        "For hashline_edit, select the smallest correct change. Match count alone must not determine the editing tool.",
        "After hashline_edit, review the resulting diff and run applicable checks. Applying edits does not prove behavioral correctness.",
        "When CodeAnchor is on, do not use native read or edit instead of hashline_read or hashline_edit.",
      ],
      parameters: Type.Object({ input: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
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
      description: `For supported languages and syntax, prefer ast_grep to locate calls, constructors, imports, declarations, assignments, and repeated syntax. Search for the structure that performs the action, even when the question names a literal. For unsupported or unreliable syntax, use text search instead. Do not force an unrelated grammar onto an unsupported file. Use $NAME for one capture and $$$NAME for multiple nodes. Paths accept files, directories, or globs; separate targets with semicolons. Returns 50 matches per page. ${grammarDescription}`,
      promptSnippet: "Locate code by structure when supported; otherwise follow the text-search fallback order",
      promptGuidelines: [
        "Check ast_grep's advertised grammar scope before structural search; unsupported languages and dialects require text search.",
        "When ast_grep supports the language and syntax, prefer it during explanations, investigations, reviews, and implementation.",
        "Use ast_grep for calls, constructors, imports, declarations, assignments, and repeated syntax. Express the intended structure with captures.",
        "For assignment questions, use ast_grep with an assignment pattern such as params.include = $VALUE, not literal mentions.",
        "Do not replace ast_grep with text search merely because the question names an identifier or literal.",
        "Use text search for prose, comments, literal occurrences, configuration keys, log messages, and regular-expression searches.",
        "Prefer Pi's built-in text-search tool (grep). If unavailable or insufficient, try ripgrep (rg) through an available command-execution tool.",
        "If ripgrep is unavailable or insufficient, use another available text-search method. Follow execution restrictions; do not assume shell access.",
        "When ast_grep is unsupported or remains unreliable, follow that text-search fallback order and inspect results with hashline_read.",
        "For discovery, prefer Pi's directory-listing tool (ls) and filename-search tool (find) when available; inspect known ranges with hashline_read.",
        "When discovery tools are unavailable or insufficient, try rg --files through an available command-execution tool.",
        "For committed files outside the checkout, use git grep through an available command-execution tool within active execution restrictions.",
        "Determine ast_grep grammar support from active descriptions or bundled metadata, not assumptions about Tree-sitter support.",
        "Narrow ast_grep paths. Use suitable globs or automatic detection for mixed-language directories; do not force an unrelated grammar.",
        "When expected ast_grep matches are absent, check path, language, and pattern before one focused correction or text-search fallback.",
        "Do not repeat unchanged failing ast_grep queries. Choose useful evidence, not tool-call counts or a fixed sequence.",
        "Treat ast_grep matches as syntax evidence, not type-resolved references or complete call graphs. Disclose material coverage gaps.",
        "When ast_grep coverage is uncertain, zero matches do not prove absence. Inspect relevant results with hashline_read.",
      ],
      parameters: Type.Object({
        pat: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String()),
        lang: Type.Optional(Type.String({ description: "Optional supported grammar name or alias. If omitted, detect language from filenames. An explicit grammar applies to every selected file; narrow mixed-language paths." })),
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
      description: `For supported languages and syntax, prefer ast_edit when syntax defines both the target and replacement, even for one occurrence. Inspect relevant source with hashline_read before staging. For unsupported syntax or context-dependent changes, use hashline_edit. Do not force a grammar or apply an unreliable structural match. Language detection follows the selected paths. Supply ops [{pat,out}] and paths. No files change during preview. Changed preview sources are rejected before writes. To apply, use Pi's file-writing tool (write) with a reason at xd://resolve; to discard, use xd://reject. ${grammarDescription}`,
      promptSnippet: "Preview supported syntax-defined rewrites, including single matches; use hashline_edit otherwise",
      promptGuidelines: [
        "Check ast_edit's language and syntax support before structural rewriting; use hashline_read and hashline_edit when unsupported or unreliable.",
        "When supported syntax accurately defines both targets and transformation, prefer ast_edit, even for one occurrence.",
        "For ast_edit, select the smallest correct change. Match count alone must not determine the tool.",
        "Inspect relevant implementations with hashline_read before ast_edit. Before unfamiliar or broad rewrites, inspect the pattern with ast_grep.",
        "Restrict ast_edit paths and captures to authorized targets. Identical names need not identify the same symbol.",
        "Use ast_grep, not ast_edit, for read-only exploration.",
        "Review every ast_edit preview location, replacement, comment, and formatting change. Narrow unintended matches before applying.",
        "When an ast_edit preview becomes stale, inspect current source with hashline_read and stage a new preview before resolving.",
        "Apply or discard a pending ast_edit preview before another editing method changes its affected files.",
        "After ast_edit resolution, review the resulting diff and run applicable checks. Successful matching does not prove behavioral correctness.",
      ],
      parameters: Type.Object({ ops: Type.Array(Type.Object({ pat: Type.String({ minLength: 1 }), out: Type.String() }), { minItems: 1 }), paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const result = JSON.parse(await client.request({ action: "preview", paths: params.paths, cwd: ctx.cwd, operations: params.ops.map(op => ({ pattern: op.pat, replacement: op.out })) }, signal)) as NativePlan;
        const preview = result.files.map(file => `[${file.display}${file.tag ? `#${file.tag}` : ""}]\n${file.diff}`).join("\n\n");
        return textResult([result.files.length ? "Preview only; no files were modified. Use Pi's write tool with a reason at xd://resolve or xd://reject." : "No replacements made.", preview, `${result.totalReplacements} replacements in ${result.files.length} files.`, ...(result.limitReached ? ["File limit reached. Narrow paths and generate a new preview before applying."] : []), ...result.warnings].filter(Boolean).join("\n\n"), fileTracking(result.files.map(file => file.path), []));
      },
      ...astEditRenderers,
    });
    pi.registerTool<typeof builtinWrite.parameters, FileTrackingDetails | undefined>({
      ...builtinWrite,
      description: `${builtinWrite.description} For reviewed ast_edit previews, write a reason to xd://resolve or xd://reject. Do not bypass edit safeguards.`,
      executionMode: "sequential",
      promptGuidelines: [
        ...(builtinWrite.promptGuidelines ?? []),
        "For a reviewed ast_edit preview, use write with a reason at xd://resolve to apply or xd://reject to discard.",
        "Use write for new files or justified complete rewrites, not to bypass failed edit checks or AST/hashline safeguards.",
        "Do not bypass edit or ast_edit safeguards through scripts or command tools.",
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
  }
  registerTools(process.cwd());
  function switchTools(next: boolean, context: ControlsContext): void {
    const active = pi.getActiveTools();
    enabled = next;
    if (next) {
      registerTools(context.cwd);
      pi.setActiveTools([...new Set([...active.filter(name => !nativeConflict(name)), ...toolNames])].filter(name => !excluded.has(name)));
    } else {
      pi.registerTool(createWriteToolDefinition(context.cwd));
      pi.setActiveTools(active.filter(name => !toolNames.includes(name) && !excluded.has(name)));
    }
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
