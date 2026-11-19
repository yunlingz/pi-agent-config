import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import { testTUI, testUI } from "../../scripts/test-fixtures.ts";
import type { Job, JobView, Query } from "./types.ts";

const installation = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node verify-integration.ts <Pi>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(installation, "dist/index.js")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", installation)).href);
const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", installation)).href);
const { Type }: typeof import("typebox") = await import(pathToFileURL(createRequire(join(installation, "package.json")).resolve("typebox")).href);
const root = await realpath(await mkdtemp(join(tmpdir(), "node-scripts-pi-")));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const originalFetch = globalThis.fetch;
let session: AgentSession | undefined;
let pending: ToolCall | undefined;
let count = 0;
let highUsage = false;
const errors: unknown[] = [];
let network = 0;
const widget = new Map<string, Component>();
const statuses = new Map<string, string>();
const notifications: string[] = [];
let summaryRequests = 0;
let providerPrompt = "";
try {
  globalThis.fetch = async () => { network++; throw new Error("External requests blocked in offline node-scripts fixtures"); };
  await mkdir(join(root, "extensions"));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, "extensions", "node-scripts"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, "pi-node-scripts.json"), JSON.stringify({ rootFolder: join(root, "workspaces"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }));
  const settings = sdk.SettingsManager.inMemory({ packages: [], extensions: ["-builtin:mcp"], compaction: { enabled: false, keepRecentTokens: 300, reserveTokens: 1000 }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("node-scripts-fixture", {
    api: "node-scripts-fixture", apiKey: "unused", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Node scripts fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      providerPrompt = ai.getCurrentSystemPrompt(context.messages);
      const stream = ai.createAssistantMessageEventStream();
      const call = pending; pending = undefined;
      const summary = JSON.stringify(context).includes("summarization assistant");
      if (summary) summaryRequests++;
      const input = highUsage && !summary ? 63500 : 100; highUsage = false;
      const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), content: call ? [call] : [{ type: "text", text: summary ? "Native summary preserves the workspace and running service." : "FIXTURE_OK" }], stopReason: call ? "toolUse" : "stop", usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); }, summary ? 250 : 0);
      return stream;
    },
  });
  let shellRuns = 0;
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, disabledBuiltinExtensions: ["mcp"], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      pi.registerTool({ name: "powershell", label: "Fixture PowerShell", description: "Must never execute", parameters: Type.Object({ command: Type.String() }), async execute() { shellRuns++; throw new Error("Shell fixture executed"); } });
      pi.registerTool({ name: "nested_shell_probe", label: "Nested probe", description: "Probe native shell gates", parameters: Type.Object({}), async execute(_id, _input, signal, _update, ctx) {
        assert((await ctx.executeTool("bash", { command: "git --version" }, { signal })).isError);
        assert((await ctx.executeTool("powershell", { command: "Get-Location" }, { signal })).isError);
        return { content: [{ type: "text", text: "Nested shells blocked" }], details: undefined };
      } });
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions.find(value => value.tools.has("node_job_create")); assert(extension);
  assert.equal(extension.tools.size, 9);
  assert.equal(extension.tools.get("node_job_run")?.definition.executionMode, "sequential");
  assert(!extension.handlers.has("message_end"), "No callback message bridge is needed");
  const manager = sdk.SessionManager.create(root, join(root, "sessions"));
  const model = runtime.getModel("node-scripts-fixture", "fixture"); assert(model);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: manager }));
  sdk.initTheme("dark", false);
  await session.bindExtensions({ mode: "tui", uiContext: testUI(session, {
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify(text) { notifications.push(text); },
    setWidget(key, content, options) {
      widget.delete(key); if (!content) return;
      assert.equal(options?.placement, "aboveEditor");
      const theme = testUI(session as AgentSession, {}).theme;
      widget.set(key, Array.isArray(content) ? new tui.Text(content.join("\n"), 0, 0) : content(testTUI(new tui.Container()), theme));
    },
  }), onError: error => errors.push(error) });
  assert.equal(statuses.get("node-scripts"), "node-scripts: on");
  const workspace = join(root, "workspaces", manager.getSessionId());
  assert(existsSync(join(workspace, "scripts")));
  const execute = async (name: string, args: ToolCall["arguments"], error = false) => {
    assert(session);
    const id = `node-fixture-${++count}`; pending = { type: "toolCall", id, name, arguments: args };
    await session.prompt("Execute the planned local fixture."); await session.waitForIdle();
    const output = session.messages.findLast(value => value.role === "toolResult" && value.toolCallId === id);
    assert(output?.role === "toolResult");
    assert.equal(output.isError, error, JSON.stringify(output.content));
    return output;
  };
  const details = <T>(value: { details?: unknown }) => value.details as T; // Extension-owned controlled tool result.
  const create = async (scriptPath: string, timeoutSeconds?: number, name?: string) => details<JobView>(await execute("node_job_create", { scriptPath, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), ...(name ? { name } : {}) }));
  const waitOutput = async (id: string, marker: string) => {
    const end = Date.now() + 7000;
    while (true) {
      const value = JSON.parse(await readFile(join(workspace, "jobs", `${id}.json`), "utf8")) as JobView;
      if (value.lastOutputLine?.includes(marker)) return;
      assert(Date.now() < end, `Missing output ${marker}`); await new Promise(accept => setTimeout(accept, 20));
    }
  };
  const panel = (width = 180) => widget.get("node-scripts-jobs")?.render(width).map(stripVTControlCharacters).join("\n") ?? "";
  const empty = details<{ workspace: string; jobs: JobView[]; total: number }>(await execute("node_job_list", { status: "created", recentN: 10 }));
  assert.equal(empty.workspace, workspace); assert.deepEqual(empty.jobs, []); assert.equal(empty.total, 0);
  const invalidLists: ToolCall["arguments"][] = [{}, { status: "created" }, { recentN: 10 }, { status: "all", recentN: 10 }, { status: "created", recentN: 0 }];
  for (const args of invalidLists) await execute("node_job_list", args, true);
  await execute("bash", { command: "git --version" }, true);
  await execute("powershell", { command: "Get-Location" }, true);
  await execute("nested_shell_probe", {}); assert.equal(shellRuns, 0);
  await execute("mkdir", { path: join(workspace, "scripts", "nested") });
  await execute("write", { path: join(workspace, "scripts", "main.mjs"), content: 'console.log("BEFORE");console.error("ERR");' });
  await execute("read", { path: join(workspace, "scripts", "main.mjs") });
  await execute("edit", { path: join(workspace, "scripts", "main.mjs"), edits: [{ oldText: "BEFORE", newText: "AFTER" }] });
  const one = await create("scripts/main.mjs", 5, "Main run");
  const finished = details<Query>(await execute("node_job_run", { jobId: one.id }));
  assert.equal(finished.status, "finished"); assert(finished.stdout.includes("AFTER") && finished.stderr.includes("ERR"));
  await execute("node_job_run", { jobId: one.id }, true);
  assert(providerPrompt.includes(`Workspace: ${workspace}`));
  assert(providerPrompt.includes("must use .mjs files and ESM syntax"));
  assert(!/Use read\/write\/edit|write\/edit only|author.*with native/iu.test(providerPrompt));
  await execute("node_job_deprecate", { jobId: one.id });
  assert(!panel().includes("Main run")); assert(existsSync(finished.stdoutPath));
  await writeFile(join(workspace, "scripts", "large.mjs"), 'process.stdout.write("x".repeat(80000));process.stderr.write("y".repeat(80000));');
  const large = await create("scripts/large.mjs", 5, "Bounded output");
  const largeResult = await execute("node_job_run", { jobId: large.id });
  const largeText = largeResult.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert(Buffer.byteLength(largeText) <= 50 * 1024 && largeText.includes("Output truncated"));
  const largeDetails = details<Query>(largeResult);
  assert.equal((await readFile(largeDetails.stdoutPath)).length, 80000);
  assert.equal((await readFile(largeDetails.stderrPath)).length, 80000);
  await execute("node_job_deprecate", { jobId: large.id });
  const outside = join(root, "outside.txt"); await writeFile(outside, "KEEP");
  const link = join(root, "remove-link"); await symlink(outside, link);
  await execute("rm", { path: link }); assert(existsSync(outside));
  await execute("rm", { path: homedir(), recursive: true }, true);
  await execute("rm", { path: join(root, "missing.txt") });
  await execute("rm", { path: join(workspace, "scripts", "nested") }, true);
  await execute("rm", { path: join(workspace, "scripts", "nested"), recursive: true });
  await execute("node_npm_add", { package: "is-number", version: "^7.0.0" }, true);

  await writeFile(join(workspace, "scripts", "service.mjs"), 'console.log("SERVICE_PID",process.pid);setInterval(()=>console.log("SERVICE_TICK"),50);');
  const background = details<JobView>(await execute("node_job_create", { scriptPath: "scripts/service.mjs", timeoutSeconds: null, name: "Background service" }));
  await execute("node_job_run", { jobId: background.id }); await waitOutput(background.id, "SERVICE_TICK");
  const initial = details<Query>(await execute("node_job_query", { jobId: background.id }));
  const pid = Number(/SERVICE_PID (\d+)/u.exec(initial.stdout)?.[1]); assert(pid > 0);
  await session.prompt("/node-scripts off"); assert(notifications.some(text => text.includes("Wait for active")));
  populateSplitHistory(manager, model, "CONTINUITY");
  await session.compact();
  assert.equal(details<Query>(await execute("node_job_query", { jobId: background.id })).status, "started");
  await session.reload();
  const afterReload = details<Query>(await execute("node_job_query", { jobId: background.id }));
  assert(afterReload.stdout.includes(`SERVICE_PID ${pid}`) && afterReload.active);
  settings.setCompactionEnabled(true); highUsage = true;
  await session.prompt("Trigger native automatic compaction."); await session.waitForIdle(); settings.setCompactionEnabled(false);
  assert(summaryRequests >= 2); process.kill(pid, 0);
  const messages = session.messages.length;
  await new Promise(accept => setTimeout(accept, 400));
  assert.equal(session.messages.length, messages, "Background output must not inject callbacks or model turns");

  await writeFile(join(workspace, "scripts", "timed.mjs"), 'console.log("TIMED_STARTED",process.pid);setInterval(()=>{},1000);');
  const timed = await create("scripts/timed.mjs", 20, "Timed interruption");
  const running = execute("node_job_run", { jobId: timed.id }); await waitOutput(timed.id, "TIMED_STARTED");
  await session.compact(); await running;
  assert.equal(details<Query>(await execute("node_job_query", { jobId: timed.id })).status, "deprecated");
  process.kill(pid, 0);
  const timedReload = await create("scripts/timed.mjs", 20, "Escape before reload");
  const reloadRun = execute("node_job_run", { jobId: timedReload.id }); await waitOutput(timedReload.id, "TIMED_STARTED");
  await assert.rejects(session.reload(), /current response/u);
  await session.abort(); await reloadRun; await session.reload();
  assert.equal(details<Query>(await execute("node_job_query", { jobId: timedReload.id })).status, "deprecated");
  await writeFile(join(root, "pi-node-scripts.json"), "{invalid");
  await session.reload();
  assert.equal(statuses.get("node-scripts"), "node-scripts: error");
  await execute("bash", { command: "git --version" }, true);
  process.kill(pid, 0);
  await writeFile(join(root, "pi-node-scripts.json"), JSON.stringify({ rootFolder: join(root, "workspaces"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }));
  await session.reload();
  assert.equal(statuses.get("node-scripts"), "node-scripts: on");
  assert.equal(details<Query>(await execute("node_job_query", { jobId: background.id })).status, "started");
  await execute("node_job_deprecate", { jobId: background.id }); assert.throws(() => process.kill(pid, 0), /ESRCH/u);

  const ids: string[] = [];
  for (let index = 0; index < 12; index++) ids.push((await create("scripts/main.mjs", 5, `Visible job ${index}`)).id);
  const listed = details<{ jobs: JobView[]; total: number; hasMore: boolean }>(await execute("node_job_list", { status: "created", recentN: 10 }));
  assert.equal(listed.jobs.length, 10); assert.equal(listed.total, 12);
  assert(listed.hasMore);
  assert((widget.get("node-scripts-jobs")?.render(180).length ?? 0) <= 10);
  const names = listed.jobs.slice(0, 8).map(job => job.name);
  for (const name of names) assert(panel().includes(name));
  assert.equal((panel().match(/Visible job/gu) ?? []).length, 8);
  await session.prompt("/node-scripts expand"); assert.equal((panel().match(/Visible job/gu) ?? []).length, 12);
  for (const width of [120, 60, 24]) assert((widget.get("node-scripts-jobs")?.render(width) ?? []).every(line => tui.visibleWidth(line) <= width));
  for (const id of ids) await execute("node_job_deprecate", { jobId: id });
  await session.prompt("/node-scripts off"); assert.equal(statuses.get("node-scripts"), "node-scripts: off");
  assert(!session.getActiveToolNames().includes("node_job_create"));
  assert.match((await execute("bash", { command: "git --version" })).content.filter(block => block.type === "text").map(block => block.text).join(""), /git version/u);
  await session.reload(); assert(!session.getActiveToolNames().includes("node_job_create"));
  await session.prompt("/node-scripts on"); assert(session.getActiveToolNames().includes("node_job_create"));
  assert.deepEqual(errors, []); assert.equal(network, 0);
  console.log("PASS: automatic discovery; nine tools; native file tools; direct/nested shell gates; filesystem safety; single-use and deprecation; shared panel/list ranking; streaming and retained logs; timed interruption before native compaction; Escape/reload; background PID continuity across manual/automatic compaction/reload; no callbacks; toggle; narrow layouts; zero external requests");
} finally {
  try { if (session) { await session.abort(); await session.waitForIdle(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally {
    globalThis.fetch = originalFetch;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    const workspaces = join(root, "workspaces");
    if (existsSync(workspaces)) for (const folder of await readdir(workspaces)) {
      const jobs = join(workspaces, folder, "jobs");
      for (const file of await readdir(jobs)) {
        const job = JSON.parse(await readFile(join(jobs, file), "utf8")) as Job;
        assert(job.status !== "started" && job.terminationConfirmed !== false, `Unresolved job evidence is preserved at ${root}`);
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(root));
    console.log("CLEANUP: isolated Pi session, owned processes and fixtures removed");
  }
}
