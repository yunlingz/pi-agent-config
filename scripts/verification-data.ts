import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Use the producer's declared type only for controlled JSON, not arbitrary external input.
export function parseTrustedJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function readJson<T = unknown>(path: string): T {
  try {
    return parseTrustedJson<T>(readFileSync(path, "utf8"));
  } catch {
    // Parser diagnostics can include private configuration values.
    throw new Error(`Cannot read valid JSON: ${path}`);
  }
}

export function readPackageInfo(path: string): { name: string; version: string } {
  return readJson<{ name: string; version: string }>(path);
}

export function resolveInstalledEntry(packageName: string, hostDirectory: string): string {
  const require = createRequire(pathToFileURL(join(hostDirectory, "package.json")));
  const metadataPath = (require.resolve.paths(packageName) ?? [])
    .map((directory) => join(directory, packageName, "package.json"))
    .find((path) => existsSync(path));
  if (!metadataPath) throw new Error(`Cannot locate installed package: ${packageName}`);
  const metadata = readJson<{ main: string }>(metadataPath);
  return resolve(dirname(metadataPath), metadata.main);
}
