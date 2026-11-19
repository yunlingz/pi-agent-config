import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testTUI, testUI } from "../../scripts/test-fixtures.ts";
import { STATUS_KEY } from "./controls.ts";
import { stripVTControlCharacters } from "node:util";
import { ENTRY_TYPE, type JobReference, type ExecutionDetails } from "./types.ts";
import { setRetention, withJobLease } from "./jobs.ts";

const installation = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node verify-integration.ts <installed-pi-package-directory>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(installation, "dist/index.js")).href);
const { Type }: typeof import("typebox") = await import(pathToFileURL(createRequire(join(installation, "package.json")).resolve("typebox")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", installation)).href);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "temp-scripts-integration-")));
const previousStorage = process.env.PI_TEMP_SCRIPTS_DIR;
process.env.PI_TEMP_SCRIPTS_DIR = join(temporary,"script-storage");
let session: AgentSession | undefined;
const owned = new Set<string>();
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Offline integration cannot access the network"); };
  const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], defaultTools:["+grep","+find","+ls"], retry: { enabled: false }, compaction: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(temporary, "auth.json"), modelsPath: null, modelsStorePath: join(temporary, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  let pending: ToolCall[] = [];
  let count = 0;
  runtime.registerProvider("managed-script-fixture", {
    api: "managed-script-fixture", apiKey: "unused-local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = ai.createAssistantMessageEventStream();
      const calls = pending;
      pending = [];
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: calls.length ? calls : [{ type: "text", text: "Fixture finished." }], stopReason: calls.length ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  await mkdir(join(temporary, "extensions"));
  for (const name of ["temp-scripts", "code-anchor"]) await symlink(resolve(dirname(fileURLToPath(import.meta.url)), "..", name), join(temporary, "extensions", name), process.platform === "win32" ? "junction" : "dir");
  let powerShellExecutions = 0;
  const loader = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir: temporary, settingsManager: settings, disabledBuiltinExtensions: ["mcp"], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      pi.registerTool({ name: "powershell", label: "Unavailable test shell", description: "Fixture: must be blocked before execution", parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
        async execute() { powerShellExecutions++; throw new Error("PowerShell fixture must never execute"); },
      });
      pi.registerTool({ name: "nested_shell_fixture", label: "Nested gate fixture", description: "Check nested shell rejection", parameters: Type.Object({}),
        async execute(_id, _input, signal, _update, ctx) {
          const outcome = await ctx.executeTool("bash", { command: "git --version", timeout: 5 }, { signal });
          assert(outcome.isError);
          return { content: [{ type: "text", text: "Nested Bash blocked" }], details: undefined };
        },
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 3);
  const manager = sdk.SessionManager.create(temporary, join(temporary, "sessions"));
  ({ session } = await sdk.createAgentSession({ cwd: temporary, agentDir: temporary, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("managed-script-fixture", "fixture"), thinkingLevel: "off", resourceLoader: loader, sessionManager: manager }));
  const errors: unknown[] = [];
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", installation)).href);
  sdk.initTheme("dark", false);
  const widgets = new Map<string, Component>();
  let widgetRegistrations = 0;
  let toolsExpanded = false;
  const widgetTheme = testUI(session, {}).theme;
  const widgetText = (key = "temp-scripts-retention", width = 120) => widgets.get(key)?.render(width).map(stripVTControlCharacters).join("\n") ?? "";
  await session.bindExtensions({ mode: "tui", uiContext: testUI(session, {
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify(message) { notifications.push(message); },
    getToolsExpanded() { return toolsExpanded; },
    setWidget(key, content, options) {
      widgets.delete(key);
      if (content === undefined) return;
      assert.equal(options?.placement, "aboveEditor");
      widgetRegistrations++;
      widgets.set(key, Array.isArray(content) ? new tui.Text(content.join("\n"), 0, 0) : content(testTUI(new tui.Container()), widgetTheme));
    },
  }), onError: error => errors.push(error) });
  assert.equal(statuses.get(STATUS_KEY), "scripts: on");
  assert.equal(widgetRegistrations, 2);
  assert.equal(widgetText(), "");
  const batch = async (plans: { name: string; args: ToolCall["arguments"] }[]) => {
    const calls: ToolCall[] = plans.map(({ name, args }) => ({ type: "toolCall", id: `fixture-${++count}`, name, arguments: args }));
    pending = calls;
    try { await session?.prompt("Execute the planned local fixtures."); }
    finally {
      for (const entry of manager.getEntries()) if (entry.type === "custom" && entry.customType === ENTRY_TYPE) owned.add((entry.data as JobReference).root);
    }
    return calls.map(call => {
      const outcome = session?.messages.findLast(message => message.role === "toolResult" && message.toolCallId === call.id);
      assert(outcome?.role === "toolResult");
      return outcome;
    });
  };
  const execute = async (name: string, args: ToolCall["arguments"], error = false): Promise<string> => {
    const [outcome] = await batch([{ name, args }]);
    const text = outcome.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.equal(outcome.isError, error, text);
    return text;
  };
  const detailsOf = (message: { details?: unknown } | undefined): ExecutionDetails => {
    assert(message?.details);
    // Pi serializes this extension's results through its generic tool-result contract.
    return message.details as ExecutionDetails;
  };
  const executionDetails = (): ExecutionDetails => {
    const message = session?.messages.findLast(value => value.role === "toolResult" && ["script_inline", "script_js"].includes(value.toolName));
    assert(message?.role === "toolResult");
    return detailsOf(message);
  };
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      assert(Date.now() < deadline, `Timed out: ${label}`);
      await new Promise(accept => setTimeout(accept, 20));
    }
  };
  const heldCode = (name: string, gate: string) => `import {writeFileSync,existsSync} from "node:fs";writeFileSync(${JSON.stringify(join(temporary, name))},String(process.pid));console.log(${JSON.stringify(name)});while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,20));`;
  const inlineGate = join(temporary, "inline-go");
  const inlinePair = batch(["inline-a", "inline-b"].map(name => ({ name: "script_inline", args: { purpose: name, code: heldCode(name, inlineGate), timeoutSeconds: 15 } })));
  try {
    await waitFor(() => ["inline-a", "inline-b"].every(name => existsSync(join(temporary, name))), "both actual inline processes before either finishes");
    assert.equal(new Set(await Promise.all(["inline-a", "inline-b"].map(name => readFile(join(temporary, name), "utf8")))).size, 2);
    assert(widgetText().includes("inline-a (running)") && widgetText().includes("inline-b (running)"));
  } finally { await writeFile(inlineGate, "go"); await inlinePair; }
  const inlineResults = await inlinePair;
  assert(inlineResults.every(value => !value.isError));
  for (const value of inlineResults) {
    const details = detailsOf(value);
    assert.equal(details.retention?.state, "removed");
    assert(details.record?.terminationConfirmed);
    assert(!existsSync(dirname(dirname(details.record.run))));
  }
  console.log("PASS: sibling inline calls overlap as actual processes; independent streamed rows and automatic cleanup");
  const createdPair = await batch(["workspace-a", "workspace-b"].map(purpose => ({ name: "script_job", args: { action: "create", purpose } })));
  assert(createdPair.every(value => !value.isError));
  const workspaces = manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE
    && ["workspace-a", "workspace-b"].includes((entry.data as JobReference).purpose ?? "") ? [entry.data as JobReference] : []);
  assert.equal(workspaces.length, 2);
  const mixedGate = join(temporary, "mixed-go");
  for (const [index, reference] of workspaces.entries()) await writeFile(join(reference.root, "work", "main.mjs"), heldCode(`workspace-${index}`, mixedGate));
  const mixed = batch([
    { name: "script_inline", args: { purpose: "mixed inline", code: heldCode("mixed-inline", mixedGate), timeoutSeconds: 20 } },
    ...workspaces.map(reference => ({ name: "script_js", args: { job: reference.id, purpose: reference.purpose ?? "Concurrent workspace", entry: "main.mjs", timeoutSeconds: 20 } })),
    { name: "script_job", args: { action: "inspect", job: workspaces[0].id } },
  ]);
  await waitFor(() => ["mixed-inline", "workspace-0", "workspace-1"].every(name => existsSync(join(temporary, name))), "mixed inline/workspace processes with a sibling job action");
  await session.abort();
  const interrupted = await mixed;
  assert(interrupted.every(value => !value.isError));
  const runningRefs = interrupted.filter(value => value.toolName !== "script_job").map(value => {
    const details = detailsOf(value);
    assert(details.background && !details.record);
    const reference = manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE ? [entry.data as JobReference] : [])
      .find(reference => reference.id === details.background?.job);
    assert(reference && existsSync(join(reference.root, "lease")));
    return reference;
  });
  const independentStops = await batch([
    { name: "script_job", args: { action: "stop", job: runningRefs[0].id } },
    { name: "script_job", args: { action: "status", job: runningRefs[1].id } },
    { name: "script_job", args: { action: "release", job: runningRefs[2].id } },
  ]);
  assert.equal(detailsOf(independentStops[0]).record?.status, "cancelled");
  assert.equal(detailsOf(independentStops[1]).status, "running");
  assert(independentStops[2].isError, "A running sibling must remain protected from release");
  await writeFile(mixedGate, "go");
  await execute("script_job", { action: "stop", job: runningRefs[1].id });
  await execute("script_job", { action: "stop", job: runningRefs[2].id });
  await execute("script_job", { action: "release", job: runningRefs[0].id });

  const exclusive = workspaces[0];
  const exclusiveGate = join(temporary, "exclusive-go");
  await writeFile(join(exclusive.root, "work", "main.mjs"), heldCode("exclusive-start", exclusiveGate));
  const runsBefore = (await readdir(join(exclusive.root, "runs"))).length;
  let conflictObserved = false;
  const stopConflictWatch = session.subscribe(event => {
    if (event.type === "tool_execution_end" && event.toolName === "script_js" && event.isError) conflictObserved = true;
  });
  const duplicate = batch([0, 1].map(() => ({ name: "script_js", args: { job: exclusive.id, purpose: "Same-job conflict", entry: "main.mjs", timeoutSeconds: 15 } })));
  try {
    await waitFor(() => existsSync(join(temporary, "exclusive-start")) && conflictObserved, "one real workspace process and one rejected duplicate");
    assert.equal((await readdir(join(exclusive.root, "runs"))).length, runsBefore + 1);
    assert(widgetText().includes("Same-job conflict (running)"), "A rejected duplicate must not mark the active job as retained");
  } finally { await writeFile(exclusiveGate, "go"); await duplicate; stopConflictWatch(); }
  const duplicateResults = await duplicate;
  assert.equal(duplicateResults.filter(value => value.isError).length, 1);
  assert.equal(detailsOf(duplicateResults.find(value => !value.isError)).record?.status, "succeeded");
  await withJobLease(exclusive, manager.getSessionId(), async () => {
    const conflicts = await batch([
      { name: "script_js", args: { job: exclusive.id, purpose: "Leased job", entry: "main.mjs", timeoutSeconds: 5 } },
      ...["release", "cleanup", "pin", "dependencies"].map(action => ({ name: "script_job", args: { action, job: exclusive.id, dependencies: {}, timeoutSeconds: 5 } })),
    ]);
    assert(conflicts.every(value => value.isError), "Runs, dependency changes and lifecycle mutations must respect the same lease");
    assert(existsSync(join(exclusive.root, "lease")));
    assert.equal((await readdir(join(exclusive.root, "runs"))).length, runsBefore + 1);
  });
  const releasedPair = await batch(workspaces.map(reference => ({ name: "script_job", args: { action: "release", job: reference.id } })));
  assert(releasedPair.every(value => !value.isError));
  assert(workspaces.every(reference => !existsSync(reference.root)));
  console.log("PASS: mixed-tool overlap; three foreground handoffs; independent stop/status; same-job run/mutation rejection; concurrent release");
  assert(session.getActiveToolNames().includes("bash"));
  for (const name of ["script_inline", "script_js", "script_job"]) assert(session.getActiveToolNames().includes(name));
  assert(!session.getAllTools().some(tool => tool.name === "script_ts" || tool.name === "script_write"));
  assert(session.systemPrompt.includes("every new temporary helper"));
  const monitoringGuidance = "For a requested manual snapshot, use script_job status for state/completion and logs for output.";
  assert(session.systemPrompt.includes(monitoringGuidance));
  assert(session.systemPrompt.includes("Do not create wait/poll helpers or read internal job files merely to check completion."));
  const assertFileTools=()=>{ for(const name of ["ls","find","grep","read","edit","write"]) assert(session?.getActiveToolNames().includes(name),`Missing dedicated tool ${name}`); };
  assertFileTools();
  await writeFile(join(temporary,"search-fixture.txt"),"NATIVE_SEARCH_MARKER\n");
  assert.match(await execute("ls",{path:temporary}),/search-fixture/u);
  assert.match(await execute("find",{path:temporary,pattern:"search-fixture.txt"}),/search-fixture/u);
  assert.match(await execute("grep",{path:join(temporary,"search-fixture.txt"),pattern:"NATIVE_SEARCH_MARKER"}),/NATIVE_SEARCH_MARKER/u);
  const created = await execute("script_job", { action: "create", purpose: "Author through normal tools" });
  const id = /^Job: (.+)$/mu.exec(created)?.[1];
  const work = /^Source directory: (.+)$/mu.exec(created)?.[1];
  assert(id && work);
  assert.match(widgetText(), /└─ ○ Author through normal tools \(retained\)/u);
  assert(!widgetText().includes(id));
  const path = join(work, "main.mjs");
  await execute("write", { path, content: 'console.log("before");\n' });
  const read = await execute("read", { path });
  const tag = /#([0-9A-F]{4})\]/u.exec(read)?.[1];
  assert(tag, read);
  await execute("edit", { input: `[${path}#${tag}]\nPUT 1:\n+console.log("after");` });
  await execute("edit", { input: `[${path}#${tag}]\nPUT 1:\n+console.log("stale");` }, true);
  await execute("ast_grep", { pat: "console.log($VALUE)", path });
  await execute("ast_edit", { ops: [{ pat: "console.log($VALUE)", out: "console.info($VALUE)" }], paths: [path] });
  await execute("write", { path: "xd://resolve", content: "Apply the reviewed helper rewrite." });
  assert.match(await execute("script_js", { job: id, entry: "main.mjs", purpose: "Run edited helper", timeoutSeconds: 5 }), /after/u);
  await session.prompt("/code-anchor off");
  await execute("edit", { path, edits: [{ oldText: '"after"', newText: '"native"' }] });
  assert.match(await execute("script_js", { job: id, entry: "main.mjs", purpose: "Run native edit", timeoutSeconds: 5 }), /native/u);
  await execute("bash", { command: "node -e 'console.log(1)'" }, true);
  await execute("bash", { command: "python -c 'print(1)'" }, true);
  await execute("bash", { command: "for x in a; do echo x; done" }, true);
  await execute("bash", { command: "git --version", timeout: 5 }, true);
  assert.match(await execute("nested_shell_fixture", {}), /Nested Bash blocked/u);
  assert.match(await execute("script_inline", { purpose: "Managed Git command", code: 'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); const child=await exec("git",["--version"],{timeoutSeconds:3}); if(child.status!=="succeeded") throw new Error(child.output); console.log(child.output);', timeoutSeconds: 5 }), /git version/u);
  const disposable = executionDetails();
  assert.equal(disposable.mode, "inline");
  assert.equal(disposable.retention?.state, "removed");
  assert(disposable.source?.text.includes('exec("git"'));
  assert(disposable.record);
  assert(!existsSync(dirname(dirname(disposable.record.run))));
  assert(disposable.commands.some(command => command.args[0] === "--version" && command.status === "succeeded"));
  await execute("script_inline", { purpose:"Retained inline fixture", code:'console.log("KEEP_INLINE");', keep:true, timeoutSeconds:5 });
  const retained = executionDetails();
  assert.equal(retained.retention?.state,"retained");
  assert(retained.record);
  assert(existsSync(retained.record.stdoutPath));
  assert.match(widgetText(), /Retained inline fixture \(retained\)/u);
  const retainedJobId = retained.record.job;
  await execute("script_js", { job: retainedJobId, entry: "main.mjs", purpose: "Rerun retained inline source", timeoutSeconds: 5 });
  assert(widgetText().includes("Rerun retained inline source (retained)"));
  const registrationsBeforeReload = widgetRegistrations;
  await session.reload();
  assert.equal(widgetRegistrations, registrationsBeforeReload + 2, "Reload must reserve exactly two panel slots");
  assert(widgetText().includes("Rerun retained inline source (retained)"));
  const reusedInline = JSON.parse(await execute("script_job", { action: "inspect", job: retainedJobId })) as { purpose: string; lastRunPurpose: string };
  assert.equal(reusedInline.purpose, "Retained inline fixture");
  assert.equal(reusedInline.lastRunPurpose, "Rerun retained inline source");
  assert.equal(executionDetails().record?.job, retainedJobId, "Reusing inline source must not create another job");
  const acceptedCode = 'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME);const child=await exec("git",["config","--file",process.env.PI_SCRIPT_WORK+"/absent.gitconfig","--get","core.hooksPath"],{timeoutSeconds:2,allowFailure:true});if(child.exitCode!==1)throw new Error("Wrong Git status");';
  await execute("script_inline", { purpose: "Expected absent Git setting", code: acceptedCode, timeoutSeconds: 5 });
  const accepted = executionDetails();
  assert.equal(accepted.retention?.state, "removed");
  assert.equal(accepted.commands[0]?.failureAccepted, true);
  assert(!widgetText().includes("Expected absent Git setting"));
  const projectScript = join(temporary, "existing.mjs");
  await writeFile(projectScript, 'console.log("established workflow");\n');
  await execute("read", { path: projectScript });
  await execute("bash", { command: "node existing.mjs", timeout: 5 }, true);
  await writeFile(join(temporary, "package.json"), JSON.stringify({ scripts: { test: "node existing.mjs" } }));
  await execute("read", { path: join(temporary, "package.json") });
  await execute("bash", { command: "npm test", timeout: 5 }, true);
  assert.match(await execute("script_inline", { purpose: "Managed project Node workflow", cwd: temporary, code: 'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); const child=await exec(process.execPath,["existing.mjs"],{timeoutSeconds:3}); if(child.status!=="succeeded") throw new Error(child.output); console.log(child.output);', timeoutSeconds: 5 }), /established workflow/u);
  for (const command of ["node --version", "node --test existing.mjs", "pwsh --version", "powershell.exe -File x.ps1"]) await execute("bash", { command, timeout: 5 }, true);
  await execute("powershell", { command: "Get-Location", timeout: 5 }, true);
  assert.equal(powerShellExecutions, 0);
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "bash"));
  assert(!session.getActiveToolNames().includes("bash"));
  assert.match(await execute("script_inline", { purpose: "No Bash dependency", code: 'console.log("without-bash");', timeoutSeconds: 5 }), /without-bash/u);
  assert.equal(widgetRegistrations, registrationsBeforeReload + 2, "Updates must redraw the reserved widgets without changing insertion order");
  await session.reload();
  assert(session.systemPrompt.includes(monitoringGuidance), "Reload must restore dedicated monitoring guidance");
  assert.match(await execute("script_job", { action: "inspect", job: id }), /Author through normal tools/u);
  assert.match(await execute("script_js", { job: id, entry: "main.mjs", purpose: "Rerun after reload", timeoutSeconds: 5 }), /native/u);
  assert(widgetText().includes("Rerun after reload (retained)"), "The retention row must match the latest workspace run purpose");
  await session.reload();
  assert(widgetText().includes("Rerun after reload (retained)"), "Reload must preserve the latest run label");
  const inspectedRun = JSON.parse(await execute("script_job", { action: "inspect", job: id })) as { purpose: string; lastRunPurpose: string };
  assert.equal(inspectedRun.purpose, "Author through normal tools");
  assert.equal(inspectedRun.lastRunPurpose, "Rerun after reload");
  await session.prompt("/temp-scripts status");
  await session.prompt("/temp-scripts invalid");
  assert(notifications.some(text => text.includes("Usage:")));
  await session.prompt("/temp-scripts off");
  assert.equal(statuses.get(STATUS_KEY), "scripts: off");
  assert(!session.getActiveToolNames().includes("script_inline"));
  assert(!session.systemPrompt.includes("every new temporary helper"));
  assertFileTools();
  assert(existsSync(path));
  await session.reload();
  assert(!session.getActiveToolNames().includes("script_inline"));
  assertFileTools();
  session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
  assert.match(await execute("bash", { command: "git --version", timeout: 5 }), /git version/u);
  await session.prompt("/temp-scripts on");
  assert.equal(statuses.get(STATUS_KEY), "scripts: on");
  assert(session.getActiveToolNames().includes("script_inline"));
  assert(session.systemPrompt.includes("every new temporary helper"));
  assertFileTools();
  await execute("bash", { command: "git --version", timeout: 5 }, true);
  const manual = await session.executeBash("git --version");
  assert.match(manual.output, /git version/u);
  const shutdownGate = join(temporary, "shutdown-go");
  const shutdownNames = ["shutdown-a", "shutdown-b"];
  const activeRun = batch(shutdownNames.map(name => ({ name: "script_inline", args: { purpose: name, code: heldCode(name, shutdownGate), timeoutSeconds: 15 } })));
  await waitFor(() => shutdownNames.every(name => existsSync(join(temporary, name))), "both actual shutdown processes");
  const shutdownPids = await Promise.all(shutdownNames.map(async name => Number(await readFile(join(temporary, name), "utf8"))));
  await session.prompt("/temp-scripts off");
  assert(notifications.some(text => text.includes("Wait for active work")));
  assert(session.getActiveToolNames().includes("script_inline"));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  for (const outcome of await activeRun) {
    const details = detailsOf(outcome);
    const job = details.record?.job ?? details.background?.job;
    assert(job);
    const reference = manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE ? [entry.data as JobReference] : []).find(reference => reference.id === job);
    assert(reference && !existsSync(join(reference.root, "lease")));
    const runs = await readdir(join(reference.root, "runs"));
    const result = JSON.parse(await readFile(join(reference.root, "runs", runs[0], "result.json"), "utf8")) as ExecutionDetails["record"];
    assert(result?.terminationConfirmed && result.status === "cancelled");
  }
  for (const pid of shutdownPids) assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  await session.reload();
  assert(session.getActiveToolNames().includes("script_inline"));

  sdk.initTheme("dark", false);
  const definition = session.getToolDefinition("script_inline");
  assert(definition);
  const args = {purpose:"Streaming check", timeoutSeconds:5, code:'console.log("VISIBLE_INLINE_SOURCE");'};
  const component = new sdk.ToolExecutionComponent("script_inline", "render-check", args, {}, definition, testTUI(new tui.Container()), temporary);
  component.setArgsComplete();
  const details:ExecutionDetails = {kind:"script-execution",mode:"inline",cwd:temporary,status:"running",elapsedMs:4000,commands:retained.commands,commandsTruncated:false,output:`${Array.from({length:40}, (_, index) => `row-${index} ${"界".repeat(10)}`).join("\n")}\nLATEST_OUTPUT`,progress:"running · elapsed 4.0s"};
  component.updateResult({ content:[{type:"text",text:details.output}], details, isError:false }, true);
  for (const width of [120,60,24]) {
    component.setExpanded(false);
    const collapsed = component.render(width).map(stripVTControlCharacters);
    assert(collapsed.join("\n").includes("LATEST_OUTPUT"));
    assert(collapsed.join("\n").includes("Inline JS"));
    assert(collapsed.join("").replace(/\s/gu, "").includes("VISIBLE_INLINE_SOURCE"));
    assert(collapsed.length <= 35);
    assert(collapsed.every(line => tui.visibleWidth(line) <= width));
    component.setExpanded(true);
    assert(component.render(width).map(stripVTControlCharacters).join("\n").includes("row-0"));
  }
  const workspaceDefinition = session.getToolDefinition("script_js");
  assert(workspaceDefinition);
  const workspaceComponent = new sdk.ToolExecutionComponent("script_js","workspace-render",{purpose:"Workspace check",entry:"main.mjs",args:["arg"],cwd:temporary,timeoutSeconds:5},{},workspaceDefinition,testTUI(new tui.Container()),temporary);
  workspaceComponent.setArgsComplete();
  workspaceComponent.updateResult({content:[{type:"text",text:"LATEST_OUTPUT"}],details:{...details,mode:"workspace",source:{text:'console.log("EXECUTED_SNAPSHOT");',truncated:false}},isError:false},false);
  const workspaceText = workspaceComponent.render(120).map(stripVTControlCharacters).join("\n");
  assert(workspaceText.includes("Workspace JS"));
  assert(workspaceText.includes("EXECUTED_SNAPSHOT"));
  assert(workspaceText.includes("main.mjs"));
  console.log("PASS: live-tail rendering at three widths, toggle/status, disabled gate restoration, retained files, and reload preference");
  await execute("script_job", { action:"pin",jobs:[id,retained.record.job] });
  assert(existsSync(path));
  const released = await execute("script_job", { action:"release",jobs:[id,retained.record.job] });
  assert.match(released, /Removed job: Author through normal tools/u);
  assert.match(released, /Removed job: Retained inline fixture/u);
  assert(!widgetText().includes("Author through normal tools"));
  assert(!widgetText().includes("Rerun after reload"));
  assert(!widgetText().includes("Retained inline fixture"));
  const jobDefinition = session.getToolDefinition("script_job");
  assert(jobDefinition);
  const releaseMessage = session.messages.findLast(value => value.role === "toolResult" && value.toolName === "script_job");
  assert(releaseMessage?.role === "toolResult");
  const releaseComponent = new sdk.ToolExecutionComponent("script_job", "release-render", { action: "release", jobs: [id, retained.record.job] }, {}, jobDefinition, testTUI(new tui.Container()), temporary);
  releaseComponent.setArgsComplete();
  releaseComponent.updateResult({ content: releaseMessage.content, details: releaseMessage.details, isError: false }, false);
  for (const width of [120, 60, 24]) {
    const lines = releaseComponent.render(width).map(stripVTControlCharacters);
    assert(lines.join("").replace(/\s/gu, "").includes("Authorthroughnormaltools"));
    assert(lines.every(line => tui.visibleWidth(line) <= width));
  }
  assert(!existsSync(dirname(work)));
  assert(!existsSync(retained.record.stdoutPath));
  await session.reload();
  const listed = await execute("script_job", {action:"list"});
  assert(!listed.includes(id));
  assert(!listed.includes(retained.record.job));
  const overflowIds: string[] = [];
  for (let index = 0; index < 14; index++) {
    const created = await execute("script_job", { action: "create", purpose: `Stored fixture ${index} 界` });
    const id = /^Job: (.+)$/mu.exec(created)?.[1];
    assert(id);
    overflowIds.push(id);
  }
  for (const width of [120, 60, 24]) {
    const lines = widgets.get("temp-scripts-retention")?.render(width) ?? [];
    assert(lines.length <= 13);
    assert(lines.every(line => tui.visibleWidth(line) <= width));
  }
  assert.match(widgetText(), /\+\d+ more/u);
  toolsExpanded = true;
  assert(widgetText().includes("Stored fixture 13"));
  assert(widgetText().includes(overflowIds[13]));
  toolsExpanded = false;
  await execute("script_job", { action: "release", jobs: overflowIds });
  assert(!widgetText().includes("Stored fixture"));
  const legacyPurpose = "Released legacy fixture awaiting cleanup";
  const legacyCreated = await execute("script_job", { action: "create", purpose: legacyPurpose });
  const legacyId = /^Job: (.+)$/mu.exec(legacyCreated)?.[1];
  assert(legacyId);
  const legacyEntry = manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE && (entry.data as JobReference).id === legacyId);
  assert(legacyEntry?.type === "custom");
  const legacy = legacyEntry.data as JobReference;
  await setRetention(legacy, manager.getSessionId(), "released");
  await session.reload();
  assert(!widgetText().includes(legacyPurpose), "Released files must not reappear in the retention panel after reload");
  assert(existsSync(legacy.root), "Hiding a released job must not delete its files");
  assert.match(await execute("script_job", { action: "list" }), new RegExp(`${legacyId} · released`, "u"));
  await execute("script_job", { action: "retain", job: legacyId });
  assert(widgetText().includes(legacyPurpose), "Explicitly retaining the job must restore its panel row");
  await setRetention(legacy, manager.getSessionId(), "released");
  await session.reload();
  assert(!widgetText().includes(legacyPurpose));
  assert(existsSync(legacy.root));
  await execute("script_job", { action: "cleanup", job: legacyId });
  assert(!existsSync(legacy.root), "Hidden released files must remain available for explicit cleanup");
  console.log("PASS: released legacy records stay hidden after reload; files and list/retain/cleanup access remain available");
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: discovery; three JS-only tools; native/CodeAnchor authoring; stale edits; AST application; blanket and nested shell gates; managed Git/project Node execution; Bash-disabled execution; reload; release/cleanup; zero external model/network requests");
} finally {
  globalThis.fetch = originalFetch;
  if (previousStorage === undefined) delete process.env.PI_TEMP_SCRIPTS_DIR;
  else process.env.PI_TEMP_SCRIPTS_DIR = previousStorage;
  try { if (session) { await session.abort(); await session.waitForIdle(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally {
    for (const root of owned) {
      assert(!existsSync(join(root,"lease")),"Unresolved integration job retained");
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    for (const root of owned) assert(!existsSync(root));
    console.log("CLEANUP: sessions, processes, and owned integration fixtures stopped and removed");
  }
}
