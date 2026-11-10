import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { testTUI, testUI, type TestWidget, type WidgetContent } from "../../scripts/test-fixtures.ts";
import { readPackageInfo } from "../../scripts/verification-data.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageArgument = process.argv[2];
assert.ok(packageArgument, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const packageDirectory = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-session-history-check-"));
const packageInfo = readPackageInfo(join(packageDirectory, "package.json"));
let session: AgentSession | undefined;
let phase = "loading installed Pi";
let passed = false;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Session-history integration: ${phase}\n`);
}, 20_000);

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(text: string, index: number): AssistantMessage {
  const content: AssistantMessage["content"] = [{ type: "text", text }];
  if (index % 25 === 0) {
    content.push({
      type: "toolCall",
      id: `tool-${index}`,
      name: "read",
      arguments: { path: `fixture-${index}.txt` },
    });
  }
  return {
    role: "assistant",
    content,
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: usage(),
    stopReason: index % 25 === 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function plainText(lines: string[], stripTerminalSequences: (text: string) => string) {
  return stripTerminalSequences(lines.join("\n"));
}

try {
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const tuiApi: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(join(
    packageDirectory,
    "node_modules/@earendil-works/pi-tui/dist/index.js",
  )).href);
  const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") = await import(pathToFileURL(join(
    packageDirectory,
    "dist/modes/interactive/theme/theme.js",
  )).href);
  themeApi.initTheme("dark", false);

  const settings = sdk.SettingsManager.inMemory({
    extensions: ["-builtin:mcp"],
    packages: [],
    compaction: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(temporaryDirectory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(temporaryDirectory, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("fixture", {
    api: "fixture",
    apiKey: "local-fixture-only",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "fixture",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 64_000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple() {
      throw new Error("The session-history fixture must not call a model");
    },
  });

  const manager = sdk.SessionManager.inMemory(temporaryDirectory);
  const oldEntryIds = [];
  for (let index = 0; index < 260; index++) {
    oldEntryIds.push(manager.appendMessage({
      role: "user",
      content: `Old user message ${index}`,
      timestamp: Date.now(),
    }));
    const response = assistant(`Old assistant message ${index}`, index);
    manager.appendMessage(response);
    if (index % 25 === 0) {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `tool-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `Fixture result ${index}` }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  const firstKeptEntryId = oldEntryIds.at(-5);
  assert.ok(firstKeptEntryId);
  manager.appendCompaction("Synthetic compacted context", firstKeptEntryId, 120_000);
  manager.appendMessage({
    role: "user",
    content: "Current visible message",
    timestamp: Date.now(),
  });

  const loader = new sdk.DefaultResourceLoader({
    cwd: temporaryDirectory,
    agentDir: temporaryDirectory,
    settingsManager: settings,
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(extensionDirectory, "index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);

  ({ session } = await sdk.createAgentSession({
    cwd: temporaryDirectory,
    agentDir: temporaryDirectory,
    settingsManager: settings,
    modelRuntime,
    model: modelRuntime.getModel("fixture", "fixture"),
    thinkingLevel: "off",
    sessionManager: manager,
    resourceLoader: loader,
    tools: [],
  }));

  const header = new tuiApi.Container();
  header.addChild(new tuiApi.Text("Header"));
  const resources = new tuiApi.Container();
  resources.addChild(new tuiApi.Text("Resources"));
  const chat = new tuiApi.Container();
  chat.addChild(new tuiApi.Text("Current compacted view"));
  const document = new tuiApi.Container();
  document.addChild(header);
  document.addChild(resources);
  document.addChild(chat);

  const inputListeners = new Set<TerminalInputHandler>();
  const widgets = new Map<string, TestWidget>();
  const notifications: { message: string; type: string | undefined }[] = [];
  let renderedLines: string[] = [];
  const fakeTui = testTUI(document, (lines) => { renderedLines = lines; });
  const uiContext = testUI(session, {
    setWidget(key: string, content: WidgetContent) {
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (typeof content === "function") {
        widgets.set(key, content(fakeTui, themeApi.theme));
      }
    },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
    getToolsExpanded: () => false,
    notify(message, type) {
      notifications.push({ message, type });
    },
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext,
    onError: (error) => errors.push(error),
  });
  fakeTui.renderNow();

  phase = "checking bounded initial history and unchanged model context";
  assert.equal(document.children.length, 4);
  assert.equal(document.children.at(-1), chat);
  assert.equal(widgets.size, 1);
  assert.equal(inputListeners.size, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(notifications, []);
  let text = plainText(renderedLines, tuiApi.stripTerminalSequences);
  assert.match(text, /Old user message 254/);
  assert.doesNotMatch(text, /Old user message 220/);
  assert.doesNotMatch(text, /Old user message 0/);
  const modelText = JSON.stringify(manager.buildSessionContext().messages);
  assert.doesNotMatch(modelText, /Old user message 0/);
  assert.match(modelText, /Synthetic compacted context/);

  phase = "checking automatic older-history loading";
  fakeTui.isFollowingOutput = false;
  fakeTui.viewportTop = 1;
  for (const listener of inputListeners) {
    assert.equal(listener("\u001b[5~"), undefined);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  fakeTui.renderNow();
  text = plainText(renderedLines, tuiApi.stripTerminalSequences);
  assert.match(text, /Old user message 220/);
  assert.doesNotMatch(text, /Old user message 0/);
  assert.ok(fakeTui.viewportTop > 1, "Prepending history must preserve the visible anchor");

  phase = "checking reload state restoration and cleanup";
  fakeTui.viewportTop = 77;
  fakeTui.isFollowingOutput = false;
  const runner = session.extensionRunner;
  assert.ok(runner);
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(document.children.length, 3);
  assert.equal(widgets.size, 0);
  assert.equal(inputListeners.size, 0);
  await runner.emit({ type: "session_start", reason: "reload" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  fakeTui.renderNow();
  assert.equal(document.children.length, 4);
  assert.equal(fakeTui.viewportTop, 77);
  text = plainText(renderedLines, tuiApi.stripTerminalSequences);
  assert.match(text, /Old user message 220/);

  phase = "checking complete history through the existing top shortcut";
  for (const listener of inputListeners) {
    assert.equal(listener("\u001b[1;5H"), undefined);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  fakeTui.renderNow();
  text = plainText(renderedLines, tuiApi.stripTerminalSequences);
  assert.match(text, /Old user message 0/);
  assert.equal(fakeTui.viewportTop, 0);

  phase = "checking expansion state and input coexistence";
  for (const listener of inputListeners) {
    assert.equal(listener("x"), undefined);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.deepEqual(errors, []);
  assert.equal(JSON.stringify(manager.buildSessionContext().messages), modelText);

  passed = true;
  console.log(
    `PASS: Pi ${packageInfo.version}; bounded history, automatic loading, reload restoration, cleanup, and unchanged model context`,
  );
} finally {
  clearInterval(heartbeat);
  try {
    if (session) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: session-history integration; temporary fixtures removed\n`);
  }
}
