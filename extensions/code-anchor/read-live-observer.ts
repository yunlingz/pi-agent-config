import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../scripts/verification-data.ts";

export interface ReadLiveAudit {
  type: "request" | "tool";
  catalog?: boolean;
  imageInput?: boolean;
  tool?: string;
  succeeded?: boolean;
}

export default function observeReadLive(pi: ExtensionAPI) {
  const path = process.env.CODE_ANCHOR_READ_AUDIT;
  if (!path) throw new Error("Read parity observer requires its temporary audit path.");
  const emit = (record: ReadLiveAudit) => appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
  pi.on("before_provider_request", event => {
    if (!isRecord(event.payload)) return;
    const serialized = JSON.stringify(event.payload);
    emit({ type: "request", catalog: serialized.includes("<available_skills>") && serialized.includes("reader-live-fixture") && serialized.includes("Use hashline_read to load a skill's file"),
      imageInput: serialized.includes('"type":"input_image"') });
  });
  pi.on("tool_execution_end", event => emit({ type: "tool", tool: event.toolName, succeeded: !event.isError }));
}
