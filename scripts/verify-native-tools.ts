import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";
import { closeLiveSession } from "./live-verification.ts";
import { readJson, readPackageInfo, resolveInstalledEntry } from "./verification-data.ts";

const argument = process.argv[2];
assert(argument && process.argv.length === 3, "Usage: node scripts/verify-native-tools.ts <installed-pi-package-directory>");
const packageDirectory = resolve(argument);
assert.equal(readPackageInfo(join(packageDirectory, "package.json")).name, "@earendil-works/pi-coding-agent");
const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const root = await mkdtemp(join(tmpdir(), "pi-native-tools-"));
const originalFetch = globalThis.fetch;
let session: AgentSession | undefined;
let networkAttempts = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("The native-tools fixture must not use the network."); };
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", packageDirectory)).href);
  const require = createRequire(join(packageDirectory, "package.json"));
  const { Type }: typeof import("typebox") = await import(pathToFileURL(require.resolve("typebox")).href);
  const saved = readJson<ReturnType<SettingsManager["getGlobalSettings"]>>(join(agentDirectory, "settings.json"));
  assert.deepEqual(saved.defaultTools, nativeNames, "All retained native tools must be enabled by default.");
  const settings = sdk.SettingsManager.inMemory({
    ...saved,
    enabledModels: [], defaultProvider: "native-tools-fixture", defaultModel: "fixture", defaultThinkingLevel: "off", modelThinkingLevels: {},
    retry: { enabled: false }, cacheWarming: "off", compaction: { enabled: false },
  });
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  let requests = 0;
  runtime.registerProvider("native-tools-fixture", {
    api: "native-tools-fixture", apiKey: "local-fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Native-tools fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const reason = requests++ === 0 ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: reason,
        content: reason === "toolUse" ? [{ type: "toolCall", id: "native-suite", name: "native_fixture", arguments: {} }]
          : [{ type: "text", text: "NATIVE_TOOLS_OK" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(); });
      return stream;
    },
  });
  let completed = false;
  let phase = "ready";
  const fixture: ExtensionFactory = pi => {
    pi.registerTool({
      name: "native_fixture", label: "Native fixture", description: "Exercise native tools on owned temporary files.", parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        const path = join(root, "fixture.txt");
        phase = "read";
        const read = await ctx.executeTool("read", { path });
        assert.equal(read.isError, false);
        assert(read.result.content.some(block => block.type === "text" && block.text.includes("before")));
        phase = "edit";
        const edit = await ctx.executeTool("edit", { path, edits: [{ oldText: "before", newText: "after" }] });
        assert.equal(edit.isError, false);
        assert.equal(await readFile(path, "utf8"), "after\n");
        phase = "bash";
        const shell = await ctx.executeTool("bash", { command: "printf 'NATIVE_SHELL_OK\\n'", timeout: 5 });
        assert.equal(shell.isError, false);
        assert(shell.result.content.some(block => block.type === "text" && block.text.includes("NATIVE_SHELL_OK")));
        phase = "write";
        const write = await ctx.executeTool("write", { path: join(root, "created.txt"), content: "created\n" });
        assert.equal(write.isError, false);
        assert.equal(await readFile(join(root, "created.txt"), "utf8"), "created\n");
        completed = true;
        return { content: [{ type: "text", text: "Native fixture complete." }], details: undefined };
      },
    });
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: agentDirectory, settingsManager: settings, extensionFactories: [fixture],
    disabledBuiltinExtensions: ["mcp"], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "The remaining global extensions must load without errors.");
  const created = await sdk.createAgentSession({
    cwd: root, agentDir: agentDirectory, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("native-tools-fixture", "fixture"), thinkingLevel: "off", sessionManager: sdk.SessionManager.create(root, join(root, "sessions")),
  });
  session = created.session;
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  session.subscribe(event => {
    if (event.type === "tool_execution_end") console.log("NATIVE_TOOL_EVENT", JSON.stringify({ tool: ["native_fixture", "read", "edit", "bash", "write"].includes(event.toolName) ? event.toolName : "other", failed: event.isError, phase }));
  });
  const checkNative = () => {
    assert(session);
    for (const name of nativeNames) {
      assert(session.getActiveToolNames().includes(name), `${name} must remain active.`);
      assert.equal(session.getAllTools().find(tool => tool.name === name)?.sourceInfo.path, `builtin:${name}`, `${name} must use the native definition.`);
    }
  };
  checkNative();
  await writeFile(join(root, "fixture.txt"), "before\n");
  await session.prompt("Run the native fixture.");
  await session.waitForIdle();
  console.log("NATIVE_EXECUTION", JSON.stringify({ phase, completed, requests, extensionErrors: errors.length, fixtureAvailable: session.getAllTools().some(tool => tool.name === "native_fixture"), fixtureActive: session.getActiveToolNames().includes("native_fixture") }));
  assert(completed, "The actual native tool pipeline must complete.");
  assert.equal(session.getLastAssistantText(), "NATIVE_TOOLS_OK");
  assert.equal(requests, 2, "Only the controlled model requests may run.");
  await session.reload();
  checkNative();
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: remaining global extensions; seven native defaults and source metadata; actual nested read/edit/bash/write; reload; zero network requests.");
} finally {
  try { if (session) await closeLiveSession(session); }
  finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
    console.log("CLEANUP: native-tools session stopped and owned fixtures removed.");
  }
}
