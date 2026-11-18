import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { backgroundViews } from "./background.ts";

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
  let sessionId="";
  globalThis.fetch = async () => { record({ event: "network" }); throw new Error("No network in terminal fixtures"); };
  pi.registerProvider("scripts-terminal-fixture", {
    api: "scripts-terminal-fixture", apiKey: "local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Managed scripts terminal fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const userIndex = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[userIndex];
      const prompt = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
      const results = context.messages.slice(userIndex + 1).filter(message => message.role === "toolResult");
      const text = (index: number) => results[index]?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
      assert(results.every(value => !value.isError), "A terminal tool fixture failed");
      let call: ToolCall | undefined;
      const plan = (name: string, args: ToolCall["arguments"]) => { call = { type: "toolCall", id: `terminal-${results.length}`, name, arguments: args }; };
      if (prompt.includes("workspace")) {
        // Workspace phases also exercise the ordinary writer independently of CodeAnchor.
        const id = /^Job: (.+)$/mu.exec(text(0))?.[1];
        const work = /^Source directory: (.+)$/mu.exec(text(0))?.[1];
        if (results.length === 0) plan("script_job", {action:"create",purpose:"Terminal workspace"});
        else if (results.length === 1) { assert(work); plan("write", {path:join(work,"main.mjs"),content:'// WORKSPACE_SOURCE_VISIBLE\nconsole.log(["WORKSPACE","DONE"].join("_"));\n'}); }
        else if (results.length === 2) { assert(id); plan("script_js", {job:id,entry:"main.mjs",purpose:"Workspace execution",timeoutSeconds:5}); }
        else if (results.length === 3) { assert(id); plan("script_job", {action:"release",job:id}); }
      } else if(prompt.includes("background")) {
        if(results.length===0) plan("script_inline",{purpose:"Fixed panel service",code:'console.log(["PANEL","LIVE"].join("_"),process.pid);setInterval(()=>{},1000);',timeoutSeconds:2,background:{service:true}});
      } else if(prompt.includes("stop service")) {
        const job=backgroundViews(sessionId).find(value=>value.purpose==="Fixed panel service")?.details.background?.job;
        if(results.length===0){assert(job);plan("script_job",{action:"stop",job});}
        else if(results.length===1){assert(job);plan("script_job",{action:"release",job});}
      } else if(prompt.includes("unrelated")) {
        // A normal turn while the service stays active must not create another process.
      } else if (results.length === 0) {
        const childSource = 'for(let i=0;i<30;i++) console.log("STREAM_ROW_"+i); console.log(["TUI","EARLY"].join("_")); await new Promise(r=>setTimeout(r,2500)); console.error(["TUI","STDERR"].join("_")); console.log(["TUI","LATE"].join("_"));';
        const code = [
          "// INLINE_SOURCE_VISIBLE",
          'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME);',
          'await exec("git",["--version"],{timeoutSeconds:2});',
          ...Array.from({length:8},(_,index)=>`// source row ${index}`),
          `await exec(process.execPath,["--input-type=module","-e",${JSON.stringify(childSource)}],{timeoutSeconds:4});`,
          "// INLINE_SOURCE_END",
        ].join("\n");
        plan("script_inline", {purpose:"Terminal streaming fixture",code,timeoutSeconds:8});
      }
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        content: call ? [call] : [{type:"text",text:"TERMINAL_FINISHED"}], stopReason:call ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({type:"start",partial:message}); stream.push({type:"done",reason:call ? "toolUse" : "stop",message}); stream.end(); });
      return stream;
    },
  });
  pi.on("session_start", (event,ctx) => {sessionId=ctx.sessionManager.getSessionId();record({event:"start",reason:event.reason,tools:pi.getActiveTools()});});
  pi.on("tool_execution_end", event => record({event:"tool_end",error:event.isError}));
  pi.on("agent_settled", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) if (entry.type === "custom" && entry.customType === "temp-script-job") record({event:"job",root:(entry.data as {root:string}).root});
    record({event:"settled"});
  });
  pi.on("session_shutdown", event => record({event:"shutdown",reason:event.reason}));
  pi.registerCommand("scripts-checkpoint", {
    description:"Record isolated terminal state",
    async handler(_args, ctx) { record({event:"checkpoint",tools:pi.getActiveTools(),expanded:ctx.ui.getToolsExpanded()}); },
  });
}
