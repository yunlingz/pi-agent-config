import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeClient } from "./core-client.ts";
import type { NativeRead, NativeReadTarget } from "./core-types.ts";
import { fileTracking, type FileTrackingDetails } from "./file-tracking.ts";

// Pi 1.5.1 does not export its filename resolver at the package root.
const { resolveReadPathAsync }: typeof import("@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js") =
  await import(pathToFileURL(join(getPackageDir(), "dist/core/tools/path-utils.js")).href);

export type HashlineReadDetails = FileTrackingDetails & {
  selection?: Omit<NativeRead, "path" | "text">;
  readNotice?: string;
};

export async function resolveReadTarget(client: NativeClient, requested: string, display: string, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let path = await resolveReadPathAsync(requested, cwd);
  let metadata = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  let selector: string | null = null;
  if (!metadata) {
    // Existing literal filenames take precedence over selector interpretation.
    const parsed = JSON.parse(await client.request({ action: "read_target", path: requested }, signal)) as NativeReadTarget;
    selector = parsed.selector;
    if (selector !== null) {
      path = await resolveReadPathAsync(parsed.path, cwd);
      metadata = await stat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (path !== parsed.path) display = `${path}:${selector}`;
    }
  } else if (path !== requested) {
    display = path;
  }
  if (metadata && !metadata.isFile()) throw new Error("The read target must be a regular file");
  const raw = selector?.split(":").some(part => part.toLowerCase() === "raw") ?? false;
  return { path, display, selector, raw, metadata };
}

export function formatHashlineRead(result: NativeRead, canonicalPath: string, authored: string, raw: boolean) {
  if (result.firstLine === 0) {
    throw new Error("No lines from the selected range fit within the read limit. Check the range or use bounded text extraction.");
  }
  const notice = raw && result.truncated
    ? `[Read truncated after line ${result.lastLine} of ${result.totalLines}. Continue with ${result.path}:${result.lastLine + 1}-:raw.]`
    : undefined;
  const { path: _path, text, ...selection } = result;
  const content = [{ type: "text" as const, text }, ...(notice ? [{ type: "text" as const, text: notice }] : [])];
  const details: HashlineReadDetails = { ...fileTracking([canonicalPath], [], [authored]), selection, ...(notice ? { readNotice: notice } : {}) };
  return { content, structuredContent: content.map(block => block.text).join("\n"), details };
}
