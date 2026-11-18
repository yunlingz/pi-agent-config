import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testUI } from "../../scripts/test-fixtures.ts";
const BACKGROUND_WIDGET = "temp-scripts-background";
import type { ExecutionDetails, JobReference } from "./types.ts";

const installation = resolve(process.argv[2] ?? "");
assert(process.argv[2],"Usage: node verify-background.ts <installed-pi-package-directory>");
const sdk:typeof import("@earendil-works/pi-coding-agent")=await import(pathToFileURL(join(installation,"dist/index.js")).href);
const ai:typeof import("@earendil-works/pi-ai")=await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai",installation)).href);
const temporary=await mkdtemp(join(tmpdir(),"scripts-native-lifecycle-"));
const previousStorage=process.env.PI_TEMP_SCRIPTS_DIR;
process.env.PI_TEMP_SCRIPTS_DIR=join(temporary,"storage");
let session:AgentSession|undefined;
const owned=new Set<string>();
const originalFetch=globalThis.fetch;
const events:AgentSessionEvent[]=[];
let phase="loading native Pi without compaction extensions";
const heartbeat=setInterval(()=>process.stderr.write(`[${new Date().toISOString()}] Job continuity: ${phase}\n`),20000);
const wait=async(predicate:()=>boolean|Promise<boolean>,label:string)=>{
  const deadline=Date.now()+8000;
  while(!await predicate()){assert(Date.now()<deadline,`Timed out: ${label}`);await new Promise(accept=>setTimeout(accept,20));}
};
try{
  globalThis.fetch=async()=>{throw new Error("This local fixture must not call the network");};
  const settings=sdk.SettingsManager.inMemory({extensions:["-builtin:mcp"],packages:[],retry:{enabled:false},compaction:{enabled:false,reserveTokens:1000,keepRecentTokens:0}});
  const runtime=await sdk.ModelRuntime.create({authPath:join(temporary,"auth.json"),modelsPath:null,modelsStorePath:join(temporary,"models-store.json"),allowModelNetwork:false,refreshOnCreate:false});
  let pending:ToolCall|undefined;
  let highUsage=false;
  let slow=false;
  let summaryRequests=0;
  runtime.registerProvider("scripts-lifecycle-fixture",{
    api:"scripts-lifecycle-fixture",apiKey:"unused",baseUrl:"http://127.0.0.1:1",
    models:[{id:"fixture",name:"Native lifecycle fixture",reasoning:false,input:["text"],contextWindow:64000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,context,options){
      const stream=ai.createAssistantMessageEventStream();
      const call=pending;pending=undefined;
      const summary=JSON.stringify(context).includes("conversation to summarize") || JSON.stringify(context).includes("structured summary") || JSON.stringify(context).includes("summarization assistant");
      if(summary)summaryRequests++;
      const input=highUsage && !summary?63500:100;
      highUsage=false;
      const message:AssistantMessage={role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:call?[call]:[{type:"text",text:summary?"## Goal\nPreserve running job markers and continue.\n## Progress\nNative summary fixture completed.":"NORMAL_QUERY_OK"}],stopReason:call?"toolUse":"stop",usage:{input,output:10,cacheRead:0,cacheWrite:0,totalTokens:input+10,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const timer=setTimeout(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason:call?"toolUse":"stop",message});stream.end();},summary||slow?250:0);
      slow=false;
      options?.signal?.addEventListener("abort",()=>{clearTimeout(timer);const aborted={...message,stopReason:"aborted" as const};stream.push({type:"error",reason:"aborted",error:aborted});stream.end();},{once:true});
      return stream;
    },
  });
  const loader=new sdk.DefaultResourceLoader({cwd:temporary,agentDir:temporary,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noContextFiles:true,noPromptTemplates:true,disabledBuiltinExtensions:["mcp"],additionalExtensionPaths:[join(dirname(fileURLToPath(import.meta.url)),"index.ts")]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);assert.equal(loader.getExtensions().extensions.length,1);
  const manager=sdk.SessionManager.create(temporary,join(temporary,"sessions"));
  ({session}=await sdk.createAgentSession({cwd:temporary,agentDir:temporary,settingsManager:settings,modelRuntime:runtime,model:runtime.getModel("scripts-lifecycle-fixture","fixture"),thinkingLevel:"off",resourceLoader:loader,sessionManager:manager}));
  const errors:unknown[]=[];
  const widgets=new Map<string,unknown>();
  await session.bindExtensions({mode:"tui",uiContext:testUI(session,{setWidget(key,value){if(value===undefined)widgets.delete(key);else widgets.set(key,value);},notify(){}}),onError:error=>errors.push(error)});
  session.subscribe(event=>{if(event.type!=="message_update")events.push(event);});
  let sequence=0;
  const execute=async(name:string,args:ToolCall["arguments"],expectedError=false)=>{
    const id=`lifecycle-${++sequence}`;pending={type:"toolCall",id,name,arguments:args};
    await session?.prompt("Execute the planned local fixture.");
    for(const entry of manager.getEntries())if(entry.type==="custom"&&entry.customType==="temp-script-job")owned.add((entry.data as JobReference).root);
    const message=session?.messages.findLast(value=>value.role==="toolResult"&&value.toolCallId===id);
    assert(message?.role==="toolResult");
    assert.equal(message.isError,expectedError,message.content.filter(block=>block.type==="text").map(block=>block.text).join("\n"));
    return message;
  };
  const refs=()=>manager.getEntries().flatMap(entry=>entry.type==="custom"&&entry.customType==="temp-script-job"?[entry.data as JobReference]:[]);
  const tickCode=(path:string)=>`import {writeFileSync,renameSync} from "node:fs"; let tick=0; const path=${JSON.stringify(path)}; function write(){writeFileSync(path+".next",JSON.stringify({pid:process.pid,tick:++tick}));renameSync(path+".next",path);} write();setInterval(write,30);console.log("SERVICE_STARTED");`;
  const ticks=async(path:string)=>JSON.parse(await readFile(path,"utf8")) as {pid:number;tick:number};
  const inlineTick=join(temporary,"inline-tick.json");
  phase="nonblocking inline background service";
  const start=Date.now();
  const inlineStart=await execute("script_inline",{purpose:"Inline background",code:tickCode(inlineTick),timeoutSeconds:3,background:{service:true}});
  assert(Date.now()-start<3000);
  const inlineDetails=inlineStart.details as unknown;
  assert((inlineDetails as ExecutionDetails).background);
  const inline=refs().at(-1);assert(inline);
  await wait(()=>existsSync(inlineTick),"inline heartbeat");
  assert(session.isIdle);
  const before=await ticks(inlineTick);
  await session.prompt("A new unrelated user query.");
  assert.equal(session.getLastAssistantText(),"NORMAL_QUERY_OK");
  await wait(async()=> (await ticks(inlineTick)).tick>before.tick,"heartbeat after unrelated query");
  await wait(()=>widgets.has(BACKGROUND_WIDGET),"fixed background panel");
  await execute("script_job",{action:"release",job:inline.id},true);
  slow=true;
  const later=session.prompt("Cancel only this later request.");
  setTimeout(()=>{void session?.abort();},50);await later;
  assert((await ticks(inlineTick)).tick>=before.tick);
  phase="native manual compaction while inline and workspace processes run";
  await execute("script_job",{action:"create",purpose:"Workspace background"});
  const workspace=refs().at(-1);assert(workspace);
  const workspaceTick=join(temporary,"workspace-tick.json");
  await writeFile(join(workspace.root,"work","main.mjs"),tickCode(workspaceTick));
  await execute("script_js",{job:workspace.id,purpose:"Workspace background",entry:"main.mjs",timeoutSeconds:3,background:{runtimeSeconds:60}});
  await wait(()=>existsSync(workspaceTick),"workspace heartbeat");
  for(let turn=0;turn<8;turn++){
    manager.appendMessage({role:"user",content:`Synthetic turn ${turn}. ${"context ".repeat(500)}`,timestamp:Date.now()});
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"Historical fixture."}],api:"scripts-lifecycle-fixture",provider:"scripts-lifecycle-fixture",model:"fixture",stopReason:"stop",timestamp:Date.now(),usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  }
  const pids=[(await ticks(inlineTick)).pid,(await ticks(workspaceTick)).pid];
  const manualBefore=(await ticks(inlineTick)).tick;
  await session.compact();
  assert(events.some(event=>event.type==="compaction_end"&&event.reason==="manual"&&!event.aborted));
  assert((await ticks(inlineTick)).tick>manualBefore);
  assert.deepEqual([(await ticks(inlineTick)).pid,(await ticks(workspaceTick)).pid],pids);
  phase="native automatic threshold compaction";
  settings.setCompactionEnabled(true);
  highUsage=true;
  const eventOffset=events.length;
  await session.prompt("Trigger the fixture's native usage threshold, without invoking a compaction tool.");
  await session.waitForIdle();
  assert(events.slice(eventOffset).some(event=>event.type==="compaction_end"&&event.reason==="threshold"&&!event.aborted),"Native automatic compaction did not run");
  settings.setCompactionEnabled(false);
  assert.deepEqual([(await ticks(inlineTick)).pid,(await ticks(workspaceTick)).pid],pids);
  assert(widgets.has(BACKGROUND_WIDGET));
  phase="foreground waiting interrupted by actual native manual compaction";
  const foregroundTick=join(temporary,"foreground-tick.json");
  const foreground=execute("script_inline",{purpose:"Foreground compaction continuity",code:tickCode(foregroundTick),timeoutSeconds:30});
  await wait(()=>existsSync(foregroundTick),"foreground heartbeat");
  const foregroundPid=(await ticks(foregroundTick)).pid;
  await session.compact();
  await foreground;
  assert.equal((await ticks(foregroundTick)).pid,foregroundPid);
  const foregroundRef=refs().at(-1);assert(foregroundRef);
  await execute("script_job",{action:"status",job:foregroundRef.id});
  phase="reload retains exact process identity and owned logs";
  await session.reload();
  assert.deepEqual([(await ticks(inlineTick)).pid,(await ticks(workspaceTick)).pid],pids);
  const logs=await execute("script_job",{action:"logs",job:inline.id});
  assert(logs.content.some(block=>block.type==="text"&&block.text.includes("SERVICE_STARTED")));
  await execute("script_job",{action:"stop",job:inline.id});
  await execute("script_job",{action:"stop",job:workspace.id});
  await execute("script_job",{action:"stop",job:foregroundRef.id});
  for(const pid of [...pids,foregroundPid])assert.throws(()=>process.kill(pid,0),/ESRCH/u);
  await execute("script_job",{action:"release",jobs:[inline.id,workspace.id,foregroundRef.id]});
  phase="session replacement stops owned service";
  const exitTick=join(temporary,"exit-tick.json");
  await execute("script_inline",{purpose:"Session change fixture",code:tickCode(exitTick),timeoutSeconds:3,background:{service:true}});
  await wait(()=>existsSync(exitTick),"session change process");
  const exitPid=(await ticks(exitTick)).pid;
  const runner=session.extensionRunner;
  await runner.emit({type:"session_shutdown",reason:"new"});
  assert.throws(()=>process.kill(exitPid,0),/ESRCH/u);
  assert.deepEqual(errors,[]);
  assert(manager.getEntries().filter(entry=>entry.type==="compaction").length>=3);
  console.log(`PASS: native manual/automatic compaction with no auto-compact/parallel-compact/CodeAnchor; nonblocking queries; foreground handoff; panel; cancellation independence; exact PID continuity; reload; logs/stop/release; session replacement; ${summaryRequests} recognized local summary requests`);
}finally{
  clearInterval(heartbeat);
  globalThis.fetch=originalFetch;
  try{if(session){await session.abort();await session.waitForIdle();await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});session.dispose();}}
  finally{
    for(const root of owned){assert(!existsSync(join(root,"lease")),`Unresolved owned process lease: ${root}`);await rm(root,{recursive:true,force:true});}
    if(previousStorage===undefined)delete process.env.PI_TEMP_SCRIPTS_DIR;else process.env.PI_TEMP_SCRIPTS_DIR=previousStorage;
    await rm(temporary,{recursive:true,force:true});assert(!existsSync(temporary));
    console.log("CLEANUP: native lifecycle session, processes and isolated storage removed");
  }
}
