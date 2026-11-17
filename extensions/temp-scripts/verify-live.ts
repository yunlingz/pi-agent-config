import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { assertMcpDisabled, validateConfig } from "../../skills/sync-pi-config/scripts/verify.ts";
import { ENTRY_TYPE, type JobReference, type RunResult } from "./types.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "Managed-script acceptance must retain the configured model");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
const temporary = await mkdtemp(join(tmpdir(), "temp-scripts-live-"));
let session: AgentSession | undefined;
let phase = "loading isolated real Pi session";
let requests = 0;
let calls = 0;
const owned = new Map<string, JobReference>();
const events: AgentSessionEvent[] = [];
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] Managed scripts live: ${phase}; ${requests} requests, ${calls} tool calls\n`), 20_000);
try {
  const live = await createLiveSession({ packageDirectory, agentDirectory, cwd: temporary,
    extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts"), join(agentDirectory, "extensions", "code-anchor", "index.ts")],
    includeBuiltinTools: true,
    appendSystemPrompt: [
      "This acceptance test uses synthetic files only. Do not browse or use MCP.",
      "Only this temporary directory and jobs created during this acceptance test may change.",
      "Do not inspect credentials, unrelated projects, or other temporary directories. Do not install anything except explicitly requested job dependencies.",
      "Some test phases intentionally request failed execution. Report the observed failure without retries unless requested.",
    ],
    extensionFactories: [pi => { pi.on("before_provider_request", () => { requests++; }); }],
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
    const output: RunResult[] = [];
    for (const name of await readdir(directory)) {
      const file = join(directory, name, "result.json");
      if (existsSync(file)) output.push(JSON.parse(await readFile(file, "utf8")) as RunResult);
    }
    return output;
  };
  console.log(`START: managed-script acceptance on ${model.provider}/${model.id}; reasoning ${reasoning}; real requests and approved registry downloads can incur charges`);
  const gitTurn = await run("natural managed Git command", "Report the installed Git version using an executed command. Do not create a reusable workspace.", ["script_inline"]);
  assert(!gitTurn.some(event => event.type === "tool_execution_end" && event.toolName === "bash"));
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
  await run("natural developed-workspace selection", "Develop and execute a reusable temporary JavaScript helper with two source modules. main.mjs must import format.mjs. Export format(value) from format.mjs, returning `before:${value}`. main.mjs must print format(42). Also create and run a Node test file for format. Keep the workspace for later correction. Do not use the project directory for helper source.", ["script_job", "write", "script_js"]);
  const job = latest();
  const work = join(job.root, "work");
  assert((await results(job)).some(value => value.status === "succeeded" && value.output.includes("before:42")));
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
  await run("PowerShell rejection in managed execution", "Run one inline JavaScript test using the managed runtime exec helper. Attempt pwsh with argument --version, then powershell.exe with argument --version. Catch each expected rejection and print POWERSHELL_BLOCKED for each. Do not launch either through raw child_process or another program.", ["script_inline"]);
  assert((await results(latest())).some(value => value.output.match(/POWERSHELL_BLOCKED/gu)?.length === 2));
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "bash"));
  await run("Bash-disabled natural execution", "Use an executed program to list the squares of integers 1 through 5 as JSON. Do not create a reusable workspace.", ["script_inline"]);
  assert(!session.getActiveToolNames().includes("bash"));
  const streaming = await run("live native output streaming", "Run one inline JavaScript helper. Use the managed exec helper to launch Node.js code that prints STREAM_EARLY to stdout, prints STREAM_ERROR to stderr, waits two seconds, then prints STREAM_LATE. Do not print the returned output again. Use a five-second child deadline and a ten-second total deadline.", ["script_inline"]);
  const partials = streaming.flatMap(event => event.type === "tool_execution_update" && event.toolName === "script_inline" ? [JSON.stringify(event.partialResult)] : []);
  assert(partials.some(text => text.includes("STREAM_EARLY") && !text.includes("STREAM_LATE")));
  assert(partials.some(text => text.includes("STREAM_ERROR")));
  assert((await results(latest())).some(value => value.output.includes("STREAM_LATE")));
  const quiet = await run("real quiet-script heartbeat", "Run one inline JavaScript helper that waits 22 seconds with no stdout or stderr during the wait, then prints QUIET_FINISHED. Give it a 30-second execution deadline. Do not add a script heartbeat or create another monitor.", ["script_inline"]);
  assert(quiet.some(event => event.type === "tool_execution_update" && event.toolName === "script_inline" && /elapsed 20\.\ds/u.test(JSON.stringify(event.partialResult))), "The host must report progress while the actual script is quiet");
  await run("failure evidence", "Run one inline JavaScript helper that prints EXPECTED_FAILURE and sets process.exitCode=7. It must not throw. Use a five-second execution deadline. This failure is intentional; report it without retrying.", ["script_inline"], ["script_inline"]);
  assert((await results(latest())).some(value => value.status === "failed" && value.exitCode === 7 && value.output.includes("EXPECTED_FAILURE")));
  await run("deadline evidence", "Run one inline JavaScript helper that waits two seconds. Give it a 0.1-second execution deadline. This timeout is intentional; report it without retrying.", ["script_inline"], ["script_inline"]);
  assert((await results(latest())).some(value => value.status === "timed_out" && value.terminationConfirmed));
  phase = "cancelling an actual live-selected script";
  let requestedAbort = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_update" && event.toolName === "script_inline" && !requestedAbort) {
      requestedAbort = true;
      setTimeout(() => { void live.session.abort(); }, 150);
    }
  });
  const abortTimer = setTimeout(() => { void live.session.abort(); }, 120_000);
  try {
    await session.prompt("Run one inline JavaScript helper that waits 30 seconds before printing CANCEL_UNEXPECTED. Give it a 40-second execution deadline. The harness will cancel the tool during execution; do not retry.");
    await session.waitForIdle();
    refresh();
    assert(requestedAbort);
    assert((await results(latest())).some(value => value.status === "cancelled" && value.terminationConfirmed));
    console.log("PASS: live cancellation stopped the selected process and retained its run record");
  } finally { clearTimeout(abortTimer); unsubscribe(); }
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
  await run("release and exact cleanup", "All acceptance evidence has now been checked. Release every managed job in this session, then clean each immediately. You may delete their scripts, dependency files, logs, and artifacts. Do not delete this session directory or anything else.", ["script_job"]);
  for (const reference of owned.values()) assert(!existsSync(reference.root), `Job was not removed: ${reference.id}`);
  assert.equal(errors.length, 0);
  console.log(`PASS: real-provider selection, managed Git/project startup/tests, authoring, AST, reload, dependency installation/rejection/recovery, blanket Bash/PowerShell gates, Bash-disabled execution, quiet progress, failures, deadlines, cancellation, pin/release/cleanup; ${requests} requests, ${calls} tool calls`);
} catch (error) {
  console.error(JSON.stringify({ phase, requests, calls, failure: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "Unknown failure" }));
  throw new Error(`Managed-script live acceptance failed during ${phase}; private diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
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
