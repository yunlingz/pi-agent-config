import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDocsPath } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";

export interface TuiTrace {
  event: "start" | "stop" | "settled" | "tool" | "checkpoint";
  phase?: string;
  name?: string;
  error?: boolean;
  tools?: string[];
  expanded?: boolean;
}

export default function registerFixture(pi: ExtensionAPI): void {
  const directory = process.env.RW_HASHLINE_TUI_DIRECTORY;
  if (!directory) throw new Error("The terminal fixture requires its task-owned directory.");
  const trace = (record: TuiTrace) => appendFileSync(join(directory, "trace.jsonl"), JSON.stringify(record) + "\n");
  pi.on("session_start", () => trace({ event: "start" }));
  pi.on("session_shutdown", () => trace({ event: "stop" }));
  pi.on("agent_settled", () => trace({ event: "settled" }));
  pi.on("tool_execution_end", event => trace({ event: "tool", name: event.toolName, error: event.isError }));
  pi.registerCommand("terminal-checkpoint", {
    description: "Record a verification-only terminal checkpoint",
    async handler(args, ctx) { trace({ event: "checkpoint", phase: args, tools: pi.getActiveTools(), expanded: ctx.ui.getToolsExpanded() }); },
  });
  pi.registerProvider("rw-hashline-tui", {
    api: "rw-hashline-tui", baseUrl: "http://127.0.0.1:1", apiKey: "local-fixture",
    models: [{ id: "fixture", name: "Hashline terminal fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const userIndex = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[userIndex];
      const prompt = user?.role === "user" ? (typeof user.content === "string" ? user.content : user.content.filter(block => block.type === "text").map(block => block.text).join("\n")) : "";
      const phase = /fixture:([a-z]+)/u.exec(prompt)?.[1];
      const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
      const plan = (name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: `terminal-${phase}-${results.length}`, name, arguments: args });
      let call: ToolCall | undefined;
      if (phase === "resource" && !results.length) call = plan("hashline_read", { path: "AGENTS.md" });
      if (phase === "skill" && !results.length) call = plan("hashline_read", { path: "skills/ui-fixture/SKILL.md" });
      if (phase === "docs" && !results.length) call = plan("hashline_read", { path: join(getDocsPath(), "models.md"), limit: 3 });
      if (phase === "line" || phase === "second" || phase === "rejected") {
        if (!results.length) call = plan("hashline_read", phase === "rejected" ? { path: "fixture.ts", offset: 1, limit: 1 } : { path: "fixture.ts" });
        else if (results.length === 1) {
          const text = results[0]?.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          const header = text?.split("\n")[0];
          if (!header) throw new Error("Missing fixture snapshot.");
          call = plan("hashline_edit", { input: `${header}\nPUT 2:\n+${phase === "line" ? "console.log(after);" : phase === "second" ? "console.warn(after);" : "console.error(unseen);"}` });
        }
      }
      if (phase === "write" && !results.length) call = plan("write", { path: "written.md", content: "WRITE_UI_MARKER\n" });
      if (phase === "native" && !results.length) call = plan("edit", { path: "fixture.ts", edits: [{ oldText: "console.warn(after)", newText: "console.info(after)" }] });
      if (phase === "fold" && !results.length) call = plan("hashline_read", { path: "fold.ts" });
      if (getCurrentSystemPrompt(context.messages).includes("ast_edit")) throw new Error("AST tool guidance remains in the replacement fixture.");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [call] : [{ type: "text", text: `FIXTURE_DONE_${phase}` }], stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
}
