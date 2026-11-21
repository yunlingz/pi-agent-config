import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AgentSession, ReadToolInput } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { testTUI } from "../../scripts/test-fixtures.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-read-parity.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-ai", packageDirectory)).href);
const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", packageDirectory)).href);
const directory = await mkdtemp(join(tmpdir(), "code-anchor-read-parity-"));
const originalFetch = globalThis.fetch;
let session: AgentSession | undefined;
let expectedSkill = true;
let networkAttempts = 0;
try {
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Read parity tests must not use the network."); };
  await mkdir(join(directory, "extensions"));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(directory, "extensions/code-anchor"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(directory, "skills/read-fixture"), { recursive: true });
  const skillPath = join(directory, "skills/read-fixture/SKILL.md");
  await writeFile(skillPath, "---\nname: read-fixture\ndescription: Inspect a synthetic parity fixture.\n---\n\nSKILL_MARKER\n");
  await writeFile(join(directory, "AGENTS.md"), "# Fixture instructions\nRESOURCE_MARKER\n");
  const settings = sdk.SettingsManager.inMemory({ packages: [], extensions: ["-builtin:mcp"], defaultTools: ["write", "grep", "find", "ls"],
    images: { autoResize: false }, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: join(directory, "auth.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("read-parity", {
    api: "read-parity", baseUrl: "http://127.0.0.1:1", apiKey: "local-fixture",
    models: [{ id: "fixture", name: "Read fixture", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const prompt = ai.getCurrentSystemPrompt(context.messages);
      assert.equal(prompt.includes("<available_skills>"), expectedSkill, "Skill catalog must follow the available reader");
      if (expectedSkill) assert(prompt.includes("Use hashline_read to load a skill's file"));
      assert(prompt.includes("Pi documentation"), "Keep the native internal-documentation section");
      const stream = ai.createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [{ type: "text", text: "PARITY_OK" }], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    },
  });
  const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    disabledBuiltinExtensions: ["mcp"], noContextFiles: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, settingsManager: settings,
    resourceLoader: loader, model: runtime.getModel("read-parity", "fixture"), sessionManager: sdk.SessionManager.inMemory(directory) }));
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  const native = session.getToolDefinition("read");
  const anchored = session.getToolDefinition("hashline_read");
  assert(native && anchored);
  const context = session.extensionRunner.createToolContext("read-parity", undefined);
  const read = (args: ReadToolInput) => anchored.execute("hashline-parity", args, undefined, undefined, context);
  const nativeRead = (args: ReadToolInput) => native.execute("native-parity", args, undefined, undefined, context);
  const text = (result: Awaited<ReturnType<typeof read>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  sdk.initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  for (const [path, marker, expectedHeader] of [
    [join(directory, "AGENTS.md"), "RESOURCE_MARKER", "hashline_read resource"],
    [skillPath, "SKILL_MARKER", "[skill] read-fixture"],
    [join(sdk.getDocsPath(), "models.md"), "# Choose a Model", "hashline_read docs"],
  ]) {
    const result = await read({ path, offset: 1, limit: 20 });
    assert(text(result).includes(marker));
    const component = new sdk.ToolExecutionComponent("hashline_read", "header-parity", { path }, {},
      { renderCall: anchored.renderCall, renderResult: anchored.renderResult }, testTUI(new tui.Container()), directory);
    component.setArgsComplete();
    component.updateResult({ ...result, isError: false });
    const header = component.render(180).map(stripVTControlCharacters).join("\n");
    assert(header.includes(expectedHeader), `Missing native read classification: ${expectedHeader}`);
    assert.equal(result.structuredContent, text(result), "Text callers must receive the same structured output");
  }
  assert(anchored.outputSchema && anchored.constrainedSampling);
  console.log("PASS: resource, skill, and internal-doc contents, compact native headers, and structured text output");

  const actual = join(directory, "Cafe\u0301;exact.txt");
  await writeFile(actual, "one\ntwo\nthree\n");
  const result = await read({ path: join(directory, "Caf\u00e9;exact.txt") + ":2-2" });
  assert(text(result).includes("2:two"));
  assert(text(result).startsWith(`[${actual}#`), "Resolved filename must supply an edit-safe header");
  const tag = /#([0-9A-F]{4})\]/u.exec(text(result))?.[1];
  assert(tag);
  const edit = session.getToolDefinition("hashline_edit");
  assert(edit);
  await edit.execute("path-edit", { input: `[${actual}#${tag}]\nPUT 2:\n+changed` }, undefined, undefined, context);
  assert.equal(await readFile(actual, "utf8"), "one\nchanged\nthree\n");
  console.log("PASS: native Unicode fallback with selectors produces an editable, exact file header");

  const oversized = join(directory, "oversized.txt");
  await writeFile(oversized, "x".repeat(60 * 1024) + "\nAFTER_LIMIT\n");
  await assert.rejects(read({ path: `${oversized}:raw` }), /exceeds|fit.*limit/u);
  const many = join(directory, "many.txt");
  await writeFile(many, Array.from({ length: 2100 }, (_, index) => `line-${index + 1}`).join("\n") + "\n");
  const truncated = await read({ path: `${many}:raw` });
  assert(text(truncated).includes("line-2000") && !text(truncated).includes("line-2001"));
  assert.match(text(truncated), /truncated.*2001/iu);
  const exact = await read({ path: `${many}:2001-:raw` });
  assert(text(exact).startsWith("line-2001\n") && text(exact).endsWith("line-2100\n"));
  console.log("PASS: oversized raw lines fail explicitly; truncated raw reads have a usable continuation; complete raw bytes stay exact");

  // A small uncompressed BMP supplies a wide image without another fixture dependency.
  const width = 2400;
  const height = 2;
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const image = Buffer.alloc(54 + rowBytes * height, 0);
  image.write("BM"); image.writeUInt32LE(image.length, 2); image.writeUInt32LE(54, 10); image.writeUInt32LE(40, 14);
  image.writeInt32LE(width, 18); image.writeInt32LE(height, 22); image.writeUInt16LE(1, 26); image.writeUInt16LE(24, 28);
  const imagePath = join(directory, "wide.bmp");
  await writeFile(imagePath, image);
  const a = await nativeRead({ path: imagePath });
  const b = await read({ path: imagePath });
  assert.deepEqual(b.content, a.content, "Honor native image settings and conversion");
  assert.deepEqual(b.structuredContent, a.structuredContent);
  assert(b.content.some(block => block.type === "image"));
  console.log("PASS: image conversion, attachments, structured output, and images.autoResize=false match native read");

  await session.prompt("Check the available skill catalog without loading files.");
  await session.reload();
  await session.prompt("Check the catalog after reload.");
  await session.prompt("/code-anchor off"); expectedSkill = false;
  await session.prompt("Check reader exclusion.");
  await session.prompt("/code-anchor on"); expectedSkill = true;
  await session.prompt("Check the restored catalog.");
  session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "hashline_read")); expectedSkill = false;
  await session.prompt("Check a disabled file reader.");
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  console.log("PASS: generated provider prompt keeps the skill catalog across reload/on/off and respects disabled readers");
} finally {
  globalThis.fetch = originalFetch;
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(directory));
  console.log("CLEANUP: reader parity sessions and temporary files removed");
}
