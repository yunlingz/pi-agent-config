import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testUI } from "../../scripts/test-fixtures.ts";
import { STATUS_KEY } from "./controls.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(resolve(installation), "dist/index.js")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", resolve(installation))).href);
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-integration-"));
let session: AgentSession | undefined;
let phase = "loading the real Pi extension";
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] CodeAnchor integration: ${phase}\n`), 20_000);
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("CodeAnchor offline verification must not use the network"); };
  const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(temporary, "auth.json"), modelsPath: null, modelsStorePath: join(temporary, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  let pendingCall: Pick<ToolCall, "id" | "name" | "arguments"> | undefined;
  let sequence = 0;
  runtime.registerProvider("code-anchor-fixture", {
    api: "code-anchor-fixture", apiKey: "unused-local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Unused local fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = ai.createAssistantMessageEventStream();
      const call = pendingCall;
      pendingCall = undefined;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", ...call }] : [{ type: "text", text: "Local fixture finished." }],
        stopReason: call ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const extensionDirectory = join(temporary, "extensions");
  await mkdir(extensionDirectory);
  await symlink(dirname(fileURLToPath(import.meta.url)), join(extensionDirectory, "code-anchor"), process.platform === "win32" ? "junction" : "dir");
  const loader = new sdk.DefaultResourceLoader({
    cwd: temporary, agentDir: temporary, settingsManager: settings,
    disabledBuiltinExtensions: ["mcp"], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerTool(sdk.createGrepToolDefinition(temporary))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2, "Pi must discover CodeAnchor without an explicit extension path");
  ({ session } = await sdk.createAgentSession({ cwd: temporary, agentDir: temporary, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("code-anchor-fixture", "fixture"), thinkingLevel: "off", resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory() }));
  const statuses = new Map<string, string>();
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "tui", uiContext: testUI(session, {
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify() {},
  }), onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  let runner = session.extensionRunner;
  const execute = async (name: string, args: ToolCall["arguments"], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const id = `fixture-${++sequence}`;
    pendingCall = { id, name, arguments: args };
    await session?.prompt("Execute the planned local tool fixture.");
    const outcome = session?.messages.findLast(message => message.role === "toolResult" && message.toolCallId === id);
    assert(outcome?.role === "toolResult", "The real Pi tool loop must record the tool result");
    const text = outcome.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    if (outcome.isError) throw new Error(text);
    return text;
  };
  const file = join(temporary, "file.ts");
  await writeFile(file, "console.log(answer);\r\n");
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: on");
  assert(runner.getActiveTools().includes("ast_grep"));
  assert(runner.getActiveTools().includes("ast_edit"));

  phase = "checking hashline read/edit through Pi's tool validation";
  const read = await execute("read", { path: "file.ts" });
  const tag = /\[file\.ts#([0-9A-F]{4})\]/u.exec(read)?.[1];
  assert(tag, read);
  await execute("edit", { input: `[file.ts#${tag}]\nPUT 1:\n+console.log(value);` });
  assert.equal(await readFile(file, "utf8"), "console.log(value);\r\n");

  phase = "checking shared Pi file locks";
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const stopObserving = session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.toolName === "edit") started.resolve();
  });
  const current = await execute("read", { path: "file.ts" });
  const currentTag = /\[file\.ts#([0-9A-F]{4})\]/u.exec(current)?.[1];
  assert(currentTag);
  const blocker = sdk.withFileMutationQueue(file, async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const blockedEdit = execute("edit", { input: `[file.ts#${currentTag}]\nPUT 1:\n+console.log(lockedValue);` });
  try {
    await started.promise;
    assert.equal(await readFile(file, "utf8"), "console.log(value);\r\n");
  } finally {
    release.resolve();
    stopObserving();
    await blocker;
    await blockedEdit;
  }
  assert.equal(await readFile(file, "utf8"), "console.log(lockedValue);\r\n");
  await writeFile(file, "console.log(value);\r\n");

  phase = "checking structural search, staged rewrite and resolution";
  const found = await execute("ast_grep", { pat: "console.log($VALUE)", path: "*.ts" });
  assert.match(found, /1 matches/u);
  assert.match(found, /\[file\.ts#[0-9A-F]{4}\]/u);
  const preview = await execute("ast_edit", { ops: [{ pat: "console.log($VALUE)", out: "logger.info($VALUE)" }], paths: ["*.ts"] });
  assert.match(preview, /Preview only/u);
  assert.equal(await readFile(file, "utf8"), "console.log(value);\r\n");
  await execute("write", { path: "xd://resolve", content: "The preview contains the requested structural change." });
  assert.equal(await readFile(file, "utf8"), "logger.info(value);\r\n");
  await execute("ast_edit", { ops: [{ pat: "logger.info($VALUE)", out: "console.log($VALUE)" }], paths: ["file.ts"] });
  await execute("write", { path: "xd://reject", content: "Keep the current logger call." });
  assert.equal(await readFile(file, "utf8"), "logger.info(value);\r\n");
  await execute("ast_edit", { ops: [{ pat: "logger.info($VALUE)", out: "console.log($VALUE)" }], paths: ["file.ts"] });
  await writeFile(file, "logger.warn(outsideChange);\r\n");
  await assert.rejects(execute("write", { path: "xd://resolve", content: "Check the stale-preview report." }), /Preview is stale/u);
  assert.equal(await readFile(file, "utf8"), "logger.warn(outsideChange);\r\n");
  await writeFile(file, "logger.info(value);\r\n");

  phase = "checking actual tool replacement and default-on preference";
  await session.prompt("/code-anchor off");
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: off");
  assert(!runner.getActiveTools().includes("ast_grep"));
  assert(!runner.getActiveTools().includes("ast_edit"));
  await session.reload();
  runner = session.extensionRunner;
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: off");
  assert(!runner.getActiveTools().includes("ast_grep"));
  const ordinary = await execute("read", { path: "file.ts" });
  assert(!ordinary.includes("[file.ts#"));
  await execute("edit", { path: "file.ts", edits: [{ oldText: "logger.info(value);", newText: "logger.warn(value);" }] });
  assert.equal(await readFile(file, "utf8"), "logger.warn(value);\r\n");
  await session.prompt("/code-anchor on");
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: on");
  assert.match(await execute("read", { path: "file.ts" }), /\[file\.ts#[0-9A-F]{4}\]/u);
  phase = "checking ordinary write, grep fallback, and image delegation";
  await execute("write", { path: "fallback.scss", content: "$color: red;\nbody { color: $color; }\n" });
  assert.equal(await readFile(join(temporary, "fallback.scss"), "utf8"), "$color: red;\nbody { color: $color; }\n");
  const fallback = await execute("grep", { pattern: "color", path: "fallback.scss" });
  assert.match(fallback, /color/u);
  const imagePath = join(temporary, "pixel.data");
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await execute("read", { path: "pixel.data" });
  const imageResult = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "read");
  assert(imageResult?.role === "toolResult" && imageResult.content.some(block => block.type === "image"), "Image detection must use content, not only the file extension");

  phase = "checking native compaction file metadata";
  const compaction: typeof import("@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js") = await import(pathToFileURL(join(resolve(installation), "dist/core/compaction/compaction.js")).href);
  const branchEntries = session.sessionManager.getBranch();
  const preparation = compaction.prepareCompaction(branchEntries, { enabled: true, reserveTokens: 1024, keepRecentTokens: 0 });
  assert(preparation);
  await runner.emit({ type: "session_before_compact", reason: "manual", willRetry: false, preparation, branchEntries, customInstructions: undefined, signal: new AbortController().signal });
  const canonicalFile = await realpath(file);
  assert(preparation.fileOps.edited.has(canonicalFile.replaceAll("\\", "/")) || preparation.fileOps.edited.has(canonicalFile));
  assert(!preparation.fileOps.written.has("xd://resolve"));
  assert(!preparation.fileOps.written.has("xd://reject"));
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: automatic Pi discovery, default-on activation, tool schemas, portable WASM worker, hashline edit, AST search/preview/apply/discard, real on/off tool replacement, footer statuses and native compaction metadata; local provider fixtures only; zero network requests");
} finally {
  clearInterval(heartbeat);
  globalThis.fetch = originalFetch;
  try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); assert.equal(existsSync(temporary), false); console.log("CLEANUP: CodeAnchor workers stopped and owned integration fixtures removed"); }
}
