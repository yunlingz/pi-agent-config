import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fileTracking, restoreCodeAnchorFiles } from "./file-tracking.ts";

function entry(details: ToolResultMessage["details"]): SessionEntry {
  return {
    type: "message", id: "fixture", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: "fixture", toolName: "edit", content: [], isError: false, timestamp: Date.now(), details },
  };
}

test("compaction receives hashline and AST file metadata rather than selector or virtual paths", () => {
  const fileOps = { read: new Set(["file.ts:2-4", "other.txt"]), written: new Set(["xd://resolve", "created.txt"]), edited: new Set(["native.txt"]) };
  const event = {
    branchEntries: [entry(fileTracking(["/workspace/file.ts"], ["/workspace/changed.ts"], ["file.ts:2-4"], ["xd://resolve"]))],
    preparation: { fileOps },
  };
  restoreCodeAnchorFiles(event);
  assert.deepEqual([...fileOps.read], ["other.txt", "/workspace/file.ts"]);
  assert.deepEqual([...fileOps.written], ["created.txt"]);
  assert.deepEqual([...fileOps.edited], ["native.txt", "/workspace/changed.ts"]);
  restoreCodeAnchorFiles(event);
  assert.equal(fileOps.edited.size, 2);
});

test("unrelated extension details and ordinary Pi file operations stay unchanged", () => {
  const fileOps = { read: new Set(["ordinary.txt"]), written: new Set<string>(), edited: new Set<string>() };
  restoreCodeAnchorFiles({ branchEntries: [entry({ files: ["not-a-CodeAnchor-result"] }), entry(undefined)], preparation: { fileOps } });
  assert.deepEqual([...fileOps.read], ["ordinary.txt"]);
  assert.equal(fileOps.edited.size, 0);
});
