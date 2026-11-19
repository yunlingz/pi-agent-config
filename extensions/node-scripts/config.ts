import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_REGISTRY = "https://packagefeedproxy.microsoft.io/npm/";
export interface Config { rootFolder: string; npmRegistry: string }

export function expandHome(path: string): string {
  return path === "~" ? homedir() : /^~[\\/]/u.test(path) ? join(homedir(), path.slice(2)) : path;
}

export function parseConfig(value: unknown): Config {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("node-scripts settings must be an object");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !["$schema", "rootFolder", "npmRegistry"].includes(key))) throw new Error("Unknown node-scripts setting");
  const root = source.rootFolder ?? "~/.pi-node-scripts";
  const registry = source.npmRegistry ?? DEFAULT_REGISTRY;
  if (typeof root !== "string" || !root.trim() || root.includes("\0") || !isAbsolute(expandHome(root))) throw new Error("rootFolder must be absolute or start with ~/ ");
  if (typeof registry !== "string") throw new Error("npmRegistry must be an HTTPS URL");
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("npmRegistry must be a credential-free HTTPS URL");
  return { rootFolder: resolve(expandHome(root)), npmRegistry: url.href.endsWith("/") ? url.href : `${url.href}/` };
}

export async function loadConfig(agentDirectory: string): Promise<Config> {
  let text: string;
  try { text = await readFile(join(agentDirectory, "pi-node-scripts.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return parseConfig({});
    throw new Error("Cannot read pi-node-scripts.json");
  }
  try { return parseConfig(JSON.parse(text)); }
  catch { throw new Error("Invalid pi-node-scripts.json; check its schema and paths"); }
}
