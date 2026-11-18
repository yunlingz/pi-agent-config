import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { JOB_PREFIX } from "./types.ts";

export function storageRoot(): string {
  return resolve(process.env.PI_TEMP_SCRIPTS_DIR ?? join(homedir(), ".pi-temp-scripts"));
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) throw new Error("Script storage directory must be its original directory, not a link");
  if (process.getuid && metadata.uid !== process.getuid()) throw new Error("Script storage belongs to another user");
  if (create && process.platform !== "win32") await chmod(path, 0o700);
}

export async function jobDirectory(create = false): Promise<string> {
  const root = storageRoot();
  await privateDirectory(root, create);
  const jobs = join(root, "jobs");
  await privateDirectory(jobs, create);
  return jobs;
}

export async function validateJobLocation(path: string): Promise<void> {
  const root = resolve(path);
  if (!basename(root).startsWith(JOB_PREFIX)) throw new Error("Job root is outside the registered script namespace");
  if (dirname(root) === await realpath(tmpdir())) return; // Registered legacy jobs remain available; never scan or migrate them.
  if (dirname(root) !== await jobDirectory()) throw new Error("Job root is outside the registered script storage");
}
