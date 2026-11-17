import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testTUI, testUI } from "../../scripts/test-fixtures.ts";
import { STATUS_KEY } from "./controls.ts";
import { stripVTControlCharacters } from "node:util";
import { ENTRY_TYPE, type JobReference } from "./types.ts";

const installation = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node verify-integration.ts <installed-pi-package-directory>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(installation, "dist/index.js")).href);
const { Type }: typeof import("typebox") = await import(pathToFileURL(createRequire(join(installation, "package.json")).resolve("typebox")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", installation)).href);
const temporary = await mkdtemp(join(tmpdir(), "temp-scripts-integration-"));
let session: AgentSession | undefined;
const owned = new Set<string>();
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Offline integration cannot access the network"); };
  const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], retry: { enabled: false }, compaction: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(temporary, "auth.json"), modelsPath: null, modelsStorePath: join(temporary, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  let pending: ToolCall | undefined;
  let count = 0;
  runtime.registerProvider("managed-script-fixture", {
    api: "managed-script-fixture", apiKey: "unused-local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = ai.createAssistantMessageEventStream();
      const call = pending;
      pending = undefined;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [call] : [{ type: "text", text: "Fixture finished." }], stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); });
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
  await session.bindExtensions({ mode: "tui", uiContext: testUI(session, {
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify(message) { notifications.push(message); },
  }), onError: error => errors.push(error) });
  assert.equal(statuses.get(STATUS_KEY), "scripts: on");
  const execute = async (name: string, args: ToolCall["arguments"], error = false): Promise<string> => {
    const id = `fixture-${++count}`;
    pending = { type: "toolCall", id, name, arguments: args };
    await session?.prompt("Execute the planned local fixture.");
    for (const entry of manager.getEntries()) if (entry.type === "custom" && entry.customType === ENTRY_TYPE) owned.add((entry.data as JobReference).root);
    const outcome = session?.messages.findLast(message => message.role === "toolResult" && message.toolCallId === id);
    assert(outcome?.role === "toolResult");
    const text = outcome.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.equal(outcome.isError, error, text);
    return text;
  };
  assert(session.getActiveToolNames().includes("bash"));
  for (const name of ["script_inline", "script_js", "script_job"]) assert(session.getActiveToolNames().includes(name));
  assert(!session.getAllTools().some(tool => tool.name === "script_ts" || tool.name === "script_write"));
  assert(session.systemPrompt.includes("every new temporary helper"));
  const created = await execute("script_job", { action: "create", purpose: "Author through normal tools" });
  const id = /^Job: (.+)$/mu.exec(created)?.[1];
  const work = /^Source directory: (.+)$/mu.exec(created)?.[1];
  assert(id && work);
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
  await session.reload();
  assert.match(await execute("script_job", { action: "inspect", job: id }), /Author through normal tools/u);
  assert.match(await execute("script_js", { job: id, entry: "main.mjs", purpose: "Rerun after reload", timeoutSeconds: 5 }), /native/u);
  await session.prompt("/temp-scripts status");
  await session.prompt("/temp-scripts invalid");
  assert(notifications.some(text => text.includes("Usage:")));
  await session.prompt("/temp-scripts off");
  assert.equal(statuses.get(STATUS_KEY), "scripts: off");
  assert(!session.getActiveToolNames().includes("script_inline"));
  assert(!session.systemPrompt.includes("every new temporary helper"));
  assert(existsSync(path));
  await session.reload();
  assert(!session.getActiveToolNames().includes("script_inline"));
  session.setActiveToolsByName([...session.getActiveToolNames(), "bash"]);
  assert.match(await execute("bash", { command: "git --version", timeout: 5 }), /git version/u);
  await session.prompt("/temp-scripts on");
  assert.equal(statuses.get(STATUS_KEY), "scripts: on");
  assert(session.getActiveToolNames().includes("script_inline"));
  assert(session.systemPrompt.includes("every new temporary helper"));
  await execute("bash", { command: "git --version", timeout: 5 }, true);
  const manual = await session.executeBash("git --version");
  assert.match(manual.output, /git version/u);
  const started = Promise.withResolvers<void>();
  const stopWatching = session.subscribe(event => {
    if (event.type === "tool_execution_update" && event.toolName === "script_inline") started.resolve();
  });
  const activeRun = execute("script_inline", {purpose:"Shutdown fixture", code:"setInterval(() => {}, 1000);", timeoutSeconds:10}, true);
  try {
    await started.promise;
    await session.prompt("/temp-scripts off");
    assert(notifications.some(text => text.includes("Wait for active work")));
    assert(session.getActiveToolNames().includes("script_inline"));
    await session.extensionRunner.emit({type:"session_shutdown",reason:"reload"});
    await activeRun;
  } finally { stopWatching(); }
  await session.reload();
  assert(session.getActiveToolNames().includes("script_inline"));

  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", installation)).href);
  sdk.initTheme("dark", false);
  const definition = session.getToolDefinition("script_inline");
  assert(definition);
  const component = new sdk.ToolExecutionComponent("script_inline", "render-check", {purpose:"Streaming check", timeoutSeconds:5}, {}, definition, testTUI(new tui.Container()), temporary);
  component.setArgsComplete();
  const streamed = `Streaming check\nrunning · elapsed 4.0s\n${Array.from({length:40}, (_, index) => `row-${index} ${"界".repeat(10)}`).join("\n")}\nLATEST_OUTPUT`;
  component.updateResult({ content:[{type:"text",text:streamed}], details:undefined, isError:false }, true);
  for (const width of [120,60,24]) {
    component.setExpanded(false);
    const collapsed = component.render(width).map(stripVTControlCharacters);
    assert(collapsed.join("\n").includes("LATEST_OUTPUT"));
    assert(collapsed.length <= 20);
    assert(collapsed.every(line => tui.visibleWidth(line) <= width));
    component.setExpanded(true);
    assert(component.render(width).map(stripVTControlCharacters).join("\n").includes("row-0"));
  }
  console.log("PASS: live-tail rendering at three widths, toggle/status, disabled gate restoration, retained files, and reload preference");
  await execute("script_job", { action: "release", job: id });
  await execute("script_js", { job: id, entry: "main.mjs", purpose: "Released job", timeoutSeconds: 5 }, true);
  await execute("script_job", { action: "cleanup", job: id, immediate: true });
  assert(!existsSync(dirname(work)));
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: discovery; three JS-only tools; native/CodeAnchor authoring; stale edits; AST application; blanket and nested shell gates; managed Git/project Node execution; Bash-disabled execution; reload; release/cleanup; zero external model/network requests");
} finally {
  globalThis.fetch = originalFetch;
  try { if (session) { await session.abort(); await session.waitForIdle(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally {
    for (const root of owned) await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    for (const root of owned) assert(!existsSync(root));
    console.log("CLEANUP: sessions, processes, and owned integration fixtures stopped and removed");
  }
}
