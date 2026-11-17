import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface TerminalTrace {
  event: string;
  reason?: string;
  tools?: string[];
  expanded?: boolean;
  error?: boolean;
  root?: string;
}

export default function fixture(pi: ExtensionAPI): void {
  const directory = process.env.TEMP_SCRIPTS_TUI_DIRECTORY;
  assert(directory, "The terminal fixture requires an owned directory");
  const record = (value: TerminalTrace) => appendFileSync(join(directory, "trace.jsonl"), `${JSON.stringify(value)}\n`);
  globalThis.fetch = async () => { record({ event: "network" }); throw new Error("No network in terminal fixtures"); };
  pi.registerProvider("scripts-terminal-fixture", {
    api: "scripts-terminal-fixture", apiKey: "local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Managed scripts terminal fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.findLastIndex(message => message.role === "user");
      const results = context.messages.slice(user + 1).filter(message => message.role === "toolResult");
      const code = 'for(let i=0;i<30;i++) console.log("STREAM_ROW_"+i); console.log("TUI_EARLY"); await new Promise(r=>setTimeout(r,2500)); console.error("TUI_STDERR"); console.log("TUI_LATE");';
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        content: results.length === 0 ? [{ type: "toolCall", id: "terminal-script", name: "script_inline", arguments: { purpose: "Terminal streaming fixture", code, timeoutSeconds: 5 } }] : [{ type: "text", text: "TERMINAL_FINISHED" }],
        stopReason: results.length === 0 ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: results.length === 0 ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  pi.on("session_start", (event, ctx) => {
    record({ event: "start", reason: event.reason, tools: pi.getActiveTools() });
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "temp-script-job") record({ event: "job", root: (entry.data as { root: string }).root });
    }
  });
  pi.on("tool_execution_end", event => record({ event: "tool_end", error: event.isError }));
  pi.on("agent_settled", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "temp-script-job") record({ event: "job", root: (entry.data as { root: string }).root });
    }
    record({ event: "settled" });
  });
  pi.on("session_shutdown", event => record({ event: "shutdown", reason: event.reason }));
  pi.registerCommand("scripts-checkpoint", {
    description: "Record isolated terminal state",
    async handler(_args, ctx) {
      record({ event: "checkpoint", tools: pi.getActiveTools(), expanded: ctx.ui.getToolsExpanded() });
    },
  });
}
