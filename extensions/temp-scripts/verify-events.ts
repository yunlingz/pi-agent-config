import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { ENTRY_TYPE, JOB_EVENT_MESSAGE, type ExecutionDetails, type JobEvent, type JobReference, type RunResult } from "./types.ts";

const installation = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node verify-events.ts <installed-pi-package-directory>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(installation, "dist/index.js")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", installation)).href);
const root = await realpath(await mkdtemp(join(tmpdir(), "scripts-events-")));
const previousStorage = process.env.PI_TEMP_SCRIPTS_DIR;
process.env.PI_TEMP_SCRIPTS_DIR = join(root, "storage");
const originalFetch = globalThis.fetch;
let session: AgentSession | undefined;
let pending: ToolCall | undefined;
let count = 0;
let customRuns = 0;
let hold = false;
let releaseResponse: (() => void) | undefined;
const received: JobEvent[] = [];
const errors: unknown[] = [];
const owned = new Map<string, JobReference>();
const changed = new Set<() => void>();
const wait = async (predicate: () => boolean, label: string) => {
  if (predicate()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: () => void = () => {};
  try {
    await new Promise<void>((accept, reject) => {
      check = () => { if (predicate()) accept(); };
      changed.add(check);
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000);
      check();
    });
  } finally { clearTimeout(timer); changed.delete(check); }
};
const delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));
try {
  globalThis.fetch = async () => { throw new Error("Event fixtures must not access the network"); };
  const settings = sdk.SettingsManager.inMemory({ packages: [], extensions: ["-builtin:mcp"], compaction: { enabled: false, keepRecentTokens: 300 }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("job-event-fixture", {
    api: "job-event-fixture", apiKey: "unused", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Job event fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = ai.createAssistantMessageEventStream();
      const call = pending;
      pending = undefined;
      const summary = JSON.stringify(context).includes("summarization assistant");
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [call] : [{ type: "text", text: summary ? "Native job event summary." : "EVENT_RECEIVED" }], stopReason: call ? "toolUse" : "stop", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const finish = () => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); };
      if (hold) { hold = false; releaseResponse = finish; for (const notify of changed) notify(); }
      else if (summary) setTimeout(finish, 500);
      else queueMicrotask(finish);
      return stream;
    },
  });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
    additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [pi => { pi.on("before_agent_start", event => { if (event.messageType === "custom") customRuns++; }); }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = sdk.SessionManager.create(root, join(root, "sessions"));
  const model = runtime.getModel("job-event-fixture", "fixture");
  assert(model);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: manager }));
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === JOB_EVENT_MESSAGE) {
      // Only the managed-script event bridge writes this controlled message contract.
      const details = event.message.details as { events: JobEvent[] };
      received.push(...details.events);
    }
    for (const entry of manager.getEntries()) if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const reference = entry.data as JobReference;
      owned.set(reference.id, reference);
    }
    for (const notify of changed) notify();
  });
  const execute = async (name: string, args: ToolCall["arguments"]) => {
    assert(session);
    await session.waitForIdle();
    const id = `event-${++count}`;
    pending = { type: "toolCall", id, name, arguments: args };
    await session.prompt("Execute the planned local event fixture.");
    await session.waitForIdle();
    const outcome = session.messages.findLast(value => value.role === "toolResult" && value.toolCallId === id);
    assert(outcome?.role === "toolResult" && !outcome.isError, outcome?.role === "toolResult" ? JSON.stringify(outcome.content) : "Missing tool result");
    return outcome;
  };
  const execution = (message: { details?: unknown }): ExecutionDetails => {
    // Pi stores extension-owned execution details in its generic result contract.
    return message.details as ExecutionDetails;
  };
  const kinds = (job: string) => received.filter(event => event.job === job);
  const gate = join(root, "continue");
  const exit = join(root, "exit");
  const source = `import {existsSync} from "node:fs";const {exec,progress}=await import(process.env.PI_SCRIPT_RUNTIME);progress("BEFORE_CHILD");await exec(process.execPath,["-e","console.log('CHILD_OUTPUT');setTimeout(()=>{},1200)"],{timeoutSeconds:4});progress("AFTER_CHILD");while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,20));progress("BUSY_PROGRESS");while(!existsSync(${JSON.stringify(exit)}))await new Promise(r=>setTimeout(r,20));console.log("FINAL_OUTPUT");`;
  const started = await execute("script_inline", { purpose: "Event worker", code: source, timeoutSeconds: 3, background: { runtimeSeconds: 30 } });
  const details = execution(started);
  const job = details.background?.job;
  assert(job);
  await wait(() => kinds(job).some(event => event.message === "AFTER_CHILD"), "pushed startup, child and progress events");
  await session.waitForIdle();
  assert(customRuns > 0, "A lifecycle event must resume an idle agent without polling");
  assert.deepEqual(kinds(job).filter(event => event.kind === "state").map(event => event.status), ["preparing", "running"]);
  assert.deepEqual(kinds(job).filter(event => event.kind === "command").map(event => event.command?.status), ["running", "succeeded"]);
  assert(kinds(job).some(event => event.kind === "handoff"));
  const quietCount = received.length;
  await delay(1200);
  assert.equal(received.length, quietCount, "Elapsed heartbeats must not create callback requests");

  hold = true;
  const busy = session.prompt("Hold this unrelated response while the worker reports progress.");
  await wait(() => releaseResponse !== undefined, "held model response");
  const runsBeforeBusyProgress = customRuns;
  await writeFile(gate, "go");
  await delay(300);
  assert(!kinds(job).some(event => event.message === "BUSY_PROGRESS"), "Busy callbacks must use the native follow-up queue");
  assert.equal(customRuns, runsBeforeBusyProgress);
  assert(releaseResponse);
  releaseResponse();
  releaseResponse = undefined;
  await busy;
  await wait(() => kinds(job).some(event => event.message === "BUSY_PROGRESS"), "follow-up delivery after busy response");
  await session.waitForIdle();

  await session.reload();
  populateSplitHistory(manager, model, "CALLBACK");
  const beforeCompaction = received.length;
  const compact = session.compact();
  await delay(100);
  await writeFile(exit, "go");
  await delay(150);
  assert.equal(received.length, beforeCompaction, "Compaction must defer agent callbacks");
  await compact;
  await wait(() => kinds(job).some(event => event.status === "succeeded"), "completion after reload and compaction");
  await session.waitForIdle();
  assert.equal(kinds(job).filter(event => event.status === "succeeded" && event.kind === "state").length, 1);
  const reference = owned.get(job);
  assert(reference && !existsSync(join(reference.root, "lease")));
  const runs = await readdir(join(reference.root, "runs"));
  const saved = JSON.parse(await readFile(join(reference.root, "runs", runs[0], "result.json"), "utf8")) as RunResult;
  assert(saved.terminationConfirmed && saved.output.includes("FINAL_OUTPUT"));
  await execute("script_job", { action: "release", job });

  for (const [label, code, runtimeSeconds, status] of [
    ["Failure", 'await new Promise(r=>setTimeout(r,400));process.exitCode=7;', 3, "failed"],
    ["Deadline", 'setInterval(()=>{},1000);', 0.4, "timed_out"],
    ["Output limit", 'await new Promise(r=>setTimeout(r,300));process.stdout.write("x".repeat(17*1024*1024));setInterval(()=>{},1000);', 4, "output_limit"],
  ] as const) {
    const outcome = await execute("script_inline", { purpose: label, code, timeoutSeconds: 2, background: { runtimeSeconds } });
    const current = execution(outcome).background?.job;
    assert(current);
    await wait(() => kinds(current).some(event => event.kind === "state" && event.status === status), `pushed ${status}`);
    await session.waitForIdle();
    assert(kinds(current).findLast(event => event.kind === "state")?.terminationConfirmed);
    await execute("script_job", { action: "release", job: current });
  }
  const service = await execute("script_inline", { purpose: "Stop events", code: 'setInterval(()=>{},1000);', timeoutSeconds: 2, background: { service: true } });
  const serviceId = execution(service).background?.job;
  assert(serviceId);
  await execute("script_job", { action: "stop", job: serviceId });
  await wait(() => kinds(serviceId).some(event => event.status === "cancelled"), "pushed explicit cancellation");
  await session.waitForIdle();
  assert(kinds(serviceId).some(event => event.status === "stopping"));
  await execute("script_job", { action: "release", job: serviceId });
  const shutdown = await execute("script_inline", { purpose: "No wake on quit", code: 'setInterval(()=>{},1000);', timeoutSeconds: 2, background: { service: true } });
  const shutdownId = execution(shutdown).background?.job;
  assert(shutdownId);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const afterShutdown = received.length;
  await delay(1200);
  assert.equal(received.length, afterShutdown);
  assert(!existsSync(join(owned.get(shutdownId)?.root ?? "", "lease")));
  assert.deepEqual(errors, []);
  assert(!session.messages.some(message => message.role === "toolResult" && ["read", "script_js"].includes(message.toolName)));
  console.log("PASS: actual Pi event callbacks; idle auto-resume; busy follow-up; preparation/running/child/progress/handoff/final states; no heartbeat polling; reload; compaction deferral; failure/deadline/output-limit/cancellation; saved result before callback; shutdown suppression; zero external requests");
} finally {
  releaseResponse?.();
  globalThis.fetch = originalFetch;
  try {
    if (session) { await session.abort(); await session.waitForIdle(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  } finally {
    for (const reference of owned.values()) assert(!existsSync(join(reference.root, "lease")), "Unresolved event fixture lease retained");
    if (previousStorage === undefined) delete process.env.PI_TEMP_SCRIPTS_DIR;
    else process.env.PI_TEMP_SCRIPTS_DIR = previousStorage;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
    console.log("CLEANUP: event fixture session, processes and storage removed");
  }
}
