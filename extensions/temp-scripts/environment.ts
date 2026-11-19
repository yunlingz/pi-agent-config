import { dirname, join, resolve } from "node:path";

/** Preserve inherited values. Windows treats environment names without case sensitivity. */
export function executionEnvironment(inherited: NodeJS.ProcessEnv, binDirectories: readonly string[], platform = process.platform): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  const windows = platform === "win32";
  const pathKeys = Object.keys(environment).filter(key => windows ? key.toLowerCase() === "path" : key === "PATH");
  const key = pathKeys[0] ?? "PATH";
  const separator = windows ? ";" : ":";
  const current = environment[key] ?? "";
  const existing = new Set(current.split(separator).map(path => windows ? path.toLowerCase() : path));
  const prepend = binDirectories.filter(path => {
    const identity = windows ? path.toLowerCase() : path;
    if (existing.has(identity)) return false;
    existing.add(identity);
    return true;
  });
  for (const duplicate of pathKeys.slice(1)) delete environment[duplicate];
  environment[key] = [...prepend, current].filter(Boolean).join(separator);
  return environment;
}

export function mergeEnvironment(inherited: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}, platform = process.platform): NodeJS.ProcessEnv {
  const merged = { ...inherited };
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === "win32") for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    merged[key] = value;
  }
  return merged;
}

export function projectBinDirectories(cwd: string): string[] {
  const bins: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    bins.push(join(directory, "node_modules", ".bin"));
    const parent = dirname(directory);
    if (parent === directory) return bins;
    directory = parent;
  }
}
