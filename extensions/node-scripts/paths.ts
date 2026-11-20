import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Validate managed paths before I/O. This is not a sandbox or protection against external filesystem races. */
export async function managedPath(root: string, ...parts: string[]): Promise<string> {
  const path = resolve(root, ...parts);
  const part = relative(root, path);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Managed path must stay inside this session workspace");
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink() || await realpath(root) !== root) throw new Error("Session workspace identity changed or contains a link");
  const names = part ? part.split(sep) : [];
  let current = root;
  for (const [index, name] of names.entries()) {
    current = join(current, name);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error("Managed workspace paths must not use links");
    if (index < names.length - 1 ? !info.isDirectory() : !info.isDirectory() && !info.isFile()) throw new Error("Managed path must use regular files and directories");
  }
  return path;
}

/** npm creates internal bin links; reject only links that can leave this workspace in its mutable trees. */
export async function managedTree(root: string, name: string): Promise<void> {
  const start = await managedPath(root, name);
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) {
      const canonical = await realpath(path);
      const target = relative(root, canonical);
      if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new Error("npm tree links must stay inside this session workspace");
      await visit(canonical);
    } else if (info.isDirectory()) {
      const canonical = await realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const child of await readdir(canonical)) await visit(join(canonical, child));
    } else if (!info.isFile() || info.nlink > 1) throw new Error("npm trees must use regular files without external hard links");
  }
  await visit(start);
}
