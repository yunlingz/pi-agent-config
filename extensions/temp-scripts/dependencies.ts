import { existsSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { REGISTRY, type JobManifest, type RunOptions } from "./types.ts";
import { runProcess } from "./process.ts";

export function validateDependencies(dependencies: Record<string, string>): void {
  if (Object.keys(dependencies).length > 30) throw new Error("At most 30 direct dependencies are supported");
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
      || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/u.test(version)) throw new Error("Dependencies require package names and exact semantic versions; URLs, aliases, and ranges are not supported");
  }
}

export async function npmEntry(): Promise<string> {
  const executable = await realpath(process.execPath);
  for (const path of [resolve(dirname(executable), "../lib/node_modules/npm/bin/npm-cli.js"), join(dirname(executable), "node_modules/npm/bin/npm-cli.js")]) {
    if (existsSync(path)) return path;
  }
  throw new Error("Cannot locate npm beside the active Node.js installation; no installation fallback is allowed");
}

export function validateLock(value: unknown): void {
  if (value === null || typeof value !== "object" || !("packages" in value) || value.packages === null || typeof value.packages !== "object") throw new Error("npm did not produce the expected lockfile");
  for (const [path, entry] of Object.entries(value.packages)) {
    if (path === "") continue;
    if (entry === null || typeof entry !== "object" || !("resolved" in entry) || typeof entry.resolved !== "string") throw new Error("Dependency has no approved registry resolution");
    const url = new URL(entry.resolved);
    if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "packagefeedproxy.microsoft.io" || url.hostname.endsWith(".pkgs.visualstudio.com") || url.hostname === "pkgs.dev.azure.com")) {
      throw new Error("Dependency resolution left the approved Microsoft registry feeds");
    }
  }
}

export async function installDependencies(job: JobManifest, dependencies: Record<string, string>, options: RunOptions, logDirectory: string): Promise<void> {
  validateDependencies(dependencies);
  const cli = await npmEntry();
  await writeFile(join(job.root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }, null, 2));
  await writeFile(join(job.root, ".npmrc"), "", { mode: 0o600 });
  await writeFile(join(job.root, "npm-globalrc"), "", { mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key)));
  const env = { ...environment, npm_config_userconfig: join(job.root, ".npmrc"), npm_config_globalconfig: join(job.root, "npm-globalrc"), npm_config_cache: join(job.root, "npm-cache") };
  const flags = [`--registry=${REGISTRY}`, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=20000"];
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  for (const [phase, args] of [["resolve", ["install", "--package-lock-only"]], ["install", ["ci"]]] as const) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) throw new Error("Dependency installation exceeded its deadline");
    const result = await runProcess({ command: process.execPath, args: [cli, ...args, ...flags], cwd: job.root, env,
      timeoutSeconds: remaining, signal: options.signal,
      stdoutPath: join(logDirectory, `${phase}-stdout.log`), stderrPath: join(logDirectory, `${phase}-stderr.log`),
      onProgress: update => options.onProgress?.({ ...update, phase: `dependencies: ${phase}` }),
    });
    await writeFile(join(logDirectory, `${phase}-result.json`), JSON.stringify(result, null, 2));
    if (!result.terminationConfirmed) await writeFile(join(logDirectory, "termination-unconfirmed"), "Process termination could not be confirmed.");
    if (result.status !== "succeeded") throw new Error(`Dependency ${phase} ${result.status}; logs retained in ${logDirectory}`);
    if (phase === "resolve") {
      const lock: unknown = JSON.parse(await readFile(join(job.root, "package-lock.json"), "utf8"));
      validateLock(lock);
    }
  }
}
