import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export type FileTrackingDetails = {
  codeAnchorFileTracking: 1;
  readFiles: string[];
  modifiedFiles: string[];
  readArguments: string[];
  writeArguments: string[];
};

export function fileTracking(readFiles: string[], modifiedFiles: string[], readArguments: string[] = [], writeArguments: string[] = []): FileTrackingDetails {
  return { codeAnchorFileTracking: 1, readFiles, modifiedFiles, readArguments, writeArguments };
}

export function restoreCodeAnchorFiles(event: Pick<SessionBeforeCompactEvent, "branchEntries"> & {
  preparation: Pick<SessionBeforeCompactEvent["preparation"], "fileOps">;
}): void {
  for (const entry of event.branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const details: unknown = entry.message.details;
    if (details === null || typeof details !== "object" || !("codeAnchorFileTracking" in details) || details.codeAnchorFileTracking !== 1) continue;
    // This marker identifies metadata produced by the owned CodeAnchor adapter.
    const files = details as FileTrackingDetails;
    for (const path of files.readArguments) event.preparation.fileOps.read.delete(path);
    for (const path of files.writeArguments) event.preparation.fileOps.written.delete(path);
    for (const path of files.readFiles) event.preparation.fileOps.read.add(path);
    for (const path of files.modifiedFiles) event.preparation.fileOps.edited.add(path);
  }
}
