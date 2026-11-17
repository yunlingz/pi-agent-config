import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";
import { nativeBlockReason } from "./policy.ts";

/** Recognize npm's Node shim without executing its shell program. Other batch files are unsupported. */
export function nodeShimTarget(source: string): string | undefined {
  const targets = [...source.matchAll(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+)"\s+%\*/giu)].map(match => match[1]).filter(value => value !== undefined);
  return targets.length > 0 && targets.every(value => value === targets[0]) ? targets[0] : undefined;
}

export async function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const windows = process.platform === "win32";
  const key = Object.keys(env).find(value => windows ? value.toLowerCase() === "path" : value === "PATH");
  const directories = /[\\/]/u.test(command) || isAbsolute(command) ? [""] : (env[key ?? "PATH"] ?? "").split(delimiter);
  const suffixKey = Object.keys(env).find(value => value.toLowerCase() === "pathext");
  const suffixes = windows && !extname(command) ? [...(env[suffixKey ?? "PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";"), ""] : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(cwd, directory, `${command}${suffix}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Continue normal PATH lookup. The caller reports an unavailable executable. */ }
    }
  }
  throw new Error("Executable not found on the inherited PATH; use an explicit installed path or correct the environment");
}

export async function nativeInvocation(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ command: string; args: string[] }> {
  const blocked = nativeBlockReason(command, args);
  if (blocked) throw new Error(blocked);
  const executable = await resolveExecutable(command, cwd, env);
  const target = await realpath(executable);
  const resolvedBlock = nativeBlockReason(target, args);
  if (resolvedBlock) throw new Error(resolvedBlock);
  if (process.platform !== "win32") return { command: executable, args };
  const extension = extname(executable).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    if ((await stat(executable)).size > 64 * 1024) throw new Error("Batch launcher exceeds the supported Node shim size");
    const relative = nodeShimTarget(await readFile(executable, "utf8"));
    if (!relative) throw new Error("This batch launcher requires a shell; only Node-based npm shims are supported");
    const script = resolve(dirname(executable), relative.replaceAll("\\", "/"));
    const metadata = await stat(script);
    if (!metadata.isFile()) throw new Error("Node shim target is not a regular file");
    const header = (await readFile(script, "utf8")).slice(0, 256);
    if (!/\.(?:[cm]?js)$/iu.test(script) && !/^#![^\n]*\bnode\b/u.test(header)) throw new Error("Batch launcher does not identify a Node.js program");
    return { command: process.execPath, args: [script, ...args] };
  }
  if (/\.(?:[cm]?js)$/iu.test(executable)) return { command: process.execPath, args: [executable, ...args] };
  return { command: executable, args };
}
