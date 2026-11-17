import {
  createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile, truncateHead, withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { registerControls, type ControlsContext } from "./controls.ts";
import { addonPath, NativeClient } from "./core-client.ts";
import type { NativeEdit, NativePlan, NativeRead, NativeSearch } from "./core-types.ts";
import { fileTracking, restoreCodeAnchorFiles, type FileTrackingDetails } from "./file-tracking.ts";

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

  const renderResult = (result: { content: { type: string; text?: string }[] }): Text => {
    return new Text(result.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n"), 0, 0);
  };
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
      promptSnippet: "Read file contents and obtain hashline anchors",
      promptGuidelines: ["Use read before edit. Copy the [path#TAG] header and source line numbers from the latest read.", "A bare read can summarize code. Re-read only the footer-named ranges needed for the edit; never guess omitted lines."],
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
      renderResult,
    });
    pi.registerTool({
      name: "edit", label: "Edit · CodeAnchor",
      description: "Edit existing files with hashline sections. Input starts with [path#TAG]. PUT N.=M: replaces lines with +payload rows; PUT <N: or PUT >N: inserts; CUT N.=M deletes; N* selects a syntax block. PUT >$: appends. CUT ranges and PUT targets can use @register. REM deletes a file; MV path moves it. Use write to create files.",
      promptSnippet: "Apply snapshot-checked hashline edits",
      promptGuidelines: ["Use edit with snapshot tags from read. Batch related operations under one file header; never invent a tag."],
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
      renderResult,
    });
    pi.registerTool({
      name: "ast_grep", label: "AST Grep · CodeAnchor",
      description: "Search code structures with AST patterns. Use $NAME for one capture and $$$NAME for multiple nodes. Paths accept files, directories, or globs; separate targets with semicolons. Returns 50 matches per page.",
      promptSnippet: "Search code with structural patterns",
      promptGuidelines: ["Use ast_grep for structural code searches. Use grep for text, regular expressions, and files without a supported grammar."],
      parameters: Type.Object({ pat: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()), lang: Type.Optional(Type.String()), skip: Type.Optional(Type.Integer({ minimum: 0 })) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const result = JSON.parse(await client.request({ action: "search", paths: (params.path ?? ".").split(";").map(path => path.trim()).filter(Boolean), cwd: ctx.cwd, pattern: params.pat, language: params.lang, skip: params.skip ?? 0 }, signal)) as NativeSearch;
        const text = result.text;
        return textResult([text || "No matches found.", `${result.totalMatches} matches in ${result.filesWithMatches} files; ${result.filesSearched} files searched.`, ...result.warnings, ...(result.limitReached ? [`More matches remain. Continue with skip=${(params.skip ?? 0) + result.matches.length}.`] : [])].join("\n"), fileTracking([...new Set(result.matches.map(match => filePath(match.path, ctx.cwd)))], []));
      },
      renderResult,
    });
    pi.registerTool({
      name: "ast_edit", label: "AST Edit · CodeAnchor",
      description: "Preview structural rewrites with ops [{pat,out}] and paths. No files change during preview. Changed preview sources are rejected before writes. To apply, write a reason to xd://resolve; to discard, write a reason to xd://reject.",
      promptSnippet: "Stage structural code rewrites",
      promptGuidelines: ["ast_edit stages a preview. Review it before using write with xd://resolve or xd://reject."],
      parameters: Type.Object({ ops: Type.Array(Type.Object({ pat: Type.String({ minLength: 1 }), out: Type.String() }), { minItems: 1 }), paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) throw new Error("CodeAnchor is off");
        const result = JSON.parse(await client.request({ action: "preview", paths: params.paths, cwd: ctx.cwd, operations: params.ops.map(op => ({ pattern: op.pat, replacement: op.out })) }, signal)) as NativePlan;
        const preview = result.files.map(file => `[${file.display}${file.tag ? `#${file.tag}` : ""}]\n${file.diff}`).join("\n\n");
        return textResult([result.files.length ? "Preview only; no files were modified. Use write to xd://resolve or xd://reject." : "No replacements made.", preview, `${result.totalReplacements} replacements in ${result.files.length} files.`, ...(result.limitReached ? ["File limit reached. Narrow paths and generate a new preview before applying."] : []), ...result.warnings].filter(Boolean).join("\n\n"), fileTracking(result.files.map(file => file.path), []));
      },
      renderResult,
    });
    pi.registerTool<typeof builtinWrite.parameters, FileTrackingDetails | undefined>({
      ...builtinWrite,
      renderResult,
      executionMode: "sequential",
      promptGuidelines: [...(builtinWrite.promptGuidelines ?? []), "When CodeAnchor has an AST preview, write a reason to xd://resolve to apply it or xd://reject to discard it."],
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
