import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface TuiTrace {
  event: string;
  phase?: string;
  mode?: string;
  reason?: string;
  tools?: string[];
  name?: string;
  error?: boolean;
  text?: string;
}

export default function registerTuiFixture(pi: ExtensionAPI): void {
  const directory = process.env.CODE_ANCHOR_TUI_DIRECTORY;
  assert(directory, "This fixture requires its isolated test directory");
  const record = (trace: TuiTrace): void => {
    appendFileSync(join(directory, "trace.jsonl"), JSON.stringify(trace) + "\n");
  };
  globalThis.fetch = async () => {
    record({ event: "network_attempt" });
    throw new Error("The terminal fixture must not use the network");
  };
  pi.registerProvider("code-anchor-tui-fixture", {
    api: "code-anchor-tui-fixture", apiKey: "local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "CodeAnchor terminal fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const userIndex = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[userIndex];
      const prompt = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
      const phase = prompt.replace(/^fixture:/u, "").trim();
      const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
      assert(results.every(result => !result.isError), "A real terminal tool call failed");
      let call: Pick<ToolCall, "id" | "name" | "arguments"> | undefined;
      const plan = (name: string, args: ToolCall["arguments"]): void => {
        call = { id: `${phase}-${results.length}`, name, arguments: args };
      };
      switch (phase) {
        case "hashline":
          if (results.length === 0) plan("read", { path: "fixture.ts" });
          else if (results.length === 1) {
            const text = results[0]?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
            const tag = /\[fixture\.ts#([0-9A-F]{4})\]/u.exec(text)?.[1];
            assert(tag, "The terminal read must supply a hashline tag");
            plan("edit", { input: `[fixture.ts#${tag}]\nPUT 2:\n+console.log(after);` });
          }
          break;
        case "preview":
          if (results.length === 0) plan("ast_grep", { pat: "console.log($VALUE)", path: "fixture.ts" });
          else if (results.length === 1) plan("ast_edit", { ops: [{ pat: "console.log($VALUE)", out: "logger.info($VALUE)" }], paths: ["fixture.ts"] });
          break;
        case "resolve":
          if (results.length === 0) plan("write", { path: "xd://resolve", content: "Apply the reviewed terminal fixture." });
          break;
        case "builtin":
          if (results.length === 0) plan("read", { path: "fixture.ts" });
          else if (results.length === 1) plan("edit", { path: "fixture.ts", edits: [{ oldText: "logger.info(after);", newText: "logger.warn(after);" }] });
          break;
        case "raw":
          if (results.length === 0) plan("read", { path: "fixture.ts:raw" });
          break;
        default: throw new Error("Unknown terminal fixture prompt");
      }
      record({ event: "model_request", phase });
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", ...call }] : [{ type: "text", text: `FIXTURE_DONE_${phase}` }],
        stopReason: call ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (event, ctx) => record({ event: "session_start", mode: ctx.mode, reason: event.reason, tools: pi.getActiveTools() }));
  pi.on("session_shutdown", event => record({ event: "session_shutdown", reason: event.reason }));
  pi.on("tool_execution_end", event => {
    // Pi emits its standard tool-result contract; this SDK event declares the result without a concrete type.
    const result = event.result as AgentToolResult<unknown>;
    record({ event: "tool_end", name: event.toolName, error: event.isError, text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n") });
  });
  pi.on("agent_settled", () => record({ event: "settled" }));
  pi.registerCommand("terminal-checkpoint", {
    description: "Record the isolated terminal tool selection",
    handler: async (args, ctx) => {
      record({ event: "checkpoint", phase: args.trim(), mode: ctx.mode, tools: pi.getActiveTools() });
      ctx.ui.notify(`CHECKPOINT_${args.trim()}`, "info");
    },
  });
}
