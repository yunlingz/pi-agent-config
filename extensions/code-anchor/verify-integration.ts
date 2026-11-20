import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testTUI, testUI } from "../../scripts/test-fixtures.ts";
import { STATUS_KEY } from "./controls.ts";
import type { GrammarManifest } from "./scripts/grammar-types.ts";
import type { TObject, TObjectOptions, TSchemaOptions } from "typebox";

const installation = process.argv[2];
assert(installation, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(resolve(installation), "dist/index.js")).href);
const require = createRequire(pathToFileURL(join(resolve(installation), "package.json")));
const { Type }: typeof import("typebox") = await import(pathToFileURL(require.resolve("typebox")).href);
const { Check }: typeof import("typebox/value") = await import(pathToFileURL(require.resolve("typebox/value")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", resolve(installation))).href);
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-integration-"));
let session: AgentSession | undefined;
let phase = "loading the real Pi extension";
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] CodeAnchor integration: ${phase}\n`), 20_000);
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
let expectedGuidelines: string[] = [];
let excludedGuidelines: string[] = [];
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("CodeAnchor offline verification must not use the network"); };
  const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], defaultTools: ["+grep", "+find", "+ls"], compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(temporary, "auth.json"), modelsPath: null, modelsStorePath: join(temporary, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  let pendingCall: Pick<ToolCall, "id" | "name" | "arguments"> | undefined;
  let sequence = 0;
  runtime.registerProvider("code-anchor-fixture", {
    api: "code-anchor-fixture", apiKey: "unused-local-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Unused local fixture", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const prompt = ai.getCurrentSystemPrompt(context.messages);
      for (const guideline of expectedGuidelines) assert(prompt.includes(guideline), "Active tool guidance must reach the provider");
      for (const guideline of excludedGuidelines) assert(!prompt.includes(guideline), "Disabled CodeAnchor guidance must not reach the provider");
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
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1, "Pi must discover CodeAnchor without an explicit extension path");
  ({ session } = await sdk.createAgentSession({ cwd: temporary, agentDir: temporary, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("code-anchor-fixture", "fixture"), thinkingLevel: "off", resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(), customTools: [{
    name: "native_attempt", label: "Native guard fixture", description: "Exercise actual nested native calls in the fixture.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      assert(session);
      session.setActiveToolsByName([...session.getActiveToolNames(), "read", "edit"]);
      const result = await ctx.executeTool("read", { path: "file.ts" });
      assert(result.isError);
      assert(result.result.content.some(block => block.type === "text" && block.text.includes("CodeAnchor is on")));
      session.setActiveToolsByName([...session.getActiveToolNames(), "edit"]);
      const edit = await ctx.executeTool("edit", { path: "file.ts", edits: [{ oldText: "logger.info(value);", newText: "BAD;" }] });
      assert(edit.isError);
      assert(edit.result.content.some(block => block.type === "text" && block.text.includes("CodeAnchor is on")));
      return { content: [{ type: "text", text: "Both nested native calls were blocked." }], details: undefined };
    },
  }] }));
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
  const builtinNames = ["bash", "write", "grep", "find", "ls"];
  const codeAnchorNames = ["hashline_read", "hashline_edit", "ast_grep", "ast_edit"];
  for (const name of [...builtinNames, ...codeAnchorNames]) {
    assert(runner.getActiveTools().includes(name), `CodeAnchor must retain ${name}`);
  }
  for (const name of ["read", "edit"]) assert(!runner.getActiveTools().includes(name), `Native ${name} must be inactive`);
  const manifest = JSON.parse(await readFile(new URL("./grammars.json", import.meta.url), "utf8")) as GrammarManifest;
  const grammarNames = manifest.grammars.map(grammar => grammar.name);
  for (const name of ["ast_grep", "ast_edit"]) {
    const tool = session.getAllTools().find(candidate => candidate.name === name);
    assert(tool);
    const advertised = /Supported grammars \((\d+)\): ([^.]+)\./u.exec(tool.description);
    assert(advertised, `${name} must expose its bundled grammar scope`);
    assert.equal(Number(advertised[1]), grammarNames.length);
    assert.deepEqual(advertised[2]?.split(", "), grammarNames);
  }
  const nativeDefinitions = [sdk.createReadToolDefinition(temporary), sdk.createEditToolDefinition(temporary), sdk.createWriteToolDefinition(temporary)];
  const nativeGuidelines = nativeDefinitions.flatMap(tool => tool.promptGuidelines ?? []);
  const codeAnchorTools = session.getAllTools().filter(tool => [...codeAnchorNames, "write"].includes(tool.name));
  assert.equal(codeAnchorTools.length, 5);
  const codeAnchorGuidelines = codeAnchorTools.flatMap(tool => tool.promptGuidelines ?? []).filter(rule => !nativeGuidelines.includes(rule));
  const guidance = (name: string): string => {
    const tool = codeAnchorTools.find(candidate => candidate.name === name);
    assert(tool);
    return [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
  };
  assert.match(guidance("hashline_read"), /multiple files.*separate hashline_read calls/iu);
  assert.match(guidance("hashline_read"), /omitted ranges/u);
  const searchGuidance = guidance("ast_grep");
  assert.match(searchGuidance, /Prefer Pi's built-in text-search tool \(grep\)/u);
  assert(searchGuidance.indexOf("built-in text-search") < searchGuidance.indexOf("try ripgrep"));
  assert(searchGuidance.indexOf("try ripgrep") < searchGuidance.indexOf("another available text-search method"));
  assert.match(searchGuidance, /params\.include = \$VALUE/u);
  assert.match(guidance("ast_edit"), /unsupported syntax.*hashline_edit/iu);
  assert.match(guidance("ast_grep"), /rg --files/u);
  assert.match(guidance("ast_grep"), /available command-execution tool/u);
  assert.doesNotMatch(guidance("ast_grep"), /use bash|script_inline|script_js/iu);
  assert.match(guidance("hashline_edit"), /stale anchors/u);
  assert.match(guidance("hashline_edit"), /applicable checks/u);
  assert.match(guidance("ast_edit"), /match count/iu);
  assert.match(guidance("write"), /xd:\/\/resolve/u);
  const assertGuidance = (enabled: boolean): void => {
    expectedGuidelines = enabled ? codeAnchorGuidelines : nativeDefinitions.filter(tool => tool.name === "write").flatMap(tool => tool.promptGuidelines ?? []);
    excludedGuidelines = enabled ? [] : codeAnchorGuidelines;
    for (const guideline of expectedGuidelines) assert(session?.systemPrompt.includes(guideline), "Active tool guidance must reach Pi's prompt");
    for (const guideline of excludedGuidelines) assert(!session?.systemPrompt.includes(guideline), "Disabled guidance must leave Pi's prompt");
    if (!enabled) {
      for (const native of nativeDefinitions) {
        const restored = session?.getAllTools().find(tool => tool.name === native.name);
        assert(restored);
        assert.equal(restored.description, native.description);
        assert.deepEqual(restored.promptGuidelines, native.promptGuidelines);
        assert.deepEqual(restored.parameters, native.parameters);
      }
    }
  };
  assertGuidance(true);

  phase = "checking all exposed parameter schemas and examples";
  const invalidArguments: [string, ToolCall["arguments"]][] = [
    ["hashline_read", {}], ["hashline_read", { path: "" }],
    ["hashline_read", { paths: ["file.ts"] }], ["hashline_read", { path: "file.ts", extra: true }],
    ["hashline_read", { path: "file.ts", offset: 0 }], ["hashline_read", { path: "file.ts", limit: "not-a-number" }],
    ["hashline_edit", { input: "" }], ["hashline_edit", { input: "invalid", path: "file.ts" }],
    ["ast_grep", { pat: "" }], ["ast_grep", { pat: "console.log($VALUE)", path: "" }],
    ["ast_grep", { pat: "console.log($VALUE)", lang: "" }], ["ast_grep", { pat: "console.log($VALUE)", skip: -1 }],
    ["ast_grep", { pat: "console.log($VALUE)", skip: "not-a-number" }], ["ast_grep", { pat: "console.log($VALUE)", paths: ["file.ts"] }],
    ["ast_edit", { paths: ["file.ts"], ops: [] }], ["ast_edit", { paths: [], ops: [{ pat: "console.log($VALUE)", out: "" }] }],
    ["ast_edit", { paths: [""], ops: [{ pat: "console.log($VALUE)", out: "" }] }],
    ["ast_edit", { paths: ["file.ts"], ops: [{ pat: "", out: "" }] }],
    ["ast_edit", { paths: ["file.ts"], ops: [{ pat: "console.log($VALUE)" }] }],
    ["ast_edit", { paths: ["file.ts"], ops: [{ pat: "console.log($VALUE)", out: "", extra: true }] }],
    ["write", { path: "", content: "" }], ["write", { path: "empty.txt" }], ["write", { path: "empty.txt", content: "", extra: true }],
  ];
  for (const name of [...codeAnchorNames, "write"]) {
    const definition: ReturnType<AgentSession["getToolDefinition"]> = session.getToolDefinition(name);
    assert(definition);
    // Every registered tool here supplies a TypeBox object schema with field options.
    const schema = definition.parameters as TObject<Record<string, TSchemaOptions>> & TObjectOptions;
    assert.equal(schema.additionalProperties, false, `${name}: reject unknown fields`);
    for (const property of Object.values(schema.properties)) assert(property.description, `${name}: describe every field`);
  }
  for (const [name, args] of invalidArguments) {
    const definition = session.getToolDefinition(name);
    assert(definition && !Check(definition.parameters, args), `${name}: invalid schema fixture unexpectedly passes`);
    await assert.rejects(execute(name, args), `${name}: Pi must reject ${JSON.stringify(args)}`);
  }
  assert.equal(await readFile(file, "utf8"), "console.log(answer);\r\n");
  const literalName = "literal;name,with comma.txt";
  await writeFile(join(temporary, literalName), "one\ntwo\nthree\nfour\nfive\n");
  const selected = await execute("hashline_read", { path: `${literalName}:1-1,5-5` });
  assert.match(selected, /1:one/u); assert.match(selected, /5:five/u); assert(!selected.includes("3:three"));
  assert.match(await execute("hashline_read", { path: literalName, offset: 2, limit: 1 }), /2:two/u);
  assert.match(await execute("hashline_read", { path: literalName, offset: "2", limit: 1.5 }), /2:two/u);
  await execute("write", { path: "empty.txt", content: "" });
  assert.equal(await readFile(join(temporary, "empty.txt"), "utf8"), "");
  await assert.rejects(execute("write", { path: "xd://reject", content: "" }), /reason/u);
  await writeFile(join(temporary, "schema-one.ts"), "console.log(1);\n");
  await writeFile(join(temporary, "schema-two.ts"), "console.log(2);\n");
  assert.match(await execute("ast_grep", { pat: "console.log($VALUE)", path: "schema-one.ts;schema-two.ts", lang: "ts", skip: 0 }), /2 matches/u);
  const skipped = await execute("ast_grep", { pat: "console.log($VALUE)", path: "schema-one.ts;schema-two.ts", skip: 1.5 });
  assert.match(skipped, /schema-two\.ts/u); assert(!skipped.includes("[schema-one.ts#"));
  await execute("ast_edit", { paths: ["schema-one.ts", "schema-two.ts"], ops: [{ pat: "console.log($VALUE);", out: "" }] });
  await execute("write", { path: "xd://resolve", content: "Delete only the two reviewed calls." });
  assert.equal((await readFile(join(temporary, "schema-one.ts"), "utf8")).trim(), "");
  assert.equal((await readFile(join(temporary, "schema-two.ts"), "utf8")).trim(), "");
  console.log(`PASS: ${invalidArguments.length} invalid argument shapes rejected by Pi; all field descriptions, literal filenames, ranges, empty contents, target arrays, language alias, and empty AST replacement verified`);
  assert.match(await execute("ls", { path: "." }), /file\.ts/u);
  assert.match(await execute("find", { pattern: "*.ts", path: "." }), /file\.ts/u);

  phase = "checking hashline read/edit through Pi's tool validation";
  const read = await execute("hashline_read", { path: "file.ts" });
  const tag = /\[file\.ts#([0-9A-F]{4})\]/u.exec(read)?.[1];
  assert(tag, read);
  await execute("hashline_edit", { input: `[file.ts#${tag}]\nPUT 1:\n+console.log(value);` });
  assert.equal(await readFile(file, "utf8"), "console.log(value);\r\n");

  phase = "checking shared Pi file locks";
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const stopObserving = session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.toolName === "hashline_edit") started.resolve();
  });
  const current = await execute("hashline_read", { path: "file.ts" });
  const currentTag = /\[file\.ts#([0-9A-F]{4})\]/u.exec(current)?.[1];
  assert(currentTag);
  const blocker = sdk.withFileMutationQueue(file, async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const blockedEdit = execute("hashline_edit", { input: `[file.ts#${currentTag}]\nPUT 1:\n+console.log(lockedValue);` });
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

  phase = "checking separate tools, native blocking, and default-on preference";
  await assert.rejects(execute("read", { path: "file.ts" }), /not found|not callable|unknown tool|CodeAnchor is on/iu);
  await assert.rejects(execute("edit", { path: "file.ts", edits: [{ oldText: "logger.info(value);", newText: "BAD;" }] }), /not found|not callable|unknown tool|CodeAnchor is on/iu);
  assert.equal(await readFile(file, "utf8"), "logger.info(value);\r\n");
  assert.match(await execute("native_attempt", {}), /Both nested native calls were blocked/u);
  for (const name of ["read", "edit"]) assert(!session.getActiveToolNames().includes(name));
  assert.equal(await readFile(file, "utf8"), "logger.info(value);\r\n");
  await session.prompt("/code-anchor off");
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: off");
  for (const name of codeAnchorNames) assert(!runner.getActiveTools().includes(name));
  for (const name of ["read", "edit"]) assert(!runner.getActiveTools().includes(name), `Off must not activate native ${name}`);
  for (const name of builtinNames) assert(runner.getActiveTools().includes(name));
  assertGuidance(false);
  await session.reload();
  runner = session.extensionRunner;
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: off");
  assert(!runner.getActiveTools().includes("ast_grep"));
  assertGuidance(false);
  for (const name of ["read", "edit", ...codeAnchorNames]) assert(!runner.getActiveTools().includes(name));
  session.setActiveToolsByName([...session.getActiveToolNames(), "read", "edit"]);
  const ordinary = await execute("read", { path: "file.ts" });
  assert(!ordinary.includes("[file.ts#"));
  await execute("edit", { path: "file.ts", edits: [{ oldText: "logger.info(value);", newText: "logger.warn(value);" }] });
  assert.equal(await readFile(file, "utf8"), "logger.warn(value);\r\n");
  await session.prompt("/code-anchor on");
  assert.equal(statuses.get(STATUS_KEY), "code-anchor: on");
  assertGuidance(true);
  for (const name of ["read", "edit"]) assert(!runner.getActiveTools().includes(name));
  assert.match(await execute("hashline_read", { path: "file.ts" }), /\[file\.ts#[0-9A-F]{4}\]/u);
  await session.reload();
  runner = session.extensionRunner;
  assertGuidance(true);
  phase = "checking ordinary write, grep fallback, and image delegation";
  await execute("write", { path: "fallback.scss", content: "$color: red;\nbody { color: $color; }\n" });
  assert.equal(await readFile(join(temporary, "fallback.scss"), "utf8"), "$color: red;\nbody { color: $color; }\n");
  const fallback = await execute("grep", { pattern: "color", path: "fallback.scss" });
  assert.match(fallback, /color/u);
  const imagePath = join(temporary, "pixel.data");
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await execute("hashline_read", { path: "pixel.data" });
  const imageResult = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "hashline_read");
  assert(imageResult?.role === "toolResult" && imageResult.content.some(block => block.type === "image"), "Image detection must use content, not only the file extension");

  phase = "checking collapsed and expanded tool rendering";
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", resolve(installation))).href);
  const { withBuiltInRenderers }: typeof import("@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js") = await import(pathToFileURL(join(resolve(installation), "dist/core/tools/renderers/index.js")).href);
  sdk.initTheme("dark", false);
  const checkRendering = (name: string, args: ToolCall["arguments"], marker: string): void => {
    const outcome = session?.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
    assert(outcome?.role === "toolResult");
    const original = JSON.stringify(outcome);
    const definition = session?.getToolDefinition(name);
    assert(definition);
    const renderers = runner.resolveToolRenderers(name, () => withBuiltInRenderers(name, definition));
    const component = new sdk.ToolExecutionComponent(name, "render-fixture", args, {}, renderers, testTUI(new tui.Container()), temporary);
    component.setArgsComplete();
    component.updateResult({ content: outcome.content, details: outcome.details, isError: outcome.isError });
    for (const width of [120, 60, 24]) {
      component.setExpanded(false);
      const collapsed = component.render(width).map(stripVTControlCharacters);
      assert(!collapsed.join("").replace(/\s/gu, "").includes(marker), `${name}: collapsed output must hide distant content`);
      assert(collapsed.filter(line => line.trim()).length <= 16, `${name}: collapsed output must stay compact at width ${width}`);
      assert(collapsed.every(line => tui.visibleWidth(line) <= width), `${name}: output must fit the terminal`);
      if (name === "hashline_edit") assert(collapsed.join("\n").includes("render.ts"), "Hashline edit headers must identify their target");
      component.setExpanded(true);
      const expanded = component.render(width).map(stripVTControlCharacters).join("\n");
      assert(expanded.replace(/\s/gu, "").includes(marker), `${name}: expansion must reveal the retained result`);
      component.invalidate();
      component.setExpanded(false);
      assert(!component.render(width).map(stripVTControlCharacters).join("").replace(/\s/gu, "").includes(marker), `${name}: output must collapse again`);
    }
    assert.equal(JSON.stringify(outcome), original, "Rendering must not change model-facing results or file metadata");
  };
  const renderSource = Array.from({ length: 40 }, (_, index) => `console.log("${index === 39 ? "FOLD_LAST_ROW" : `row_${index}`} ${"界".repeat(40)}");`).join("\n") + "\n";
  await writeFile(join(temporary, "render.ts"), renderSource);
  const renderRead = await execute("hashline_read", { path: "render.ts" });
  checkRendering("hashline_read", { path: "render.ts" }, "FOLD_LAST_ROW");
  const renderTag = /\[render\.ts#([0-9A-F]{4})\]/u.exec(renderRead)?.[1];
  assert(renderTag);
  const renderEditInput = `[render.ts#${renderTag}]\nPUT 1.=40:\n${renderSource.trimEnd().split("\n").map(line => `+${line.replace("console.log", "console.warn")}`).join("\n")}`;
  await execute("hashline_edit", { input: renderEditInput });
  checkRendering("hashline_edit", { input: renderEditInput }, "FOLD_LAST_ROW");
  const searchArgs = { pat: "console.warn($VALUE)", path: "render.ts" };
  await execute("ast_grep", searchArgs);
  checkRendering("ast_grep", searchArgs, "FOLD_LAST_ROW");
  const previewArgs = { ops: [{ pat: "console.warn($VALUE)", out: "logger.info($VALUE)" }], paths: ["render.ts"] };
  await execute("ast_edit", previewArgs);
  checkRendering("ast_edit", previewArgs, "FOLD_LAST_ROW");
  const resolveArgs = { path: "xd://resolve", content: "Apply the reviewed rendering fixture." };
  await execute("write", resolveArgs);
  checkRendering("write", resolveArgs, "FOLD_LAST_ROW");
  const ordinaryWrite = { path: "ordinary.txt", content: Array.from({ length: 40 }, (_, index) => index === 39 ? "WRITE_LAST_ROW" : `row_${index}`).join("\n") };
  await execute("write", ordinaryWrite);
  checkRendering("write", ordinaryWrite, "WRITE_LAST_ROW");
  await assert.rejects(execute("hashline_read", { path: "missing-render-fixture.txt" }), /not found/iu);
  const failedRead = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "hashline_read");
  assert(failedRead?.role === "toolResult" && failedRead.isError);
  const failedRenderers = runner.resolveToolRenderers("hashline_read", () => withBuiltInRenderers("read", session?.getToolDefinition("hashline_read")));
  const failureComponent = new sdk.ToolExecutionComponent("hashline_read", "read-error", { path: "missing-render-fixture.txt" }, {}, failedRenderers, testTUI(new tui.Container()), temporary);
  failureComponent.updateResult({ content: failedRead.content, details: failedRead.details, isError: true });
  assert.match(failureComponent.render(60).map(stripVTControlCharacters).join("\n"), /not found/iu, "Read failures must remain visible while collapsed");
  console.log("PASS: actual read/edit/AST/resolution results fold, expand, resize, and retain model-facing bytes");

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
  assertGuidance(true);
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: automatic discovery, default-on activation, manifest-derived grammar metadata, built-in discovery tools, hot-toggle guidance, hashline/AST operations, footer statuses and compaction metadata; local provider fixtures only; zero network requests");
} finally {
  clearInterval(heartbeat);
  globalThis.fetch = originalFetch;
  try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); assert.equal(existsSync(temporary), false); console.log("CLEANUP: CodeAnchor workers stopped and owned integration fixtures removed"); }
}
