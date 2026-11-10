import { readFileSync } from "node:fs";

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
