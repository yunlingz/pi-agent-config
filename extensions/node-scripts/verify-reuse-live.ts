import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { projectFixture } from "./project-fixtures.ts";
import type { Job, Query } from "./types.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "Keep the configured model and effort");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
// Resolve Pi's existing native binaries before isolating session data; do not download replacement tools in the fixture.
const native: typeof import("@earendil-works/pi-coding-agent/dist/utils/tools-manager.js") = await import(pathToFileURL(join(packageDirectory, "dist/utils/tools-manager.js")).href);
assert(native.getToolPath("fd") && native.getToolPath("rg"), "Install Pi's native find/grep prerequisites before live acceptance");
const root = await realpath(await mkdtemp(join(tmpdir(), "node-reuse-live-")));
const priorAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const began = Date.now();
let session: AgentSession | undefined;
let requests = 0, prompts = 0, tools = 0;
let phase = "prepare natural-choice acceptance";
const failures: { tool: string; text: string }[] = [];
const heartbeat = setInterval(() => console.error(`Node reuse live: ${phase}; ${prompts} prompts, ${requests} requests, ${tools} tool calls`), 20000);
try {
  await writeFile(join(root, "pi-node-scripts.json"), JSON.stringify({ rootFolder: join(root, "workspaces"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }));
  for (const language of ["python", "powershell"] as const) {
    const executable = language === "python" ? process.env.NODE_SCRIPTS_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3")
      : process.env.NODE_SCRIPTS_TEST_POWERSHELL;
    if (!executable) { console.log("NOT VERIFIED: PowerShell natural-choice execution; set NODE_SCRIPTS_TEST_POWERSHELL in an authorized runtime"); continue; }
    const fixture = await projectFixture(root, language, executable);
    await mkdir(join(fixture.project, ".pi"));
    await writeFile(join(fixture.project, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "edit", "write", "grep", "find", "ls"], compaction: { enabled: false } }));
    const events: AgentSessionEvent[] = [];
    const errors: unknown[] = [];
    const live = await createLiveSession({ packageDirectory, agentDirectory, cwd: fixture.project, includeBuiltinTools: true,
      extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
      appendSystemPrompt: ["Work only within this synthetic project and its session workspace. Do not use the network, install packages, inspect credentials, or use MCP."],
      extensionFactories: [pi => { pi.on("before_provider_request", () => { requests++; }); }],
    });
    const model = live.session.model; assert(model);
    assert.equal(model.provider, live.settings.getDefaultProvider()); assert.equal(model.id, live.settings.getDefaultModel());
    const effort = live.session.thinkingLevel;
    const bind = async (value: AgentSession) => {
      session = value;
      await value.bindExtensions({ mode: "json", onError: error => errors.push(error) });
      value.subscribe(event => {
        if (event.type !== "message_update") events.push(event);
        if (event.type === "tool_execution_end") {
          tools++;
          if (event.isError) failures.push({ tool: event.toolName, text: JSON.stringify(event.result.content).slice(0, 1000) });
        }
      });
    };
    await bind(live.session);
    const workspace = join(root, "workspaces", live.manager.getSessionId());
    const jobs = async () => Promise.all((await readdir(join(workspace, "jobs"))).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await readFile(join(workspace, "jobs", name), "utf8")) as Job));
    const receipts = async () => (await readFile(fixture.receipt, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { case: string; characters: number; cwd: string });
    const run = async (label: string, prompt: string) => {
      assert(session); const current = session; phase = `${language}: ${label}`; prompts++;
      const start = events.length;
      let expired = false;
      const timer = setTimeout(() => { expired = true; void current.abort(); }, 120000);
      try {
        await current.prompt(prompt); await current.waitForIdle();
        const turn = events.slice(start);
        assert(!expired && turn.some(event => event.type === "agent_settled" && !event.aborted), phase);
        for (const event of turn) {
          if (event.type === "tool_execution_end") assert(!event.isError, `${phase}: unexpected ${event.toolName} failure`);
          if (event.type === "message_end" && event.message.role === "assistant") {
            assert.equal(event.message.provider, model.provider); assert.equal(event.message.model, model.id);
            assert(!["error", "aborted", "length"].includes(event.message.stopReason));
          }
        }
        assert.equal(current.thinkingLevel, effort); assert.deepEqual(errors, []);
        assert.equal(await readFile(fixture.script, "utf8"), fixture.source);
        return turn;
      } finally { clearTimeout(timer); }
    };
    console.log(`START: ${model.provider}/${model.id}; ${effort}; ${language} project; real requests can incur charges`);
    await run("existing project workflow", "Run this project's documented measurement workflow for alpha and report its JSON result.");
    assert.equal((await receipts()).length, 1); assert.equal((await receipts())[0]?.case, "alpha");
    const first = (await jobs()).filter(job => job.status === "finished"); assert.equal(first.length, 1);
    const job = first[0]; assert(job);
    const sourcePath = join(workspace, job.scriptPath);
    const originalLauncher = await readFile(sourcePath, "utf8");
    await run("source reuse through arguments", "Now run the same project workflow for beta and report its JSON result.");
    assert.deepEqual((await receipts()).map(value => value.case), ["alpha", "beta"]);
    const completed = (await jobs()).filter(job => job.status === "finished"); assert.equal(completed.length, 2);
    assert(completed.every(value => value.scriptPath === job.scriptPath), "Related work must reuse the launcher, not another source copy");
    assert.equal(await readFile(sourcePath, "utf8"), originalLauncher, "Input changes use arguments, not rewritten source");
    console.log(`PASS: ${language} project program executed unchanged; actual receipts confirm two inputs and one unchanged launcher`);
    assert(session);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); session = undefined;
    // A native conversation branch starts without earlier tool results, but retains the same session workspace.
    live.manager.resetLeaf();
    await live.loader.reload();
    const reopened = await live.sdk.createAgentSession({ cwd: fixture.project, agentDir: agentDirectory, modelRuntime: live.runtime,
      model, thinkingLevel: effort, settingsManager: live.settings, resourceLoader: live.loader, sessionManager: live.manager });
    await bind(reopened.session);
    const history = await run("recover execution history", "What did the earlier project measurement for alpha report? I do not have its job ID. Recover the retained execution evidence without executing the workflow again.");
    assert(history.some(event => event.type === "tool_execution_end" && event.toolName === "node_job_list"));
    assert(history.some(event => event.type === "tool_execution_end" && event.toolName === "node_job_query"
      && (event.result.details as Query).id === job.id)); // Extension-owned serialized result.
    assert.equal((await receipts()).length, 2); assert.equal((await jobs()).length, 2);
    console.log(`PASS: ${language} prior job discovered and queried from a clean conversation branch; no extra execution`);
    if (session) await closeLiveSession(session); session = undefined;
  }
  console.log(`PASS: natural-choice project reuse and evidence recovery; ${prompts} prompts, ${requests} requests, ${tools} tool calls, ${((Date.now() - began) / 1000).toFixed(1)} seconds`);
} catch (error) {
  console.error(JSON.stringify({ phase, prompts, requests, tools, failure: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown" }));
  console.error(JSON.stringify({ failures })); // Only synthetic fixture errors, never provider diagnostics.
  throw new Error("Project reuse acceptance failed; private diagnostics withheld");
} finally {
  clearInterval(heartbeat);
  try { if (session) await closeLiveSession(session); }
  finally {
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
    const workspaces = join(root, "workspaces");
    if (existsSync(workspaces)) for (const id of await readdir(workspaces)) for (const file of await readdir(join(workspaces, id, "jobs"))) {
      if (!file.endsWith(".json")) continue;
      const job = JSON.parse(await readFile(join(workspaces, id, "jobs", file), "utf8")) as Job;
      assert(job.status !== "started" && job.terminationConfirmed !== false, `Unresolved evidence must remain at ${root}`);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(root));
    console.log("CLEANUP: isolated project, sessions, Node workers and receipts removed");
  }
}
