import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { assertMcpDisabled, validateConfig } from "../../skills/sync-pi-config/scripts/verify.ts";
import { ENTRY_TYPE, JOB_EVENT_MESSAGE, type JobEvent, type JobReference, type RunResult, type ExecutionDetails } from "./types.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "Managed-script acceptance must retain the configured model");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "temp-scripts-live-")));
const previousStorage = process.env.PI_TEMP_SCRIPTS_DIR;
process.env.PI_TEMP_SCRIPTS_DIR = join(temporary,"script-storage");
let session: AgentSession | undefined;
let phase = "loading isolated real Pi session";
let requests = 0;
let calls = 0;
const owned = new Map<string, JobReference>();
const events: AgentSessionEvent[] = [];
const recordedRuns = new Map<string, RunResult>();
const observedExecutions: ExecutionDetails[] = [];
let conflictJob: JobReference | undefined;
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] Managed scripts live: ${phase}; ${requests} requests, ${calls} tool calls\n`), 20_000);
try {
  assert(settings.defaultProvider && settings.defaultModel);
  await mkdir(join(temporary,".pi"));
  await writeFile(join(temporary,".pi","settings.json"),JSON.stringify({compaction:{enabled:false,keepRecentTokens:0,modelOverrides:{[`${settings.defaultProvider}/${settings.defaultModel}`]:{keepRecentTokens:0}}}}));
  const live = await createLiveSession({ packageDirectory, agentDirectory, cwd: temporary,
    extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts"), join(agentDirectory, "extensions", "code-anchor", "index.ts")],
    includeBuiltinTools: true,
    appendSystemPrompt: [
      "This acceptance test uses synthetic files only. Do not browse or use MCP.",
      "Only this temporary directory and jobs created during this acceptance test may change.",
      "Do not inspect credentials, unrelated projects, or other temporary directories. Do not install anything except explicitly requested job dependencies.",
      "Some test phases intentionally request failed execution. Report the observed failure without retries unless requested.",
    ],
    extensionFactories: [pi => {
      pi.on("before_provider_request", () => { requests++; });
      pi.registerTool({
        name: "same_job_conflict_probe", label: "Synthetic conflict probe", description: "Run the pre-authorized deterministic same-job exclusion probe", defaultActive: false,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, _input, signal, _update, ctx) {
          assert(conflictJob, "The harness must authorize a synthetic job before this probe");
          const args = { job: conflictJob.id, entry: "exclusive.mjs", purpose: "Synthetic same-job conflict", timeoutSeconds: 10 };
          const outcomes = await Promise.all([ctx.executeTool("script_js", args, { signal }), ctx.executeTool("script_js", args, { signal })]);
          assert.equal(outcomes.filter(value => value.isError).length, 1);
          return { content: [{ type: "text", text: "Exactly one workspace run succeeded and the duplicate rejected." }], details: undefined };
        },
      });
    }],
  });
  session = live.session;
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  const model = session.model;
  assert(model);
  assert.equal(model.provider, settings.defaultProvider);
  assert.equal(model.id, settings.defaultModel);
  const reasoning = live.settings.getModelThinkingLevel(model.provider, model.id) ?? live.settings.getDefaultThinkingLevel();
  assert.equal(session.thinkingLevel, reasoning);
  const refresh = () => {
    for (const entry of live.manager.getEntries()) if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const reference = entry.data as JobReference;
      owned.set(reference.id, reference);
    }
    for (const message of live.session.messages) {
      if (message.role !== "toolResult" || !["script_inline", "script_js"].includes(message.toolName)) continue;
      const saved: unknown = message.details;
      const details = saved as ExecutionDetails | undefined;
      if (details?.kind === "script-execution" && details.record && !recordedRuns.has(details.record.run)) {
        recordedRuns.set(details.record.run, details.record);
        observedExecutions.push(details);
      }
    }
  };
  session.subscribe(event => {
    if (event.type !== "message_update") events.push(event);
    if (event.type === "tool_execution_end") { calls++; refresh(); }
  });
  const run = async (label: string, prompt: string, required: string[], allowedFailures: string[] = []) => {
    phase = label;
    const offset = events.length;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void live.session.abort(); }, 120_000);
    try {
      await live.session.prompt(prompt);
      await live.session.waitForIdle();
      refresh();
      assert(!timedOut, `${label}: exceeded 120 seconds`);
      const turn = events.slice(offset);
      assert(turn.some(event => event.type === "agent_settled" && !event.aborted), `${label}: did not settle normally`);
      for (const event of turn) {
        if (event.type === "tool_execution_end" && event.isError) assert(allowedFailures.includes(event.toolName), `${label}: unexpected ${event.toolName} failure`);
        if (event.type === "message_end" && event.message.role === "assistant") {
          assert.equal(event.message.provider, model.provider);
          assert.equal(event.message.model, model.id);
          assert(!["error", "aborted", "length", "deferred"].includes(event.message.stopReason), `${label}: assistant did not finish normally`);
        }
      }
      for (const name of required) assert(turn.some(event => event.type === "tool_execution_end" && event.toolName === name), `${label}: missing ${name}`);
      assert.equal(live.session.thinkingLevel, reasoning);
      assert.equal(errors.length, 0, "Extension error; raw diagnostics withheld");
      console.log(`PASS: live ${label}`);
      return turn;
    } finally { clearTimeout(timer); }
  };
  const latest = (): JobReference => {
    const reference = [...owned.values()].at(-1);
    assert(reference);
    return reference;
  };
  const results = async (reference: JobReference): Promise<RunResult[]> => {
    const directory = join(reference.root, "runs");
    const output = [...recordedRuns.values()].filter(value => value.job === reference.id);
    if (existsSync(directory)) for (const name of await readdir(directory)) {
      const file = join(directory, name, "result.json");
      if (existsSync(file) && !output.some(value => value.run === join(directory,name))) output.push(JSON.parse(await readFile(file, "utf8")) as RunResult);
    }
    return output;
  };
  const monitor = async (label: string, prompt: string, reference: JobReference, action: "status" | "logs", status: ExecutionDetails["status"]) => {
    const jobsBefore = owned.size;
    const turn = await run(label, prompt, ["script_job"]);
    const starts = turn.flatMap(event => event.type === "tool_execution_start" ? [event] : []);
    assert.equal(starts.length, 1, "A single snapshot must not create helpers, read job files, or repeatedly poll");
    assert.equal(starts[0].toolName, "script_job");
    // The selected tool owns these validated arguments and result details.
    const input = starts[0].args as { action: string; job: string };
    assert.equal(input.action, action);
    assert.equal(input.job, reference.id);
    const completed = turn.find(event => event.type === "tool_execution_end" && event.toolName === "script_job");
    assert(completed?.type === "tool_execution_end");
    const details = completed.result.details as ExecutionDetails;
    assert.equal(details.status, status);
    assert.equal(owned.size, jobsBefore, "Routine monitoring must not create another managed job");
    return details;
  };
  const concurrencySource = `import {existsSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const [label,peer,phase]=process.argv.slice(2);
const path=name=>join(${JSON.stringify(temporary)},phase+"-"+name+".json");
writeFileSync(path(label+"-start"),JSON.stringify({pid:process.pid,time:Date.now()}));
const deadline=Date.now()+6000;
while(!existsSync(path(peer+"-start"))){if(Date.now()>deadline)throw new Error("Sibling did not start concurrently");await new Promise(r=>setTimeout(r,20));}
await new Promise(r=>setTimeout(r,750));
writeFileSync(path(label+"-end"),JSON.stringify({pid:process.pid,time:Date.now()}));
console.log("CONCURRENT_OK",label);`;
  const concurrencyPath = join(temporary, "concurrency.mjs");
  await writeFile(concurrencyPath, concurrencySource);
  const assertOverlap = async (label: string, turn: AgentSessionEvent[], names: string[]) => {
    assert(turn.some(event => event.type === "message_end" && event.message.role === "assistant"
      && event.message.content.filter(block => block.type === "toolCall" && names.includes(block.name)).length >= 2), "The model must submit sibling calls in one assistant message");
    const records = await Promise.all(["a", "b"].map(async name => {
      // Only the synthetic concurrency worker writes these timing records.
      const start = JSON.parse(await readFile(join(temporary, `${label}-${name}-start.json`), "utf8")) as { pid: number; time: number };
      const end = JSON.parse(await readFile(join(temporary, `${label}-${name}-end.json`), "utf8")) as typeof start;
      return { start, end };
    }));
    assert.notEqual(records[0].start.pid, records[1].start.pid);
    assert(Math.max(...records.map(value => value.start.time)) < Math.min(...records.map(value => value.end.time)), "Actual process lifetimes must overlap");
    for (const { start } of records) assert.throws(() => process.kill(start.pid, 0), /ESRCH/u);
  };
  console.log(`START: managed-script acceptance on ${model.provider}/${model.id}; reasoning ${reasoning}; real requests and approved registry downloads can incur charges`);
  for(const name of ["ls","find","grep"]) assert(session.getActiveToolNames().includes(name),`Missing configured dedicated tool ${name}`);
  await writeFile(join(temporary,"dedicated-tool.txt"),"DEDICATED_TOOL_MARKER\n");
  const fileTurn=await run("natural dedicated file tools","List the immediate entries in this directory, locate dedicated-tool.txt by filename, then find DEDICATED_TOOL_MARKER within it and report its line number. Do not execute commands or change files.",["ls","find","grep"]);
  assert(!fileTurn.some(event=>event.type==="tool_execution_end"&&["script_inline","script_js"].includes(event.toolName)));
  const gitTurn = await run("natural managed Git command", "Report the installed Git version using an executed command. Do not create a reusable workspace.", ["script_inline"]);
  assert(!gitTurn.some(event => event.type === "tool_execution_end" && event.toolName === "bash"));
  assert.equal(observedExecutions.at(-1)?.mode,"inline");
  assert.equal(observedExecutions.at(-1)?.retention?.state,"removed");
  assert(!existsSync(latest().root));
  await run("accepted nonzero cleanup", "Use one foreground script_inline helper to query an absent Git setting. Call managed exec with git arguments config, --file, absent-fixture.gitconfig, --get, core.hooksPath. Set allowFailure:true, inspect the returned exit code, and require exit code 1. Do not create the config file, a reusable workspace, or set keep:true.", ["script_inline"]);
  const accepted = observedExecutions.at(-1);
  assert(accepted);
  assert.equal(accepted?.retention?.state, "removed");
  assert(accepted.commands.some(command => command.status === "failed" && command.exitCode === 1 && command.failureAccepted));
  assert(!existsSync(latest().root));
  const inlineConcurrency = await run("concurrent foreground inline jobs", "Execute the existing concurrency.mjs twice with Node, using two separate foreground script_inline calls in the same assistant message. Pass a,b,inline to the first worker and b,a,inline to the second. Use managed exec with separate argument arrays and a ten-second child deadline. Set each total deadline to 15 seconds. The workers wait for each other, so do not await one tool result before issuing the other. Do not combine them inside one helper, use background, or keep:true.", ["script_inline"]);
  await assertOverlap("inline", inlineConcurrency, ["script_inline"]);
  const inlineOutcomes = inlineConcurrency.flatMap(event => event.type === "tool_execution_end" && event.toolName === "script_inline" ? [event.result.details as ExecutionDetails] : []);
  assert.equal(inlineOutcomes.length, 2);
  assert(inlineOutcomes.every(value => value.retention?.state === "removed" && value.record?.terminationConfirmed));
  if (process.platform !== "win32") {
    await mkdir(join(temporary,"node_modules",".bin"),{recursive:true});
    await symlink(process.execPath,join(temporary,"node_modules",".bin","project-path-fixture"));
    await writeFile(join(temporary,"compatibility.mjs"),'let input=""; for await(const chunk of process.stdin) input+=chunk; if(input!=="compatibility-input\\n" || process.argv[2]!=="literal $ ; space" || process.env.SCRIPT_OVERRIDE!=="enabled" || !process.env.PI_SESSION_ID || !process.env.PI_PROVIDER || !process.env.PI_MODEL) throw new Error("Compatibility fixture mismatch"); console.log("COMPATIBILITY_OK");\n');
    await run("PATH stdin environment and literal arguments", "Execute project-path-fixture from this project's node_modules/.bin by its bare command name. Pass compatibility.mjs and the literal argument 'literal $ ; space' as separate arguments. Supply stdin compatibility-input followed by a newline and environment override SCRIPT_OVERRIDE=enabled through the managed exec helper. It must print COMPATIBILITY_OK. Do not edit the fixture.", ["script_inline"]);
    assert((await results(latest())).some(value=>value.output.includes("COMPATIBILITY_OK")));
  }
  await writeFile(join(temporary, "server.mjs"), 'import http from "node:http"; const server=http.createServer((request,response)=>response.end("ok")); server.listen(0,"127.0.0.1",()=>{console.log("PROJECT_STARTED"); server.close();});\n');
  await writeFile(join(temporary, "project.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("project arithmetic",()=>assert.equal(20+22,42));\n');
  await run("project startup and unit tests", "Execute the existing server.mjs and project.test.mjs from this directory. The server closes itself. Use Node.js for startup and Node's test runner for the test. Report both observed results. Do not modify the project files.", ["script_inline"]);
  assert([...owned.values()].length >= 2);
  const projectRuns = (await Promise.all([...owned.values()].map(results))).flat();
  assert(projectRuns.some(value => value.output.includes("PROJECT_STARTED")));
  assert(projectRuns.some(value => /pass 1/u.test(value.output)));
  const expected = createHash("sha256").update(Array.from({ length: 100 }, (_, index) => String(index + 1)).join(",")).digest("hex");
  await run("natural inline JavaScript selection", "Use an executed program to compute SHA-256 of the UTF-8 string formed by integers 1 through 100 joined with commas and no trailing newline. Return only the digest. Do not create a reusable workspace.", ["script_inline"]);
  assert.equal(session.getLastAssistantText()?.trim(), expected);
  await run("explicit inline retention", "Run one inline JavaScript helper that prints KEEP_SOURCE and set keep:true so its source and logs remain available. Do not create a workspace.",["script_inline"]);
  const kept = latest();
  assert(existsSync(kept.root));
  assert.equal(observedExecutions.at(-1)?.retention?.state,"retained");
  const keptBefore = (await results(kept)).length;
  const jobsBeforeReuse = owned.size;
  await run("reuse retained inline source", `Use script_js to rerun the saved main.mjs in retained job ${kept.id}. Set purpose to exactly Reuse retained inline source and use a five-second deadline. Do not create another job or edit its source.`, ["script_js"]);
  assert.equal(owned.size, jobsBeforeReuse);
  assert.equal((await results(kept)).length, keptBefore + 1);
  const reused = JSON.parse(await readFile(join(kept.root, "manifest.json"), "utf8")) as { purpose: string; lastRunPurpose: string };
  assert.equal(reused.purpose, kept.purpose);
  assert.equal(reused.lastRunPurpose, "Reuse retained inline source");
  await session.reload();
  assert.equal((JSON.parse(await readFile(join(kept.root, "manifest.json"), "utf8")) as typeof reused).lastRunPurpose, reused.lastRunPurpose);
  await run("inline artifact retention", "Run one inline JavaScript helper that writes artifact.txt containing ARTIFACT_OK under PI_SCRIPT_ARTIFACTS. Do not set keep:true. Report its path.",["script_inline"]);
  assert(existsSync(latest().root));
  assert((await results(latest())).some(value=>existsSync(join(value.artifacts,"artifact.txt"))));
  await run("natural developed-workspace selection", "Develop and execute a reusable temporary JavaScript helper with two source modules. main.mjs must import format.mjs. Export format(value) from format.mjs, returning `before:${value}`. main.mjs must print format(42). Also create and run a Node test file for format. Keep the workspace for later correction. Do not use the project directory for helper source.", ["script_job", "write", "script_js"]);
  const job = latest();
  const work = join(job.root, "work");
  assert((await results(job)).some(value => value.status === "succeeded" && value.output.includes("before:42")));
  await writeFile(join(work, "lifecycle.mjs"), 'const {progress}=await import(process.env.PI_SCRIPT_RUNTIME);progress("LIFECYCLE_STARTED");await new Promise(r=>setTimeout(r,10000));progress("LIFECYCLE_PROGRESS");await new Promise(r=>setTimeout(r,3000));console.log("LIFECYCLE_FINAL");');
  const lifecycleOffset = events.length;
  const pushed = () => events.slice(lifecycleOffset).flatMap(event => {
    if (event.type !== "message_end" || event.message.role !== "custom" || event.message.customType !== JOB_EVENT_MESSAGE) return [];
    return (event.message.details as { events: JobEvent[] }).events.filter(value => value.job === job.id);
  });
  await run("event-driven background lifecycle", `Run lifecycle.mjs once in job ${job.id} using script_js with background {runtimeSeconds:30,readyUrl:""} and a five-second startup deadline. The empty readyUrl means no readiness check; this worker has no HTTP endpoint. Use test:false and keep its source unchanged. Acknowledge startup briefly. When pushed progress arrives, acknowledge it without tools. When the pushed final result arrives, reply with exactly LIFECYCLE_FINAL. Do not poll, read job files, sleep, create a monitor, or release this workspace.`, ["script_js"]);
  phase = "waiting for pushed lifecycle progress and final result";
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let stopEventWatch = () => {};
  try {
    await new Promise<void>((accept, reject) => {
      const check = () => { if (pushed().some(value => value.kind === "state" && value.status === "succeeded")) accept(); };
      stopEventWatch = live.session.subscribe(check);
      eventTimer = setTimeout(() => reject(new Error("No pushed final lifecycle result")), 60000);
      check();
    });
    await session.waitForIdle();
    refresh();
    assert(pushed().some(value => value.status === "preparing"));
    assert(pushed().some(value => value.status === "running"));
    assert(pushed().some(value => value.message === "LIFECYCLE_PROGRESS"));
    assert.equal(pushed().filter(value => value.kind === "state" && value.status === "succeeded").length, 1);
    assert.equal(session.getLastAssistantText()?.trim(), "LIFECYCLE_FINAL");
    const lifecycleTools = events.slice(lifecycleOffset).flatMap(event => event.type === "tool_execution_start" ? [event.toolName] : []);
    assert.deepEqual(lifecycleTools, ["script_js"], "Lifecycle reporting must not require polling tools or helper jobs");
    console.log("PASS: live proactive startup/progress/final callbacks; automatic continuation; no polling tools or helper jobs");
  } finally { clearTimeout(eventTimer); stopEventWatch(); }
  await writeFile(join(work, "concurrency.mjs"), concurrencySource);
  const mixedConcurrency = await run("concurrent inline workspace and inspection", `Submit three sibling calls in one assistant message. First, run concurrency.mjs in workspace job ${job.id} using foreground script_js with args a,b,mixed. Second, use a foreground script_inline helper and managed exec to run ${concurrencyPath} with Node and args b,a,mixed. Third, inspect job ${job.id} using script_job. Use 15-second total execution deadlines and a ten-second child deadline. These workers need to overlap. Do not use background or combine them into one helper.`, ["script_inline", "script_js", "script_job"]);
  await assertOverlap("mixed", mixedConcurrency, ["script_inline", "script_js"]);
  await writeFile(join(work, "exclusive.mjs"), 'console.log("EXCLUSIVE_STARTED",process.pid);await new Promise(r=>setTimeout(r,2000));console.log("EXCLUSIVE_FINISHED");');
  const exclusiveBefore = new Set((await results(job)).map(value => value.run));
  conflictJob = job;
  session.setActiveToolsByName([...session.getActiveToolNames(), "same_job_conflict_probe"]);
  const exclusiveTurn = await run("same-job concurrent rejection", "Call same_job_conflict_probe exactly once. The harness authorizes this synthetic regression. It must report one successful run and one rejected duplicate. Do not invoke script_js directly, retry, create jobs, or release anything.", ["same_job_conflict_probe", "script_js"], ["script_js"]);
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "same_job_conflict_probe"));
  conflictJob = undefined;
  const exclusiveOutcomes = exclusiveTurn.flatMap(event => event.type === "tool_execution_end" && event.toolName === "script_js" ? [event] : []);
  assert.equal(exclusiveOutcomes.length, 2);
  assert.equal(exclusiveOutcomes.filter(event => event.isError).length, 1);
  const exclusiveAfter = await results(job);
  assert.equal(exclusiveAfter.length, exclusiveBefore.size + 1);
  const exclusiveRun = exclusiveAfter.find(value => !exclusiveBefore.has(value.run));
  assert(exclusiveRun?.output.includes("EXCLUSIVE_FINISHED") && exclusiveRun.status === "succeeded" && exclusiveRun.terminationConfirmed);
  await run("CodeAnchor hashline correction and rerun", `Read ${join(work, "format.mjs")}, then use hashline edit to change the prefix before: to after:. Preserve all other source. Update the test through normal file tools if needed. Run main.mjs and its tests again in job ${job.id}.`, ["read", "edit", "script_js"]);
  assert((await results(job)).some(value => value.output.includes("after:42")));
  await run("AST preview and application", `Use ast_grep to find console.log($VALUE) in ${join(work, "main.mjs")}. Use ast_edit to stage console.log($VALUE) -> console.info($VALUE), review it, then apply through write xd://resolve. Rerun main.mjs in job ${job.id}.`, ["ast_grep", "ast_edit", "write", "script_js"]);
  await run("AST preview discard", `Stage console.info($VALUE) -> console.warn($VALUE) in ${join(work, "main.mjs")} using ast_edit, then discard through write xd://reject. Do not change files.`, ["ast_edit", "write"]);
  assert((await readFile(join(work, "main.mjs"), "utf8")).includes("console.info"));
  await session.prompt("/code-anchor off");
  await session.reload();
  await run("native editing and job reload", `Read ${join(work, "format.mjs")}, then use the native exact-text edit tool to change after: to native:. Preserve everything else. Run main.mjs in existing job ${job.id}. Do not run its old test for this phase.`, ["read", "edit", "script_js"]);
  assert((await results(job)).some(value => value.output.includes("native:42")));
  await run("real job-local dependencies", `Install exactly is-number@7.0.0 as a dependency of job ${job.id}. Create ${join(work, "dependency.mjs")} that imports is-number and prints DEPENDENCY_OK when isNumber(42) is true. Execute it. Retain the job and logs.`, ["script_job", "write", "script_js"]);
  assert(existsSync(join(job.root, "node_modules", "is-number", "package.json")));
  assert((await results(job)).some(value => value.output.includes("DEPENDENCY_OK")));
  const lock = await readFile(join(job.root, "package-lock.json"), "utf8");
  assert(!lock.includes("registry.npmjs.org"));
  await run("expected dependency rejection", `For test coverage, request is-number version ^7.0.0 through script_job dependencies in job ${job.id}, with a 10-second deadline. This is intentionally invalid. Report its rejection and do not retry.`, ["script_job"], ["script_job"]);
  await run("dependency recovery", `Restore the declared dependency is-number version 7.0.0 through script_job dependencies for job ${job.id}. Then execute dependency.mjs again.`, ["script_job", "script_js"]);
  const blocked = await run("blanket Bash preference and recovery", "Report Git's version. The native bash tool is blocked; use the supported managed execution route without retrying another shell.", ["script_inline"]);
  assert(!blocked.some(event => event.type === "tool_execution_end" && event.toolName === "bash"));
  // Deterministic integration forces direct and nested shell attempts. Live selection must not require the model to violate its guidance.
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "bash"));
  await run("Bash-disabled natural execution", "Use an executed program to list the squares of integers 1 through 5 as JSON. Do not create a reusable workspace.", ["script_inline"]);
  assert(!session.getActiveToolNames().includes("bash"));
  const streaming = await run("live native output streaming", "Run one inline JavaScript helper. Use the managed exec helper to launch Node.js code that prints STREAM_EARLY to stdout, prints STREAM_ERROR to stderr, waits two seconds, then prints STREAM_LATE. Do not print the returned output again. Use a five-second child deadline and a ten-second total deadline.", ["script_inline"]);
  const partials = streaming.flatMap(event => {
    if (event.type !== "tool_execution_update" || event.toolName !== "script_inline") return [];
    const partial = event.partialResult as { details?: ExecutionDetails };
    return [partial.details?.output ?? ""];
  });
  assert(partials.some(text => text.includes("STREAM_EARLY") && !text.includes("STREAM_LATE")));
  assert(partials.some(text => text.includes("STREAM_ERROR")));
  assert((await results(latest())).some(value => value.output.includes("STREAM_LATE")));
  assert(observedExecutions.at(-1)?.commands.some(command => command.status === "succeeded"));
  assert(observedExecutions.at(-1)?.source?.text.includes("exec"));
  const quiet = await run("real quiet-script heartbeat", "Run one inline JavaScript helper that waits 22 seconds with no stdout or stderr during the wait, then prints QUIET_FINISHED. Give it a 30-second execution deadline. Do not add a script heartbeat or create another monitor.", ["script_inline"]);
  assert(quiet.some(event => event.type === "tool_execution_update" && event.toolName === "script_inline" && /elapsed 20\.\ds/u.test(JSON.stringify(event.partialResult))), "The host must report progress while the actual script is quiet");
  await run("failure evidence", "Run one inline JavaScript helper that prints EXPECTED_FAILURE and sets process.exitCode=7. It must not throw. Use a five-second execution deadline. This failure is intentional; report it without retrying.", ["script_inline"], ["script_inline"]);
  assert((await results(latest())).some(value => value.status === "failed" && value.exitCode === 7 && value.output.includes("EXPECTED_FAILURE")));
  await run("deadline evidence", "Run one inline JavaScript helper that waits two seconds. Give it a 0.1-second execution deadline. This timeout is intentional; report it without retrying.", ["script_inline"], ["script_inline"]);
  assert((await results(latest())).some(value => value.status === "timed_out" && value.terminationConfirmed));
  phase = "cancelling an actual live-selected script";
  let requestedAbort = false;
  const interruptedCalls = new Set<string>();
  const interruptedOffset = new Set(owned.keys());
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_update" && event.toolName === "script_inline"
      && (event.partialResult as { details?: ExecutionDetails }).details?.output.includes("WAITING_INTERRUPTION")) {
      interruptedCalls.add(event.toolCallId);
      if (interruptedCalls.size === 2 && !requestedAbort) {
        requestedAbort = true;
        setTimeout(() => { void live.session.abort(); }, 150);
      }
    }
  });
  const abortTimer = setTimeout(() => { void live.session.abort(); }, 120_000);
  try {
    await session.prompt("Submit two separate foreground script_inline calls in the same assistant message. Each must print WAITING_INTERRUPTION and its PID, then wait 30 seconds. Give each a 40-second deadline. Do not combine them, use background, or await one before issuing the other. The harness will interrupt waiting after both actual processes print. Both jobs must continue until explicitly stopped. Do not retry.");
    await session.waitForIdle();
    refresh();
    assert(requestedAbort);
    const interruptedJobs = [...owned.values()].filter(reference => !interruptedOffset.has(reference.id));
    assert.equal(interruptedJobs.length, 2);
    assert(interruptedJobs.every(reference => existsSync(join(reference.root, "lease"))), "Both interrupted foreground processes must continue");
    console.log("PASS: live interruption released both waits while their owned foreground processes continued");
  } finally { clearTimeout(abortTimer); unsubscribe(); }
  const interruptedJobs = [...owned.values()].filter(reference => !interruptedOffset.has(reference.id));
  await run("stop interrupted foreground jobs", `Stop both jobs ${interruptedJobs.map(reference => reference.id).join(" and ")} using separate script_job stop calls in the same assistant message. Do not release them yet.`, ["script_job"]);
  for (const reference of interruptedJobs) assert((await results(reference)).some(value => value.status === "cancelled" && value.terminationConfirmed));

  const serviceTick=join(temporary,"live-service-tick.json");
  await writeFile(join(temporary, "live-service.mjs"), `import {appendFileSync} from "node:fs";let tick=0;setInterval(()=>{appendFileSync(${JSON.stringify(serviceTick)},JSON.stringify({pid:process.pid,tick:++tick})+"\\n");},50);console.log("LIVE_SERVICE_STARTED");`);
  await run("nonblocking background service", "Start the existing live-service.mjs with Node as a managed background service. Use script_inline, background service:true, and a five-second startup deadline. This worker only writes a file and has no HTTP endpoint; omit readyUrl entirely. Keep it running for later queries; do not detach child processes manually.",["script_inline"]);
  const serviceJob=latest();
  const waitTick=async()=>{
    const deadline=Date.now()+5000;
    while(!existsSync(serviceTick)){assert(Date.now()<deadline,"Service did not start");await new Promise(accept=>setTimeout(accept,20));}
    const line = (await readFile(serviceTick, "utf8")).split("\n").at(-2);
    assert(line, "The heartbeat must contain a complete record");
    return JSON.parse(line) as { pid: number; tick: number };
  };
  const beforeCompaction=await waitTick();
  await monitor("natural running-job status", `Has managed job ${serviceJob.id} finished yet? Check once and report its current state. Leave it running.`, serviceJob, "status", "running");
  const recent = await monitor("natural running-job output", `What has managed job ${serviceJob.id} printed most recently? Take one snapshot and leave it running.`, serviceJob, "logs", "running");
  assert(recent.output.includes("LIVE_SERVICE_STARTED"));
  await run("new query during background service","Reply with exactly QUERY_WHILE_RUNNING. Do not use tools.",[]);
  assert.equal(session.getLastAssistantText()?.trim(),"QUERY_WHILE_RUNNING");
  phase="native real-provider manual compaction with an active service";
  const compactTimer=setTimeout(()=>session?.abortCompaction(),120000);
  try{await session.compact();}catch(error){
    const message=error instanceof Error?error.message:"";
    console.error(JSON.stringify({compactionFailure:{nothingToCompact:/Nothing to compact|Already compacted/u.test(message),timeout:/timeout|timed out/iu.test(message),auth:/authentication|api key|unauthorized/iu.test(message),errorName:error instanceof Error?error.name:"unknown"}}));
    throw error;
  }finally{clearTimeout(compactTimer);}
  const afterCompaction=await waitTick();
  assert.equal(afterCompaction.pid,beforeCompaction.pid);
  assert(afterCompaction.tick>beforeCompaction.tick);
  await session.reload();
  assert.equal((await waitTick()).pid,beforeCompaction.pid);
  await run("background logs after native compaction and reload",`Use script_job logs for job ${serviceJob.id}. Confirm LIVE_SERVICE_STARTED without stopping it.`,["script_job"]);
  await run("explicit service shutdown",`Stop background job ${serviceJob.id} using script_job stop. Preserve its logs until final release.`,["script_job"]);
  assert((await results(serviceJob)).some(value=>value.status==="cancelled"&&value.terminationConfirmed));
  await monitor("natural stopped-job completion", `Has managed job ${serviceJob.id} finished now, and how did it stop? Check once and report. Preserve its records.`, serviceJob, "status", "cancelled");
  const reservation = createServer();
  await new Promise<void>((accept, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", accept);
  });
  const address = reservation.address();
  await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  assert(address && typeof address !== "string");
  const readyUrl = `http://127.0.0.1:${address.port}/ready`;
  await writeFile(join(temporary, "live-http-service.mjs"), `import http from "node:http";http.createServer((request,response)=>{response.statusCode=request.url==="/ready"?200:404;response.end("LIVE_HTTP_OK");}).listen(${address.port},"127.0.0.1",()=>console.log("LIVE_HTTP_STARTED"));`);
  const httpTurn = await run("background HTTP readiness", `Start the existing live-http-service.mjs with Node through script_inline as a managed service. Use background service:true with the known readyUrl ${readyUrl} and a five-second startup deadline. Keep it running for the next check.`, ["script_inline"]);
  const httpJob = latest();
  const httpResult = httpTurn.findLast(event => event.type === "tool_execution_end" && event.toolName === "script_inline");
  assert(httpResult?.type === "tool_execution_end");
  assert.equal((httpResult.result.details as ExecutionDetails).background?.readiness, "ready");
  const response = await fetch(readyUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "LIVE_HTTP_OK");
  await run("stop ready HTTP service", `Stop job ${httpJob.id} through script_job stop. Preserve its records until final release.`, ["script_job"]);
  assert((await results(httpJob)).some(value => value.status === "cancelled" && value.terminationConfirmed));
  await run("pin and retained evidence", `Pin job ${job.id}. Inspect it and report its retention state. Do not delete anything.`, ["script_job"]);
  assert.equal((JSON.parse(await readFile(join(job.root, "manifest.json"), "utf8")) as { state: string }).state, "pinned");
  await session.prompt("/temp-scripts off");
  assert(!session.getActiveToolNames().includes("script_inline"));
  assert(existsSync(job.root));
  await session.reload();
  assert(!session.getActiveToolNames().includes("script_inline"));
  session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
  await run("disabled native Bash restoration", "Use bash to report Git's version with a five-second timeout. Managed scripts are disabled in this phase.", ["bash"]);
  await session.prompt("/temp-scripts on");
  assert(session.getActiveToolNames().includes("script_inline"));
  await run("re-enabled managed execution", "Report Git's version through the supported execution route. Managed scripts are now enabled again.", ["script_inline"]);
  await run("release and exact cleanup", "All acceptance evidence has now been checked. List remaining jobs, then release them together using jobs:[ids]. Release deletes each job immediately. You may delete their source, dependencies, artifacts, and logs. Do not delete this session directory or anything else.", ["script_job"]);
  for (const reference of owned.values()) assert(!existsSync(reference.root), `Job was not removed: ${reference.id}`);
  assert.equal(errors.length, 0);
  console.log(`PASS: real-provider selection; commands/startup/tests; authoring; dependencies; shell gates; output/deadlines; interruption; services/readiness; native compaction/reload; release/cleanup; ${requests} requests, ${calls} tool calls`);
} catch (error) {
  if (phase.includes("background") || phase.includes("service") || phase.includes("workspace")) {
    // These sources use synthetic fixtures only. Provider diagnostics remain private.
    const backgroundCalls = events.flatMap(event => {
      if (event.type !== "tool_execution_start" || !["script_inline", "script_js"].includes(event.toolName)) return [];
      const input = event.args as { background?: object | false; timeoutSeconds?: number; code?: string; entry?: string };
      return input.background ? [{ tool: event.toolName, background: input.background, timeoutSeconds: input.timeoutSeconds, source: input.code, entry: input.entry }] : [];
    });
    const toolErrors = events.flatMap(event => {
      if (event.type !== "tool_execution_end" || !event.isError) return [];
      const content: ToolResultMessage["content"] = event.result.content;
      return [{ tool: event.toolName, text: content.filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 2000) }];
    });
    console.error(JSON.stringify({ backgroundCalls: backgroundCalls.slice(-2), toolErrors: toolErrors.slice(-2) }));
  }
  console.error(JSON.stringify({ phase, requests, calls, failure: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "Unknown failure", executionStates:observedExecutions.slice(-3).map(value=>({mode:value.mode,status:value.status,background:value.background,retention:value.retention,truncated:value.record?.truncated,commands:value.commands.map(command=>({status:command.status,truncated:command.truncated}))})),executionFlags:events.flatMap(event=>event.type==="tool_execution_start"&&event.toolName==="script_inline"?[{background:(event.args as {background?:object}).background,keep:(event.args as {keep?:boolean}).keep}]:[]) }));
  throw new Error(`Managed-script live acceptance failed during ${phase}; private diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
  if (previousStorage === undefined) delete process.env.PI_TEMP_SCRIPTS_DIR;
  else process.env.PI_TEMP_SCRIPTS_DIR = previousStorage;
  try { if (session) await closeLiveSession(session); }
  finally {
    for (const reference of owned.values()) {
      assert(!existsSync(join(reference.root, "lease")), `Unresolved process lease retained: ${reference.id}`);
      await rm(reference.root, { recursive: true, force: true, maxRetries: 3 });
      assert(!existsSync(reference.root));
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    console.log("CLEANUP: live session stopped; owned scripts, dependencies, logs, and fixtures removed");
  }
}
