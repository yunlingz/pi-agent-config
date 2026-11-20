import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import type { Job, Query } from "./types.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "Use the configured model without substitution");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const root = await realpath(await mkdtemp(join(tmpdir(), "node-scripts-live-")));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
let session: AgentSession | undefined;
let phase = "loading isolated configured-model session";
let requests = 0;
let prompts = 0;
let tools = 0;
let compactions = 0;
const began = Date.now();
const events: AgentSessionEvent[] = [];
const errors: unknown[] = [];
const heartbeat = setInterval(() => console.error(`[${new Date().toISOString()}] node-scripts extended live: ${phase}; ${requests} requests, ${prompts} prompts, ${tools} tool calls`), 20000);
try {
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 300 } }));
  await writeFile(join(root, "pi-node-scripts.json"), JSON.stringify({ rootFolder: join(root, "workspaces"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }));
  const live = await createLiveSession({ packageDirectory, agentDirectory, cwd: root, includeBuiltinTools: true,
    extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
    appendSystemPrompt: [
      "This test uses only synthetic files and this session's node-scripts workspace. Do not browse or use MCP.",
      "Do not inspect credentials or unrelated files. Only install the explicitly requested workspace dependency.",
      "Do not retry intentional failures unless asked. Keep created jobs and logs; deprecating them does not delete evidence.",
    ],
    extensionFactories: [pi => { pi.on("before_provider_request", () => { requests++; }); }],
  });
  const model = live.session.model;
  assert(model);
  assert.equal(model.provider, live.settings.getDefaultProvider());
  assert.equal(model.id, live.settings.getDefaultModel());
  const effort = live.session.thinkingLevel;
  const bind = async (value: AgentSession) => {
    session = value;
    await value.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    value.subscribe(event => {
      if (event.type !== "message_update") events.push(event);
      if (event.type === "tool_execution_end") tools++;
    });
  };
  await bind(live.session);
  assert(session);
  const workspace = join(root, "workspaces", live.manager.getSessionId());
  const records = async () => Promise.all((await readdir(join(workspace, "jobs"))).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(workspace, "jobs", name), "utf8")) as Job));
  const named = async (name: string) => {
    const matching = (await records()).filter(job => job.name === name);
    assert.equal(matching.length, 1, `Expected one job named ${name}`);
    return matching[0];
  };
  const run = async (label: string, prompt: string, required: string[], allowed: string[] = []) => {
    assert(session);
    const current = session;
    phase = label;
    prompts++;
    const start = events.length;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void current.abort(); }, 120000);
    try {
      await current.prompt(prompt);
      await current.waitForIdle();
      const turn = events.slice(start);
      assert(!timedOut && turn.some(event => event.type === "agent_settled" && !event.aborted), `${label}: did not settle normally`);
      for (const event of turn) {
        if (event.type === "tool_execution_end" && event.isError) assert(allowed.includes(event.toolName), `${label}: unexpected ${event.toolName} failure`);
        if (event.type === "message_end" && event.message.role === "assistant") {
          assert.equal(event.message.provider, model.provider);
          assert.equal(event.message.model, model.id);
          assert(!["error", "aborted", "length"].includes(event.message.stopReason));
        }
      }
      for (const name of required) assert(turn.some(event => event.type === "tool_execution_end" && event.toolName === name), `${label}: missing ${name}`);
      assert.equal(current.thinkingLevel, effort);
      assert.deepEqual(errors, []);
      console.log(`PASS: live ${label}`);
      return turn;
    } finally { clearTimeout(timer); }
  };
  const compact = async (label: string) => {
    assert(session);
    phase = label;
    populateSplitHistory(session.sessionManager, model, `NODE_${compactions}`);
    const current = session;
    const timer = setTimeout(() => current.abortCompaction(), 120000);
    try { await current.compact(); compactions++; }
    finally { clearTimeout(timer); }
  };
  console.log(`START: ${model.provider}/${model.id}; effort ${effort}; extended multi-turn acceptance; real requests and approved npm downloads can incur charges`);
  const digest = createHash("sha256").update("node-scripts-esm").digest("hex");
  await run("natural ESM author/create/run", "Use an executed Node program to compute SHA-256 of exactly node-scripts-esm as UTF-8 without a newline. Return only the digest. Use this session's workspace and the supported tools. Keep the script and evidence.", ["node_job_create", "node_job_run"]);
  assert.equal(session.getLastAssistantText()?.trim(), digest);
  const first = (await records())[0];
  assert(first && first.scriptPath.endsWith(".mjs") && first.status === "finished");
  const firstPath = join(workspace, first.scriptPath);
  const firstHash = createHash("sha256").update(await readFile(firstPath)).digest("hex");
  assert.equal(first.scriptSha256AtStart, firstHash);
  await run("query and no rerun", `Query job ${first.id}, then intentionally try to run it again once. Report the single-use rejection without retrying or making another job.`, ["node_job_query", "node_job_run"], ["node_job_run"]);
  const reuseTurn = await run("reuse and focused source edit", `Read the existing ${firstPath}. Add a short comment about its input. Adapt it to accept the string as an argument if needed. Compute SHA-256 of exactly node-scripts-reused without a newline. Reuse this file through a new job named Reused digest, timeoutSeconds:5. Do not copy or rewrite it with write. Return only the digest.`, ["read", "edit", "node_job_create", "node_job_run"]);
  assert(!reuseTurn.some(event => event.type === "tool_execution_end" && event.toolName === "write"));
  assert.equal(session.getLastAssistantText()?.trim(), createHash("sha256").update("node-scripts-reused").digest("hex"));
  const reused = await named("Reused digest");
  assert.equal(reused.scriptPath, first.scriptPath); assert.notEqual(reused.scriptSha256AtStart, firstHash);
  await run("query changed source", `Query job ${first.id} and job ${reused.id}. Report their source comparison states without executing anything.`, ["node_job_query"]);
  const sourceResults = events.flatMap(event => event.type === "tool_execution_end" && event.toolName === "node_job_query" ? [event.result.details as Query] : []);
  assert(sourceResults.some(job => job.id === first.id && job.sourceState === "changed" && job.scriptSha256AtStart === firstHash));
  assert(sourceResults.some(job => job.id === reused.id && job.sourceState === "same"));
  await run("delete source and retain evidence", `Remove only ${firstPath} with rm. Query jobs ${first.id} and ${reused.id}. Confirm their source is missing while finished status and output remain. Do not delete records, logs, or other files.`, ["rm", "node_job_query"]);
  assert(!existsSync(firstPath));
  const missingResults = events.flatMap(event => event.type === "tool_execution_end" && event.toolName === "node_job_query" ? [event.result.details as Query] : []);
  for (const id of [first.id, reused.id]) assert(missingResults.some(job => job.id === id && job.sourceState === "missing" && job.status === "finished" && job.stdout.length > 0));
  await run("filesystem tools", `Create ${join(root, "remove-me", "nested")} using mkdir. Write a file within it, read the file, then remove the tree with rm recursive:true. Do not create a job for these filesystem operations.`, ["mkdir", "write", "read", "rm"]);
  assert(!existsSync(join(root, "remove-me")));
  await run("npm add and ESM import", "Add exactly is-number version 7.0.0 to this session workspace with node_npm_add. Write a .mjs script that imports is-number with ESM import, requires isNumber(42) to be true and prints DEPENDENCY_OK. Create and run a timed job with a ten-second timeout. Keep evidence.", ["node_npm_add", "node_job_create", "node_job_run"]);
  const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as { type: string; dependencies: Record<string, string>; devDependencies?: object };
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dependencies["is-number"], "7.0.0");
  assert(!manifest.devDependencies);
  const lock = await readFile(join(workspace, "package-lock.json"), "utf8");
  assert(/packagefeedproxy\.microsoft\.io|pkgs\.visualstudio\.com/u.test(lock));
  await run("duplicate dependency rejection", "Intentionally try to add is-number@7.0.0 again once with node_npm_add. Report the existing-dependency rejection without retrying or removing it.", ["node_npm_add"], ["node_npm_add"]);
  await run("npm remove", "Remove is-number from this session workspace with node_npm_remove. Do not delete any script or log.", ["node_npm_remove"]);
  assert(!existsSync(join(workspace, "node_modules", "is-number")));
  await run("timeout evidence", "Write a .mjs script that prints EXPECTED_TIMEOUT and waits 10 seconds. Create a job named Deadline fixture with timeoutSeconds:0.5. Run it once. This timeout is intentional; report it without retrying or changing the deadline.", ["node_job_create", "node_job_run"], ["node_job_run"]);
  assert.equal((await named("Deadline fixture")).status, "timeout");
  await run("failure evidence", "Write a .mjs script that prints EXPECTED_FAILURE and sets process.exitCode=7. Create a job named Failure fixture with timeoutSeconds:5 and run it once. This failure is intentional; do not retry.", ["node_job_create", "node_job_run"], ["node_job_run"]);
  assert.equal((await named("Failure fixture")).exitCode, 7);
  await run("background service startup", "Write a .mjs script that prints SERVICE_PID followed by process.pid, then prints SERVICE_TICK every 200 milliseconds. Create exactly one job named Live service with timeoutSeconds:null (no deadline), then run its returned UUID. Do not substitute any numeric timeout. Return after startup; leave it running.", ["node_job_create", "node_job_run"]);
  const background = await named("Live service");
  assert(background.timeoutSeconds === undefined && background.status === "started");
  await run("quiet background startup", "Write a .mjs script that prints QUIET_PID and process.pid once, then stays alive without more output. Create exactly one job named Quiet service with timeoutSeconds:null, and run it. Return after startup; keep it running for later phases.", ["node_job_create", "node_job_run"]);
  const quiet = await named("Quiet service");
  assert(quiet.timeoutSeconds === undefined && quiet.status === "started");
  const log = (job: Job) => join(workspace, "logs", job.id, "stdout.log");
  const servicePid = Number(/SERVICE_PID (\d+)/u.exec(await readFile(log(background), "utf8"))?.[1]);
  const quietPid = Number(/QUIET_PID (\d+)/u.exec(await readFile(log(quiet), "utf8"))?.[1]);
  assert(servicePid > 0 && quietPid > 0);
  const servicesStarted = Date.now();
  const requestsBeforeQuiet = requests;
  await new Promise(accept => setTimeout(accept, 1200));
  assert.equal(requests, requestsBeforeQuiet, "Background output must not cause model requests");
  await run("manual status snapshot", `Has job ${background.id} finished yet? Use node_job_query once. Leave it running; do not create a monitor or repeatedly poll.`, ["node_job_query"]);
  await run("active dependency protection", "Intentionally try node_npm_add for is-number version7.0.0 while the services run. Report the running-job rejection without retrying or stopping services.", ["node_npm_add"], ["node_npm_add"]);
  for (let round = 1; round <= 12; round++) {
    await run(`extended round ${round}: edit/create/run`, `Use a reusable .mjs helper importing another .mjs module in this workspace. ${round === 1 ? "Create the two files." : "Read the existing round helper/module and edit the module."} Make it calculate ${round}*${round}, print exactly ROUND_${round}=${round * round}, and exit. Create a new timed job named Round ${round}, args:[], timeoutSeconds:5, then run it. Reuse source, not a prior job UUID. Leave both services running.`, [round === 1 ? "write" : "edit", "node_job_create", "node_job_run"]);
    const job = await named(`Round ${round}`);
    assert.equal(job.status, "finished");
    assert((await readFile(log(job), "utf8")).includes(`ROUND_${round}=${round * round}`));
    await run(`extended round ${round}: list/query`, `List status:finished,recentN:3 and status:started,recentN:10. Query the completed Round ${round} job and the Quiet service. Briefly report their actual statuses. Do not rerun or stop anything.`, ["node_job_list", "node_job_query"]);
    process.kill(servicePid, 0); process.kill(quietPid, 0);
    if (round % 4 === 0) {
      await compact(`native compaction after round ${round}`);
      await session.reload();
      process.kill(servicePid, 0); process.kill(quietPid, 0);
    }
    if (round === 6) {
      phase = "reopen the saved long session";
      const file = session.sessionManager.getSessionFile(); assert(file);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      session.dispose();
      await live.loader.reload();
      const reopened = await live.sdk.createAgentSession({ cwd: root, agentDir: agentDirectory, modelRuntime: live.runtime,
        model, thinkingLevel: effort, settingsManager: live.settings, resourceLoader: live.loader,
        sessionManager: live.sdk.SessionManager.open(file) });
      await bind(reopened.session);
      await run("resumed long session", "List status:started,recentN:10. Confirm the Live service and Quiet service remain in the same workspace. Query each once without creating or running anything.", ["node_job_list", "node_job_query"]);
    }
  }
  assert(Date.now() - servicesStarted >= 60000, "The extended workflow must exercise sustained service lifetime");
  assert((await readFile(log(background))).length > (await readFile(log(quiet))).length);
  await run("deprecate service and preserve logs", `Deprecate job ${background.id}, then query that same UUID. Confirm it is deprecated. Do not delete any workspace file or log.`, ["node_job_deprecate", "node_job_query"]);
  assert.throws(() => process.kill(servicePid, 0), /ESRCH/u);
  await run("deprecate quiet service", `Deprecate job ${quiet.id}, then list status:deprecated,recentN:10. Preserve every log and definition.`, ["node_job_deprecate", "node_job_list"]);
  assert.throws(() => process.kill(quietPid, 0), /ESRCH/u);
  for (const job of [background, quiet]) assert(existsSync(log(job)) && (await named(job.name)).terminationConfirmed);
  await session.prompt("/node-scripts off");
  assert(!session.getActiveToolNames().includes("node_job_create"));
  await session.reload();
  assert(!session.getActiveToolNames().includes("node_job_create"));
  await session.prompt("/node-scripts on");
  await run("final evidence and empty active list", "List status:started,recentN:10, status:created,recentN:10, and status:failed,recentN:10. Report the workspace and observed counts. Do not execute or delete anything.", ["node_job_list"]);
  assert(!events.some(event => event.type === "message_end" && event.message.role === "custom"), "No custom job callback messages");
  const queries = events.flatMap(event => event.type === "tool_execution_end" && event.toolName === "node_job_query" ? [event.result.details as Query] : []);
  assert(queries.some(job => job.id === quiet.id && job.status === "started"));
  assert(queries.some(job => job.id === background.id && job.status === "deprecated"));
  assert.deepEqual(errors, []);
  console.log(`PASS: extended configured-model Pi session; ESM source edits and reuse; all nine tools; real npm; single-use/failure/timeout; quiet+sustained services; 12 work cycles; ${compactions} native compactions; reload and saved-session reopening; query-only/no callbacks; deprecation/evidence; ${prompts} prompts, ${requests} requests, ${tools} tool calls, ${((Date.now() - began) / 1000).toFixed(1)} seconds`);
} catch (error) {
  const calls = events.flatMap(event => event.type === "tool_execution_start" ? [{ tool: event.toolName, ...event.args as { scriptPath?: string; timeoutSeconds?: number; jobId?: string; name?: string; status?: string; recentN?: number } }] : []);
  // Only test-local tool identities and states are reported, not source, environment or provider diagnostics.
  console.error(JSON.stringify({ recentCalls: calls.slice(-6).map(({ tool, scriptPath, timeoutSeconds, jobId, name, status, recentN }) => ({ tool, scriptPath, timeoutSeconds, jobId, name, status, recentN })) }));
  console.error(JSON.stringify({ phase, requests, prompts, tools, failure: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown" }));
  throw new Error(`node-scripts extended live verification failed during ${phase}; private diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
  try { if (session) await closeLiveSession(session); }
  finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    const workspaces = join(root, "workspaces");
    if (existsSync(workspaces)) for (const folder of await readdir(workspaces)) {
      const jobs = join(workspaces, folder, "jobs");
      for (const file of await readdir(jobs)) {
        const job = JSON.parse(await readFile(join(jobs, file), "utf8")) as Job;
        assert(job.status !== "started" && job.terminationConfirmed !== false, `Unresolved job evidence is preserved at ${root}`);
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
    console.log("CLEANUP: isolated live session, processes, test dependencies and fixtures removed");
  }
}
