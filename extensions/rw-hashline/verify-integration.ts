import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod, stat, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AgentSession, ReadToolInput } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testTUI, testUI } from "../../scripts/test-fixtures.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", packageDirectory)).href);
const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", packageDirectory)).href);
const directory = await mkdtemp(join(tmpdir(), "rw-hashline-integration-"));
let session: AgentSession | undefined;
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
let pendingCall: Pick<ToolCall, "id" | "name" | "arguments"> | undefined;
let sequence = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Offline integration must not use the network."); };
  await mkdir(join(directory, "skills/reader-fixture"), { recursive: true });
  await writeFile(join(directory, "skills/reader-fixture/SKILL.md"), "---\nname: reader-fixture\ndescription: Inspect the reader fixture.\n---\n\nSKILL_MARKER\n");
  await writeFile(join(directory, "AGENTS.md"), "# Fixture\nRESOURCE_MARKER\n");
  const settings = sdk.SettingsManager.inMemory({ packages: [], extensions: ["-builtin:mcp"], defaultTools: ["write", "grep", "find", "ls"], images: { autoResize: false }, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: join(directory, "auth.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("rw-hashline-fixture", {
    api: "rw-hashline-fixture", baseUrl: "http://127.0.0.1:1", apiKey: "local-fixture",
    models: [{ id: "fixture", name: "Hashline fixture", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const call = pendingCall;
      pendingCall = undefined;
      const prompt = ai.getCurrentSystemPrompt(context.messages);
      if (session?.getActiveToolNames().includes("hashline_read")) assert(prompt.includes("<available_skills>") && prompt.includes("Use hashline_read to load"));
      const stream = ai.createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [{ type: "toolCall", ...call }] : [{ type: "text", text: "FIXTURE_DONE" }], stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); });
      return stream;
    },
  });
  const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "extension.ts")], disabledBuiltinExtensions: ["mcp"], noContextFiles: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings, modelRuntime: runtime, model: runtime.getModel("rw-hashline-fixture", "fixture"), resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(directory), customTools: [{
    name: "probe-native", label: "Nested guard probe", description: "Exercise the actual nested tool pipeline.",
    parameters: sdk.createReadToolDefinition(directory).parameters,
    async execute(_id, args, _signal, _update, toolContext) {
      // Pi validates this input against the native reader schema.
      const input = args as ReadToolInput;
      const activeSession = session;
      assert(activeSession);
      for (const name of ["read", "edit"]) {
        activeSession.setActiveToolsByName([...activeSession.getActiveToolNames(), name]);
        const result = await toolContext.executeTool(name, name === "read" ? { path: input.path } : { path: input.path, edits: [{ oldText: "after", newText: "BAD" }] });
        assert(result.isError, "Nested native calls must be blocked while rw-hashline is on.");
      }
      const result = await toolContext.executeTool("hashline_read", { path: input.path });
      assert(!result.isError, "Nested hashline reading must remain available.");
      return { content: [{ type: "text", text: "NESTED_OK" }], details: undefined };
    },
  }] }));
  const statuses = new Map<string, string>();
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "tui", uiContext: testUI(session, { setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); }, notify() {} }), onError: error => errors.push(error) });
  assert.equal(statuses.get("rw-hashline"), "rw-hashline: on");
  assert(session.getActiveToolNames().includes("hashline_read") && session.getActiveToolNames().includes("hashline_edit"));
  assert(!session.getActiveToolNames().some(name => ["read", "edit", "ast_grep", "ast_edit"].includes(name)));
  const nativeRead = sdk.createReadToolDefinition(directory, { autoResizeImages: false });
  const nativeEdit = sdk.createEditToolDefinition(directory);
  const hashRead = session.getToolDefinition("hashline_read");
  const hashEdit = session.getToolDefinition("hashline_edit");
  assert(hashRead && hashEdit);
  const ctx = session.extensionRunner.createToolContext("rw-parity", undefined);
  const read = (args: ReadToolInput & { raw?: boolean }) => hashRead.execute("hash-read", args, undefined, undefined, ctx);
  const readHeader = async (path: string) => {
    const result = await read({ path });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const first = text.split("\n")[0];
    assert(first?.startsWith("[") && /#[0-9A-F]{12}\]$/u.test(first));
    return first;
  };
  const invoke = async (name: string, args: ToolCall["arguments"]) => {
    const id = `fixture-${++sequence}`;
    pendingCall = { id, name, arguments: args };
    await session?.prompt("Execute the planned fixture.");
    const outcome = session?.messages.findLast(message => message.role === "toolResult" && message.toolCallId === id);
    assert(outcome?.role === "toolResult");
    return outcome;
  };
  const textPath = join(directory, "text.txt");
  await writeFile(textPath, "\uFEFFone\r\ntwo \t\nthree\nfour\n");
  for (const range of [{}, { offset: 2, limit: 1 }, { offset: 2.5, limit: 1.5 }, { offset: -1, limit: 0 }, { limit: -1 }, { limit: 0 }, { offset: 5 }]) {
    const args = { path: textPath, ...range };
    const actual = await read({ ...args, raw: true });
    const expected = await nativeRead.execute("native-read", args, undefined, undefined, ctx);
    assert.deepEqual(actual.content, expected.content);
    assert.deepEqual(actual.structuredContent, expected.structuredContent);
  }
  await assert.rejects(read({ path: textPath, offset: 99 }));
  const widePath = join(directory, "wide.txt");
  await writeFile(widePath, "x".repeat(60 * 1024) + "-before\n");
  const wide = await read({ path: widePath });
  assert.deepEqual(wide.content, (await nativeRead.execute("wide-native", { path: widePath }, undefined, undefined, ctx)).content);
  const exactFixtures: [string, string, string, string][] = [
    ["ordinary", "prefix before suffix\n", "before", "after"],
    ["mixed", "head\nbefore\r\nkeep\r\ntail\n", "before", "after"],
    ["classic-cr", "head\rbefore\rtail\r", "before", "after"],
    ["bom", "\uFEFFbefore\r\nkeep\n", "before", "after"],
    ["final-newline", "before\n", "before\n", "before"],
    ["unterminated", "before", "before", "after"],
    ["fuzzy", "“before”  \nkeep—unchanged  \n", '"before"', '"after"'],
    ["unicode", "α😀before界\n", "before", "after"],
    ["duplicate-payload", "A\nB\nC\nD\n", "B\nC", "A\nB2\nC2"],
    ["indentation", "function f() {\n  first();\n  second();\n}\n", "  first();\n  second();", "first();\nsecond();"],
    ["wide", "x".repeat(60 * 1024) + "-before\n", "before", "after"],
  ];
  for (const [name, source, oldText, newText] of exactFixtures) {
    const actualPath = join(directory, `${name}-actual.txt`);
    const expectedPath = join(directory, `${name}-expected.txt`);
    await writeFile(actualPath, source); await writeFile(expectedPath, source);
    const edits = [{ oldText, newText }];
    const actual = await hashEdit.execute("exact-edit", { path: actualPath, edits }, undefined, undefined, ctx);
    const expected = await nativeEdit.execute("native-edit", { path: expectedPath, edits }, undefined, undefined, ctx);
    assert((await readFile(actualPath)).equals(await readFile(expectedPath)), name);
    assert(actual.details && expected.details && typeof actual.details === "object" && "diff" in actual.details);
    assert.equal(actual.details.diff, expected.details.diff);
  }
  for (const edits of [[], [{ oldText: "", newText: "new" }], [{ oldText: "missing", newText: "new" }], [{ oldText: "one", newText: "one" }], [{ oldText: "one\r\ntwo", newText: "new" }, { oldText: "two", newText: "other" }]]) {
    await writeFile(textPath, "one\r\ntwo\n");
    await assert.rejects(hashEdit.execute("invalid-exact", { path: textPath, edits }, undefined, undefined, ctx));
    assert.equal(await readFile(textPath, "utf8"), "one\r\ntwo\n");
  }
  const linePath = join(directory, "lines.txt");
  await writeFile(linePath, "head\nbefore\r\nkeep\r\ntail\n");
  const lineHeader = await readHeader(linePath);
  const lineResult = await invoke("hashline_edit", { input: `${lineHeader}\nPUT 2:\n+after` });
  assert(!lineResult.isError);
  assert.equal(await readFile(linePath, "utf8"), "head\nafter\r\nkeep\r\ntail\n");
  await assert.rejects(hashEdit.execute("stale", { input: `${lineHeader}\nPUT 2:\n+other` }, undefined, undefined, ctx));
  const firstPath = join(directory, "first.txt"); const secondPath = join(directory, "second.txt");
  await writeFile(firstPath, "first\n"); await writeFile(secondPath, "second\n");
  const firstHeader = await readHeader(firstPath); const secondHeader = await readHeader(secondPath);
  await writeFile(secondPath, "outside\n");
  await assert.rejects(hashEdit.execute("atomic-validation", { input: `${firstHeader}\nPUT 1:\n+changed\n${secondHeader}\nPUT 1:\n+changed` }, undefined, undefined, ctx));
  assert.equal(await readFile(firstPath, "utf8"), "first\n");
  await hashEdit.execute("atomic-valid", { input: `${firstHeader}\nPUT 1:\n+changed\n${await readHeader(secondPath)}\nPUT 1:\n+changed` }, undefined, undefined, ctx);
  assert.equal(await readFile(secondPath, "utf8"), "changed\n");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(hashEdit.execute("aborted", { path: firstPath, edits: [{ oldText: "changed", newText: "bad" }] }, controller.signal, undefined, ctx));
  await assert.rejects(hashEdit.execute("aborted-lines", { input: `${await readHeader(firstPath)}\nPUT 1:\n+bad` }, controller.signal, undefined, ctx));
  assert.equal(await readFile(firstPath, "utf8"), "changed\n");
  for (const name of ["odd]name.txt", "two\nlines.txt", "literal;name,#tag[1].txt"]) {
    const path = join(directory, name); await writeFile(path, "before\n");
    await hashEdit.execute("literal-path", { input: `${await readHeader(path)}\nPUT 1:\n+after` }, undefined, undefined, ctx);
    assert.equal(await readFile(path, "utf8"), "after\n");
  }
  const unicodePath = join(directory, "Cafe\u0301.txt"); await writeFile(unicodePath, "before\n");
  const fallback = await readHeader(join(directory, "Caf\u00e9.txt"));
  await hashEdit.execute("unicode-fallback", { input: `${fallback}\nPUT 1:\n+after` }, undefined, undefined, ctx);
  assert.equal(await readFile(unicodePath, "utf8"), "after\n");
  const alias = join(directory, "alias.txt"); await symlink(firstPath, alias); await chmod(firstPath, 0o751);
  await hashEdit.execute("alias", { input: `${await readHeader(alias)}\nPUT 1:\n+alias-changed` }, undefined, undefined, ctx);
  assert((await lstat(alias)).isSymbolicLink()); assert.equal((await stat(firstPath)).mode & 0o777, 0o751);

  const bmp = Buffer.alloc(54 + 2400 * 2 * 3);
  bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2400, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  const imagePath = join(directory, "image.bmp"); await writeFile(imagePath, bmp);
  const image = await read({ path: imagePath }); const nativeImage = await nativeRead.execute("image", { path: imagePath }, undefined, undefined, ctx);
  assert.deepEqual(image.content, nativeImage.content); assert.deepEqual(image.structuredContent, nativeImage.structuredContent);
  assert(image.content.some(block => block.type === "image"));
  const notebookPath = join(directory, "notebook.ipynb");
  await writeFile(notebookPath, '{"cells":[],"metadata":{"marker":"before"},"nbformat":4,"nbformat_minor":5}\n');
  assert((await read({ path: notebookPath })).content.some(block => block.type === "text" && block.text.includes('"metadata"')));
  await hashEdit.execute("notebook", { path: notebookPath, edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, ctx);
  assert((await readFile(notebookPath, "utf8")).includes("after"));

  sdk.initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  for (const [path, label] of [[join(directory, "AGENTS.md"), "hashline_read resource"], [join(directory, "skills/reader-fixture/SKILL.md"), "[skill] reader-fixture"], [join(sdk.getDocsPath(), "models.md"), "hashline_read docs"]]) {
    const result = await read({ path });
    const component = new sdk.ToolExecutionComponent("hashline_read", "read-ui", { path }, {}, { renderCall: hashRead.renderCall, renderResult: hashRead.renderResult }, testTUI(new tui.Container()), directory);
    component.setArgsComplete(); component.updateResult({ ...result, isError: false });
    assert(component.render(160).map(stripVTControlCharacters).join("\n").includes(label));
    component.setExpanded(true);
    for (const width of [24, 60, 120]) assert(component.render(width).every(line => tui.visibleWidth(line) <= width));
  }
  await writeFile(linePath, "before\n"); const uiHeader = await readHeader(linePath);
  const editComponent = new sdk.ToolExecutionComponent("hashline_edit", "edit-ui", { input: `${uiHeader}\nPUT 1:\n+after` }, {}, { renderCall: hashEdit.renderCall, renderResult: hashEdit.renderResult, renderShell: hashEdit.renderShell }, testTUI(new tui.Container()), directory);
  editComponent.setArgsComplete(); editComponent.render(120);
  await new Promise<void>(accept => setTimeout(accept, 50));
  assert(editComponent.render(120).map(stripVTControlCharacters).join("\n").includes("after"), "Line editing must retain the native pre-execution diff preview.");
  assert.equal(await readFile(linePath, "utf8"), "before\n");
  const edited = await hashEdit.execute("ui-edit", { input: `${uiHeader}\nPUT 1:\n+after` }, undefined, undefined, ctx);
  editComponent.updateResult({ ...edited, isError: false });
  for (const width of [24, 60, 120]) assert(editComponent.render(width).every(line => tui.visibleWidth(line) <= width));

  session.setActiveToolsByName([...session.getActiveToolNames(), "read", "edit"]);
  assert((await invoke("read", { path: linePath })).isError, "Stale native read calls must be blocked.");
  session.setActiveToolsByName([...session.getActiveToolNames(), "edit"]);
  assert((await invoke("edit", { path: linePath, edits: [{ oldText: "after", newText: "BAD" }] })).isError);
  assert((await invoke("hashline_edit", { input: "invalid", extra: true })).isError);
  assert(!(await invoke("probe-native", { path: linePath })).isError);
  assert(session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "rw-hashline-nested-files"));
  const nativeWrite = sdk.createWriteToolDefinition(directory);
  const write = session.getToolDefinition("write");
  assert(write);
  assert.deepEqual(write.parameters, nativeWrite.parameters);
  for (const content of ["", "α😀\r\ntext\n"]) {
    const path = join(directory, "new/deep/written.txt");
    const written = await write.execute("native-write", { path, content }, undefined, undefined, ctx);
    assert.equal(await readFile(path, "utf8"), content);
    assert.deepEqual(written.content, (await nativeWrite.execute("write-comparison", { path, content }, undefined, undefined, ctx)).content);
  }
  await session.prompt("/rw-hashline off");
  assert.equal(statuses.get("rw-hashline"), "rw-hashline: off");
  assert(session.getActiveToolNames().includes("read") && session.getActiveToolNames().includes("edit"));
  assert(!session.getActiveToolNames().includes("hashline_read"));
  assert(!(await invoke("edit", { path: linePath, edits: [{ oldText: "after", newText: "native" }] })).isError);
  await session.reload();
  assert(!session.getActiveToolNames().includes("hashline_edit"));
  assert(session.getActiveToolNames().includes("edit"));
  await session.prompt("/rw-hashline on");
  assert(session.getActiveToolNames().includes("hashline_edit") && !session.getActiveToolNames().includes("edit"));
  assert(!(await invoke("hashline_read", { path: linePath })).isError);
  assert.deepEqual(errors, []); assert.equal(networkAttempts, 0);
  console.log("PASS: native read/exact-edit parity; literal byte-preserving line edits; schema checks; snapshots; atomic preflight; cancellation; paths; symlinks; images; notebook JSON; skill catalog; native resource/docs UI and diff previews; on/off/reload; native blocking; zero network requests");
} finally {
  globalThis.fetch = originalFetch;
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(directory));
  console.log("CLEANUP: integration session and task-owned fixtures removed");
}
