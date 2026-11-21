import {
  createReadToolDefinition, createEditToolDefinition, detectSupportedImageMimeTypeFromFile,
  formatSkillsForPrompt, generateDiffString, generateUnifiedPatch, withFileMutationQueue,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
  type ExtensionAPI, type ExtensionContext, type ReadToolDetails, type EditToolDetails,
  type EditToolInput, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { constants } from "node:fs";
import { access, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { applySection, digest, header, parsePatch, resolvePath, type Snapshot } from "./hashline.ts";

export const STATUS_KEY = "rw-hashline";
const PREFERENCE = "rw-hashline-preference";
const NESTED_FILES = "rw-hashline-nested-files";
type FileDetails = { rwHashline: { read: string[]; edited: string[]; snapshot?: Snapshot } };
type ReadDetails = ReadToolDetails & FileDetails & { nativeText?: string };
type EditDetails = EditToolDetails & FileDetails;
type NativeEditState = Parameters<NonNullable<ReturnType<typeof createEditToolDefinition>["renderCall"]>>[2]["state"];
interface EditState { native: NativeEditState; previewKey?: string }
const normalized = (text: string) => text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
// Tracking must not turn a successful native read into an error.
const canonicalPath = (path: string) => realpath(path).catch(() => path);

function editTitle(input: string, complete: boolean): string {
  return input ? "hashline_edit · lines" : complete ? "hashline_edit · unsupported input" : "hashline_edit";
}

function renamedTheme(theme: Theme, from: string, to: string): Theme {
  return new Proxy(theme, {
    get(target, key) {
      if (key === "bold") return (text: string) => target.bold(text.replace(new RegExp(`^${from}(?=\\s|$)`, "u"), to));
      return Reflect.get(target, key);
    },
  });
}

export default function registerRwHashline(pi: ExtensionAPI): void {
  let enabled = true;
  const snapshots = new Map<string, Snapshot>();
  const nativeEdit = createEditToolDefinition(process.cwd());
  const nativeRead = createReadToolDefinition(process.cwd());
  const readParameters = Type.Object({
    ...nativeRead.parameters.properties,
    raw: Type.Optional(Type.Boolean({ description: "Return native text without line anchors. Images and structured results always retain native behavior." })),
  }, { additionalProperties: false });
  const editParameters = Type.Object({
    input: Type.String({ minLength: 1, description: "A snapshot-checked line-edit document. Copy the quoted [path#TAG] header from hashline_read. Use PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, or CUT N.=M. PUT body rows start with +. Multiple files use separate headers. Exact-text arguments are not supported." }),
  }, { additionalProperties: false });

  const remember = (snapshot: Snapshot): Snapshot => {
    const previous = snapshots.get(snapshot.path);
    const ranges = [...(previous?.digest === snapshot.digest ? previous.ranges : []), ...snapshot.ranges];
    ranges.sort((left, right) => left[0] - right[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    const stored = { ...snapshot, ranges: merged };
    snapshots.set(snapshot.path, stored);
    return stored;
  };
  const restore = (ctx: ExtensionContext): void => {
    snapshots.clear();
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === PREFERENCE) {
        const data: unknown = entry.data;
        if (data && typeof data === "object" && "enabled" in data && typeof data.enabled === "boolean") enabled = data.enabled;
      }
      if (entry.type === "custom" && entry.customType === NESTED_FILES) {
        const metadata = entry.data as FileDetails["rwHashline"];
        for (const path of metadata.edited) snapshots.delete(path);
        if (metadata.snapshot) remember(metadata.snapshot);
      }
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const details: unknown = entry.message.details;
        if (details && typeof details === "object" && "rwHashline" in details) {
          // Only this extension writes the namespaced details contract.
          const metadata = details as FileDetails;
          for (const path of metadata.rwHashline.edited) snapshots.delete(path);
          if (metadata.rwHashline.snapshot) remember(metadata.rwHashline.snapshot);
        }
      }
    }
    switchTools(ctx);
  };
  const cliExcluded = new Set<string>();
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === "--") break;
    if (["--tools", "-t"].includes(process.argv[index] ?? "")) {
      for (const name of (process.argv[++index] ?? "").split(",")) {
        if (name.trim().startsWith("-")) cliExcluded.add(name.trim().slice(1));
        else if (name.trim().startsWith("+")) cliExcluded.delete(name.trim().slice(1));
      }
    }
  }
  const nativeNames = new Set(["read", "edit"]);
  const ownedNames = new Set(["hashline_read", "hashline_edit"]);
  function switchTools(ctx: ExtensionContext): void {
    const available = pi.getAllTools().map(tool => tool.name);
    const remove = enabled ? nativeNames : ownedNames;
    const add = enabled ? [...ownedNames] : available.filter(name => nativeNames.has(name));
    pi.setActiveTools([...new Set([...pi.getActiveTools().filter(name => !remove.has(name)), ...add])].filter(name => !cliExcluded.has(name)));
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, `rw-hashline: ${enabled ? "on" : "off"}`);
  }
  const hideNative = (): void => {
    if (!enabled) return;
    const active = pi.getActiveTools();
    if (active.some(name => nativeNames.has(name) || cliExcluded.has(name))) pi.setActiveTools(active.filter(name => !nativeNames.has(name) && !cliExcluded.has(name)));
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    snapshots.clear();
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("tool_call", event => {
    if (enabled && nativeNames.has(event.toolName)) return { block: true, reason: "rw-hashline is on. Use hashline_read or hashline_edit." };
    if (!enabled && ownedNames.has(event.toolName)) return { block: true, reason: "rw-hashline is off. Use native read or edit." };
  });
  pi.on("tool_execution_end", event => {
    hideNative();
    if (!event.parentToolCallId) return;
    const details: unknown = event.result.details;
    if (details && typeof details === "object" && "rwHashline" in details) {
      // Nested calls lack transcript messages. Keep file tracking without changing parent results.
      pi.appendEntry(NESTED_FILES, (details as FileDetails).rwHashline);
    }
  });
  pi.on("before_agent_start", event => {
    hideNative();
    const options = event.systemPromptOptions;
    if (!enabled || !options.selectedTools.includes("hashline_read") || options.sections.skills) return;
    const catalog = formatSkillsForPrompt(options.skills, "indirect");
    if (catalog) options.sections.skills = options.hiddenTools.includes("hashline_read") ? catalog
      : catalog.replace("Load a skill's file when the task matches its description.", "Use hashline_read to load a skill's file when the task matches its description.");
  });
  pi.on("session_before_compact", event => {
    for (const entry of event.branchEntries) {
      let metadata: FileDetails["rwHashline"] | undefined;
      if (entry.type === "custom" && entry.customType === NESTED_FILES) metadata = entry.data as FileDetails["rwHashline"];
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const details: unknown = entry.message.details;
        if (details && typeof details === "object" && "rwHashline" in details) metadata = (details as FileDetails).rwHashline;
      }
      if (!metadata) continue;
      for (const path of metadata.read) event.preparation.fileOps.read.add(path);
      for (const path of metadata.edited) event.preparation.fileOps.edited.add(path);
    }
  });
  pi.registerCommand("rw-hashline", {
    description: "Toggle rw-hashline, or use on, off, or status",
    getArgumentCompletions: prefix => ["on", "off", "status"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const command = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(command)) return ctx.ui.notify("Usage: /rw-hashline [on|off|status]", "warning");
      if (command !== "status") {
        if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current operation before changing rw-hashline.", "warning");
        const next = command === "" ? !enabled : command === "on";
        if (next !== enabled) {
          enabled = next;
          switchTools(ctx);
          pi.appendEntry(PREFERENCE, { enabled });
        }
      }
      ctx.ui.notify(`rw-hashline is ${enabled ? "on" : "off"}.`, "info");
    },
  });

  pi.registerTool<typeof readParameters, ReadDetails, { path?: string }>({
    ...nativeRead,
    name: "hashline_read", label: "Hashline Read", parameters: readParameters,
    description: `${nativeRead.description} Text reads add a snapshot header and numbered lines for hashline_edit. Use raw:true for native text. Paths are literal; use offset/limit rather than path selectors.`,
    promptSnippet: "Read files with native presentation and snapshot-checked line anchors",
    promptGuidelines: [
      "Use hashline_read to inspect files before editing. Copy its file header and line numbers for line edits.",
      "Use hashline_read with offset/limit for known ranges. Use raw:true when exact native text is needed.",
      "When rw-hashline is on, use hashline_read/hashline_edit rather than native read/edit. Ordinary write stays unchanged.",
    ],
    async execute(id, params, signal, update, ctx) {
      if (!enabled) throw new Error("rw-hashline is off.");
      let observed: Snapshot | undefined;
      let totalLines = 1;
      let image = false;
      const observe = (path: string, bytes: Buffer): void => {
        totalLines = 1;
        for (const byte of bytes) if (byte === 10) totalLines++;
        observed = { path, digest: digest(bytes), ranges: [] };
      };
      const tool = createReadToolDefinition(ctx.cwd, {
        autoResizeImages: pi.getSettings().images?.autoResize ?? true,
        operations: {
          access: path => access(path, constants.R_OK),
          async readFile(path) { const bytes = await readFile(path); observe(await canonicalPath(path), bytes); return bytes; },
          async detectImageMimeType(path) { const mime = await detectSupportedImageMimeTypeFromFile(path); image = Boolean(mime); return mime; },
          async *createReadStream(path, options) {
            const file = await open(path, "r");
            const hash = createHash("sha256");
            try {
              const stats = await file.stat();
              const stream = file.createReadStream({ end: stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined, signal: options.signal, autoClose: false });
              for await (const chunk of stream) {
                const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                hash.update(bytes);
                for (const byte of bytes) if (byte === 10) totalLines++;
                yield bytes;
              }
              observed = { path: await canonicalPath(path), digest: hash.digest("hex"), ranges: [] };
            } finally { await file.close(); }
          },
        },
      });
      const result = await tool.execute(id, params, signal, update ? partial => update({
        ...partial, details: { ...partial.details, rwHashline: { read: observed ? [observed.path] : [], edited: [] } },
      }) : undefined, ctx);
      const snapshot = observed;
      const nativeText = result.content.find(block => block.type === "text")?.text;
      if (!snapshot) return { ...result, details: { ...result.details, rwHashline: { read: [], edited: [] } } };
      const metadata: ReadDetails = { ...result.details, nativeText, rwHashline: { read: [snapshot.path], edited: [] } };
      if (image || nativeText === undefined) return { ...result, details: metadata };
      const rawStart = params.offset ? Math.max(0, params.offset - 1) : 0;
      const start = Math.trunc(rawStart);
      let end = params.limit === undefined ? totalLines : Math.trunc(Math.min(rawStart + params.limit, totalLines));
      if (end < 0) end = Math.max(0, totalLines + end);
      const count = Math.max(0, end - start);
      const truncation = result.details?.truncation;
      let body = truncation?.content ?? nativeText;
      if (!truncation && end < totalLines) {
        const notice = body.lastIndexOf("\n\n[");
        if (notice >= 0) body = body.slice(0, notice);
      }
      const rows = truncation?.firstLineExceedsLimit ? [] : body.split("\n").slice(0, count);
      const shown: string[] = [header(snapshot.path, snapshot.digest)];
      let bytes = Buffer.byteLength(shown[0] ?? "");
      let displayed = 0;
      for (const row of rows) {
        const numbered = `${start + displayed + 1}:${row.endsWith("\r") ? row.slice(0, -1) : row}`;
        const size = Buffer.byteLength(numbered) + 1;
        if (bytes + size > DEFAULT_MAX_BYTES - 512 || shown.length >= DEFAULT_MAX_LINES - 2) break;
        shown.push(numbered); bytes += size; displayed++;
      }
      snapshot.ranges = displayed ? [[start + 1, start + displayed]] : [];
      metadata.rwHashline.snapshot = remember(snapshot);
      if (params.raw || (rows.length && !displayed) || truncation?.firstLineExceedsLimit) return { ...result, details: metadata };
      if (start + displayed < totalLines) shown.push(`[More lines remain. Use offset=${start + displayed + 1} to continue.]`);
      return { ...result, content: [{ type: "text", text: shown.join("\n") }], details: metadata };
    },
    renderCall(args, theme, ctx) {
      const path = ctx.state.path ?? args.path;
      return nativeRead.renderCall?.({ ...args, path }, renamedTheme(theme, "read", "hashline_read"), { ...ctx, args: { ...args, path } }) ?? new Text("hashline_read", 0, 0);
    },
    renderResult(result, options, theme, ctx) {
      ctx.state.path = result.details?.rwHashline.read[0];
      const content = result.details?.nativeText === undefined ? result.content : result.content.map(block => block.type === "text" ? { ...block, text: result.details?.nativeText ?? block.text } : block);
      return nativeRead.renderResult?.({ ...result, content }, options, theme, ctx) ?? new Text("", 0, 0);
    },
  });

  async function plans(input: string, cwd: string) {
    const files = [];
    const paths = new Set<string>();
    for (const section of parsePatch(input)) {
      const path = await realpath(resolvePath(section.path, cwd));
      if (paths.has(path)) throw new Error("Merge operations for the same file under one header.");
      paths.add(path);
      await access(path, constants.R_OK | constants.W_OK);
      const snapshot = snapshots.get(path);
      if (!snapshot) throw new Error(`${section.path}: use hashline_read before editing.`);
      const before = await readFile(path);
      const after = applySection(before, section, snapshot);
      const oldText = normalized(before.toString("utf8"));
      const newText = normalized(after.toString("utf8"));
      files.push({ path, before, after, details: { ...generateDiffString(oldText, newText), patch: generateUnifiedPatch(section.path, oldText, newText) } });
    }
    return files;
  }
  const lock = <T>(paths: string[], operation: () => Promise<T>): Promise<T> => {
    const next = (index: number): Promise<T> => {
      const path = paths[index];
      return path === undefined ? operation() : withFileMutationQueue(path, () => next(index + 1));
    };
    return next(0);
  };
  pi.registerTool<typeof editParameters, EditDetails, EditState>({
    name: "hashline_edit", label: "Hashline Edit · Lines", parameters: editParameters,
    description: "Edit existing files only with snapshot-checked PUT/CUT line documents. Current file headers and displayed original lines are required. Payloads are literal. There is no exact-text replacement, AST parser, auto-repair, clipboard, rename, or file-delete operation. Use write only for new files and justified complete rewrites.",
    promptSnippet: "Apply literal line edits with mandatory snapshot anchors",
    promptGuidelines: [
      "Use hashline_read before every hashline_edit. Copy the current file header and displayed original line numbers.",
      "Use +payload rows as final content. Batch disjoint operations under one header; do not overlap ranges.",
      "For substring changes, replace complete affected lines using current hashline anchors.",
      "After hashline_edit, inspect the diff and run applicable checks. Read fresh anchors before the next edit.",
      "Do not bypass missing anchors with write, native edit, scripts, or another editing form.",
      "If a required line is truncated or undisplayed, stop and report the limitation.",
    ],
    constrainedSampling: nativeEdit.constrainedSampling,
    renderShell: nativeEdit.renderShell,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (!enabled) throw new Error("rw-hashline is off.");
      const paths = await Promise.all(parsePatch(params.input).map(section => realpath(resolvePath(section.path, ctx.cwd))));
      return lock([...new Set(paths)].sort(), async () => {
        signal?.throwIfAborted();
        const files = await plans(params.input, ctx.cwd);
        const edited: string[] = [];
        let failure: string | undefined;
        for (const file of files) {
          signal?.throwIfAborted();
          try {
            edited.push(file.path);
            await writeFile(file.path, file.after);
            snapshots.delete(file.path);
          } catch (error) { failure = error instanceof Error ? error.message : "Unknown write failure"; break; }
        }
        const details: EditDetails = {
          diff: files.map(file => file.details.diff).join("\n\n"),
          patch: files.map(file => file.details.patch).join("\n"),
          firstChangedLine: files[0]?.details.firstChangedLine,
          rwHashline: { read: [], edited },
        };
        const text = failure ? `Write failed: ${failure}. Earlier writes remain. No rollback was attempted. Re-read all affected files.` : `Successfully edited ${files.length} file(s). Read fresh anchors before the next line edit.`;
        return { content: [{ type: "text", text }], details, ...(failure ? { isError: true } : {}) };
      });
    },
    renderCall(args, theme, ctx) {
      ctx.state.native ??= {};
      const input = typeof args.input === "string" ? args.input : "";
      let display: EditToolInput;
      try { display = { path: parsePatch(input)[0]?.path ?? "hashline changes", edits: [] }; }
      catch { display = { path: "hashline changes", edits: [] }; }
      const title = editTitle(input, ctx.argsComplete);
      const component = nativeEdit.renderCall?.(display, renamedTheme(theme, "edit", title), { ...ctx, state: ctx.state.native, args: display }) ?? new Text(title, 0, 0);
      if (input && ctx.argsComplete && !ctx.executionStarted && ctx.state.previewKey !== input) {
        const key = input;
        ctx.state.previewKey = key;
        void plans(key, ctx.cwd).then(files => {
          if (ctx.state.previewKey !== key) return;
          const call = ctx.state.native.callComponent;
          if (call) call.preview = { diff: files.map(file => file.details.diff).join("\n\n"), firstChangedLine: files[0]?.details.firstChangedLine };
          ctx.invalidate();
        }, (error: unknown) => {
          if (ctx.state.previewKey !== key) return;
          const call = ctx.state.native.callComponent;
          if (call) call.preview = { error: error instanceof Error ? error.message : "Cannot preview this edit." };
          ctx.invalidate();
        });
      }
      return component;
    },
    renderResult(result, options, theme, ctx) {
      ctx.state.native ??= {};
      if (!options.isPartial) ctx.state.previewKey = undefined;
      let display: EditToolInput;
      try { display = { path: parsePatch(ctx.args.input ?? "")[0]?.path ?? "hashline changes", edits: [] }; }
      catch { display = { path: "hashline changes", edits: [] }; }
      const input = typeof ctx.args.input === "string" ? ctx.args.input : "";
      return nativeEdit.renderResult?.(result, options, renamedTheme(theme, "edit", editTitle(input, ctx.argsComplete)), { ...ctx, state: ctx.state.native, args: display }) ?? new Text("", 0, 0);
    },
  });
}
