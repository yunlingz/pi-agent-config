import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JobView } from "./types.ts";

export interface Trace { event: string; time: number; job?: JobView; workspace?: string; reason?: string; error?: boolean }

export default function fixture(pi: ExtensionAPI) {
  const root = process.env.NODE_SCRIPTS_TUI_ROOT;
  assert(root, "An isolated terminal fixture directory is required");
  const record = (value: Omit<Trace, "time">) => appendFileSync(join(root, "trace.jsonl"), `${JSON.stringify({ ...value, time: Date.now() })}\n`);
  globalThis.fetch = async () => { record({ event: "network" }); throw new Error("No network in terminal fixtures"); };
  pi.registerProvider("node-terminal-fixture", {
    api: "node-terminal-fixture", apiKey: "unused", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Node terminal fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const index = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[index];
      const prompt = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter(value => value.type === "text").map(value => value.text).join("") : "";
      const results = context.messages.slice(index + 1).filter(message => message.role === "toolResult");
      assert(results.every(value => !value.isError), "A synthetic terminal tool call failed");
      const summary = JSON.stringify(context).includes("summarization assistant");
      if (!summary) {
        const system = getCurrentSystemPrompt(context.messages);
        assert(!system.includes("<node_scripts_workspace>"));
        const enabled = getCurrentTools(context.messages).some(tool => tool.name === "node_job_create");
        const workspace = /^- Current node-scripts workspace: (.*)\.$/mu.exec(system)?.[1];
        assert.equal(Boolean(workspace), enabled);
        if (workspace) assert(workspace.startsWith(join(root, "workspaces")));
        record({ event: "prompt", workspace });
      }
      let call: ToolCall | undefined;
      const plan = (name: string, args: ToolCall["arguments"]) => { call = { type: "toolCall", id: `terminal-${index}-${results.length}`, name, arguments: args }; };
      const restored = <T>(value: { details?: unknown } | undefined): T => value?.details as T; // Extension-owned serialized fixture result.
      const details = restored<{ workspace?: string; jobs?: JobView[] } | undefined>(results[0]);
      const workspace = details?.workspace;
      if (!summary && /service|timed/u.test(prompt)) {
        const timed = prompt.includes("timed");
        const file = timed ? "timed.mjs" : "service.mjs";
        if (results.length === 0) plan("node_job_list", { status: "created", recentN: 10 });
        else if (results.length === 1) {
          assert(workspace);
          plan("write", { path: join(workspace, "scripts", file), content: timed
            ? 'console.log("TIMED_LIVE",process.pid);setInterval(()=>{},1000);'
            : 'console.log("SERVICE_LIVE",process.pid);setInterval(()=>console.log("LATEST_SERVICE_LINE"),200);' });
        } else if (results.length === 2) plan("node_job_create", { scriptPath: `scripts/${file}`, name: timed ? "Terminal timed job" : "Terminal service", ...(timed ? { timeoutSeconds: 30 } : {}) });
        else if (results.length === 3) { const job = restored<JobView>(results[2]); plan("node_job_run", { jobId: job.id }); }
      } else if (!summary && prompt.includes("many")) {
        if (results.length === 0) plan("node_job_list", { status: "created", recentN: 10 });
        else if (results.length === 1) { assert(workspace); plan("write", { path: join(workspace, "scripts", "empty.mjs"), content: 'console.log("empty");' }); }
        else if (results.length < 12) plan("node_job_create", { scriptPath: "scripts/empty.mjs", name: `Stored terminal ${results.length - 2}`, timeoutSeconds: 5 });
      } else if (!summary && prompt.includes("deprecate")) {
        if (results.length === 0) plan("node_job_list", { status: "started", recentN: 10 });
        else if (results.length === 1) {
          const job = details?.jobs?.find(value => value.status === "started");
          assert(job && job.scriptPath.endsWith(".mjs")); plan("node_job_deprecate", { jobId: job.id });
        }
      } else if (!summary && prompt.includes("source check")) {
        if (results.length === 0) plan("node_job_list", { status: "deprecated", recentN: 10 });
        else if (results.length === 1) {
          const job = details?.jobs?.find(value => value.name === "Terminal service");
          assert(job && job.scriptPath.endsWith(".mjs")); plan("node_job_query", { jobId: job.id });
        }
      }
      const text = summary ? "Native terminal summary keeps background jobs and their workspace." : prompt.includes("history") ? "History fixture. ".repeat(1500) : "TERMINAL_DONE";
      const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), content: call ? [call] : [{ type: "text", text }], stopReason: call ? "toolUse" : "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  pi.on("session_start", event => record({ event: "start", reason: event.reason }));
  pi.on("tool_execution_end", event => {
    record({ event: "tool", error: event.isError });
    if (["node_job_create", "node_job_run", "node_job_deprecate", "node_job_query"].includes(event.toolName) && !event.isError) {
      record({ event: "job", job: event.result.details as JobView });
    }
  });
  pi.on("agent_settled", () => record({ event: "settled" }));
  pi.on("session_shutdown", event => record({ event: "shutdown", reason: event.reason }));
}
