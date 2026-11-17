import { readFile, readdir, realpath, stat, lstat, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { NativeEdit } from "./core-types.ts";
import type { WasmEngine } from "./wasm-runtime.ts";

export interface HostFile { authored: string; path: string; content: string | null; exists: boolean; bytes?: number[] }
export interface WritePlan { path: string; display: string; operation: "create" | "update" | "delete" | "noop"; moveTo: string | null; before: string | null; beforeBytes?: number[]; content: string | null }
export interface StagedEdit { generation: number; files: WritePlan[] }

export async function resolveHostPath(value: string, cwd: string): Promise<string> {
  const mentioned = value.startsWith("@") ? value.slice(1) : value;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(mentioned)) throw new Error(`Unsupported filesystem URL: ${mentioned}`);
  const expanded = mentioned === "~" ? homedir() : /^~[/\\]/u.test(mentioned) ? resolve(homedir(), mentioned.slice(2)) : mentioned;
  const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const missing: string[] = [];
  let ancestor = path;
  for (;;) {
    try { return resolve(await realpath(ancestor), ...missing); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const entry = await lstat(ancestor).catch((failure: unknown) => {
        if (failure instanceof Error && "code" in failure && failure.code === "ENOENT") return undefined;
        throw failure;
      });
      if (entry?.isSymbolicLink()) throw new Error(`Cannot resolve dangling filesystem link: ${ancestor}`);
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function supplyFile(authored: string, cwd: string, allowBinary = false): Promise<HostFile> {
  const path = await resolveHostPath(authored, cwd);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Cannot read ${authored}: not a regular file`);
    const bytes = await readFile(path);
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { authored, path: portablePath(path), content, exists: true };
    } catch (error) {
      if (!allowBinary) throw error;
      return { authored, path: portablePath(path), content: null, exists: true, bytes: [...bytes] };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { authored, path: portablePath(path), content: null, exists: false };
    throw error;
  }
}

export function portablePath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

export async function discoverFiles(targets: string[], cwd: string, engine: WasmEngine, language?: string): Promise<HostFile[]> {
  const selected = new Map<string, HostFile>();
  const canonicalCwd = await realpath(cwd);
  for (const target of targets) {
    const magic = target.search(/[?*[{]/u);
    const separator = magic >= 0 ? Math.max(target.slice(0, magic).lastIndexOf("/"), target.slice(0, magic).lastIndexOf("\\")) : -1;
    const base = magic < 0 ? target : separator < 0 ? "." : target.slice(0, separator) || "/";
    const pattern = magic < 0 ? undefined : target.slice(separator + 1).replaceAll("\\", "/");
    const literal = await resolveHostPath(target, cwd);
    const literalMetadata = await stat(literal).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    const root = literalMetadata ? literal : await resolveHostPath(base, cwd);
    const metadata = literalMetadata ?? await stat(root);
    const selectionPattern = literalMetadata ? undefined : pattern;
    if (metadata.isFile()) { const file = await supplyFile(target, cwd); selected.set(file.path, file); continue; }
    if (!metadata.isDirectory()) throw new Error(`Not a file or directory: ${target}`);
    const paths: string[] = [];
    const ignores: { path: string; content: string }[] = [];
    const collectIgnores = async (directory: string): Promise<void> => {
      for (const name of [".gitignore", ".ignore"]) {
        const file = await supplyFile(resolve(directory, name), cwd);
        if (file.content !== null) ignores.push({ path: file.path, content: file.content });
      }
    };
    const withinWorkspace = relative(canonicalCwd, root);
    const inherit = !withinWorkspace.startsWith("..") && !isAbsolute(withinWorkspace);
    const ancestors: string[] = [];
    if (inherit) {
      let parent = dirname(root);
      while (parent !== dirname(canonicalCwd) && parent !== dirname(parent)) {
        ancestors.unshift(parent);
        if (parent === canonicalCwd) break;
        parent = dirname(parent);
      }
    }
    for (const parent of ancestors) await collectIgnores(parent);
    const walk = async (directory: string): Promise<void> => {
      await collectIgnores(directory);
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules");
      const directories = entries.filter(entry => entry.isDirectory()).map(entry => portablePath(resolve(directory, entry.name)));
      const descend = new Set(engine.session<string[]>({ action: "select", files: directories, directories: true, pattern: selectionPattern, ignores, root: portablePath(root), ignore_root: portablePath(inherit ? canonicalCwd : root) }));
      for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory() && descend.has(portablePath(path))) await walk(path);
        else if (entry.isFile()) paths.push(portablePath(path));
      }
    };
    await walk(root);
    const files = engine.session<string[]>({ action: "select", files: paths, pattern: selectionPattern, language, ignores, root: portablePath(root), ignore_root: portablePath(inherit ? canonicalCwd : root) });
    for (const path of files.sort()) {
      const file = await supplyFile(path, cwd);
      const display = relative(canonicalCwd, file.path);
      file.authored = portablePath(display.startsWith("..") || isAbsolute(display) ? file.path : display);
      selected.set(file.path, file);
    }
  }
  return [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function applyWrites(engine: WasmEngine, plan: StagedEdit, beforeWrite: () => void = () => {}): Promise<NativeEdit> {
  // Check every precondition before the first write. The caller retains Pi's file locks.
  const result: NativeEdit = { text: "", files: [] };
  try {
    for (const file of plan.files) {
      const current = await supplyFile(file.path, process.cwd(), file.beforeBytes !== undefined);
      const unchanged = file.beforeBytes === undefined
        ? current.content === file.before
        : current.bytes !== undefined && Buffer.from(current.bytes).equals(Buffer.from(file.beforeBytes));
      if (!unchanged) throw new Error(`${file.display} changed after staging; no files were modified`);
    }
    beforeWrite();
    for (const [index, file] of plan.files.entries()) {
      try {
        let written = "";
        if (file.operation === "delete") await unlink(file.path);
        else if (file.operation !== "noop") {
          if (file.content === null) throw new Error("The core returned an edit without write content");
          const path = file.moveTo ?? file.path;
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content);
          if (file.moveTo) await unlink(file.path);
          written = file.content;
        }
        const acknowledgement = engine.session<{ text: string; file: NativeEdit["files"][number] }>({ action: "commit", generation: plan.generation, index, written });
        result.files.push(acknowledgement.file);
        if (acknowledgement.text) result.text += (result.text ? "\n\n" : "") + acknowledgement.text;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown filesystem failure";
        result.isError = true;
        result.text = `Write failed for ${file.display}: ${reason}.\n${result.files.length} file operations were acknowledged. No rollback was attempted. Re-read the failed target before retrying.${result.text ? "\n\n" + result.text : ""}`;
        return result;
      }
    }
    return result;
  } finally { engine.session({ action: "abort" }); }
}
