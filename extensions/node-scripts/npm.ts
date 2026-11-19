import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { startProcess } from "./process.ts";
import type { Workspace } from "./workspace.ts";

const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/u;

async function npmEntry() {
  const executable = await realpath(process.execPath);
  for (const path of [resolve(dirname(executable), "../lib/node_modules/npm/bin/npm-cli.js"), join(dirname(executable), "node_modules/npm/bin/npm-cli.js")]) if (existsSync(path)) return path;
  throw new Error("Cannot locate npm beside Pi's Node.js installation");
}

export async function dependencies(workspace: Workspace, action: "add" | "remove", name: string, version?: string, signal?: AbortSignal, update?: (text: string) => void) {
  if (!PACKAGE.test(name) || name.startsWith(".")) throw new Error("Use an npm package name, not a path, URL or alias");
  if (action === "add" && (!version || !VERSION.test(version))) throw new Error("Use an exact semantic version");
  if (workspace.active || workspace.dependencyBusy || workspace.views().some(job => job.status === "unconfirmed")) throw new Error("Wait for running or unconfirmed jobs before changing dependencies");
  signal?.throwIfAborted();
  workspace.dependencyBusy = true;
  try {
    const manifest = await workspace.manifest();
    const present = Object.hasOwn(manifest.dependencies ?? {}, name);
    if (action === "add" ? present : !present) throw new Error(action === "add" ? "Dependency already exists; remove it before adding another version" : "Package is not a direct dependency");
    const cli = await npmEntry();
    const log = join(workspace.root, "logs", `npm-${randomUUID()}`);
    await mkdir(log, { mode: 0o700 });
    const npmrc = join(workspace.root, ".npmrc");
    await writeFile(npmrc, `registry=${workspace.registry}\nignore-scripts=true\n`, { mode: 0o600 });
    const globalrc = join(workspace.root, ".npm-globalrc");
    await writeFile(globalrc, "", { mode: 0o600 });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key)));
    const env = { ...inherited, npm_config_userconfig: npmrc, npm_config_globalconfig: globalrc };
    const flags = [`--registry=${workspace.registry}`, "--ignore-scripts", "--save-prod", "--save-exact", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=20000"];
    const args = action === "add" ? ["install", `${name}@${version}`] : ["uninstall", name];
    const runner = startProcess({ args: [cli, ...args, ...flags], cwd: workspace.root, env, timeoutSeconds: 120,
      stdoutPath: join(log, "stdout.log"), stderrPath: join(log, "stderr.log"), onOutput: text => update?.(text) });
    const abort = () => { void runner.deprecate(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let outcome;
    try { await runner.started.catch(() => {}); outcome = await runner.completion; }
    finally { signal?.removeEventListener("abort", abort); }
    await writeFile(join(log, "result.json"), JSON.stringify(outcome, null, 2), { mode: 0o600 });
    if (outcome.exitCode !== 0 || outcome.error || outcome.reason || !outcome.terminationConfirmed) throw new Error(`npm ${action} did not succeed; inspect ${log}`);
    return { package: name, version, action, logDirectory: log, workspace: workspace.root };
  } finally { workspace.dependencyBusy = false; }
}
