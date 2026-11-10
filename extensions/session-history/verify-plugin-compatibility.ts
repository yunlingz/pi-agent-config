import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionUIContext, SettingsManager, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { testTUI, testUI, type TestWidget, type WidgetContent } from "../../scripts/test-fixtures.ts";
import { readJson, readPackageInfo } from "../../scripts/verification-data.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageArgument = process.argv[2];
assert.ok(packageArgument, "Usage: node verify-plugin-compatibility.ts <installed-pi-package-directory>");
const packageDirectory = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = resolve(extensionDirectory, "../..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-session-history-plugins-"));
const packageInfo = readPackageInfo(join(packageDirectory, "package.json"));
let session: AgentSession | undefined;
let passed = false;
let phase = "loading configured extensions";
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Session-history plugin compatibility: ${phase}\n`);
}, 20_000);

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

try {
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(join(
    packageDirectory,
    "node_modules/@earendil-works/pi-tui/dist/index.js",
  )).href);
  const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") = await import(pathToFileURL(join(
    packageDirectory,
    "dist/modes/interactive/theme/theme.js",
  )).href);
  themeApi.initTheme("dark", false);

  const globalSettings = readJson<ReturnType<SettingsManager["getGlobalSettings"]>>(join(agentDirectory, "settings.json"));
  const settings = sdk.SettingsManager.inMemory({
    ...globalSettings,
    extensions: [...(globalSettings.extensions ?? []), "-builtin:mcp"],
    cacheWarming: "off",
    compaction: { ...globalSettings.compaction, enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: temporaryDirectory,
    agentDir: agentDirectory,
    settingsManager: settings,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extensionNames = loader.getExtensions().extensions.map((extension) => extension.path);
  assert.ok(extensionNames.some((path) => path.includes("session-history")));
  assert.ok(extensionNames.some((path) => path.includes("auto-compact")));
  assert.ok(extensionNames.some((path) => path.includes("pi-vcc")));
  assert.ok(extensionNames.some((path) => path.includes("rpiv-todo")));
  assert.ok(extensionNames.some((path) => path.includes("rpiv-ask-user-question")));
  assert.ok(extensionNames.some((path) => path.includes("plannotator")));
  assert.ok(extensionNames.some((path) => path.includes("pi-powerline-footer")));
  assert.ok(extensionNames.some((path) => path.includes("cache-rate")));

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
      throw new Error("The plugin compatibility fixture must not call a model");
    },
  });

  const manager = sdk.SessionManager.inMemory(temporaryDirectory);
  const userIds = [];
  for (let index = 0; index < 40; index++) {
    userIds.push(manager.appendMessage({
      role: "user",
      content: `Compatibility history ${index}`,
      timestamp: Date.now(),
    }));
    manager.appendMessage(assistant(`Compatibility response ${index}`));
  }
  const firstKeptEntryId = userIds.at(-3);
  assert.ok(firstKeptEntryId);
  manager.appendCompaction("Compatibility summary", firstKeptEntryId, 40_000);
  manager.appendMessage({
    role: "user",
    content: "Current compatibility message",
    timestamp: Date.now(),
  });

  ({ session } = await sdk.createAgentSession({
    cwd: temporaryDirectory,
    agentDir: agentDirectory,
    settingsManager: settings,
    modelRuntime,
    model: modelRuntime.getModel("fixture", "fixture"),
    thinkingLevel: "off",
    sessionManager: manager,
    resourceLoader: loader,
    tools: [],
  }));

  const header = new tui.Container();
  const resources = new tui.Container();
  const chat = new tui.Container();
  chat.addChild(new tui.Text("Current compacted view"));
  const document = new tui.Container();
  document.addChild(header);
  document.addChild(resources);
  document.addChild(chat);
  let renderedLines: string[] = [];
  const fakeTui = testTUI(document, (lines) => { renderedLines = lines; });

  const inputListeners = new Set<TerminalInputHandler>();
  const widgets = new Map<string, TestWidget>();
  const statuses = new Map<string, string>();
  const notifications: { message: string; type: string | undefined }[] = [];
  const errors: unknown[] = [];
  let editorText = "";
  let footerFactory: Parameters<ExtensionUIContext["setFooter"]>[0];
  let headerFactory: Parameters<ExtensionUIContext["setHeader"]>[0];
  let editorFactory: Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  const uiContext = testUI(session, {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify(message, type) { notifications.push({ message, type }); },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
    setStatus(key, value) {
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key: string, content: WidgetContent) {
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (content === undefined) return;
      if (typeof content === "function") {
        widgets.set(key, content(fakeTui, themeApi.theme));
      } else {
        widgets.set(key, { render: () => content, invalidate() {} });
      }
    },
    setFooter(factory) { footerFactory = factory; },
    setHeader(factory) { headerFactory = factory; },
    setTitle() {},
    custom: async () => { throw new Error("Custom UI is outside this fixture."); },
    pasteToEditor() {},
    setEditorText(value) { editorText = value; },
    getEditorText() { return editorText; },
    editor: async () => undefined,
    addAutocompleteProvider() {},
    setEditorComponent(factory) { editorFactory = factory; },
    getEditorComponent() { return editorFactory; },
    theme: themeApi.theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded() {},
  });

  phase = "binding all extensions in TUI mode";
  await session.bindExtensions({
    mode: "tui",
    uiContext,
    shutdownHandler() {},
    onError: (error) => errors.push(error),
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  fakeTui.renderNow();

  assert.deepEqual(errors, []);
  assert.equal(document.children.length, 4);
  assert.equal(document.children.at(-1), chat);
  assert.ok(widgets.has("session-history-mount"));
  assert.ok([...widgets.keys()].some((key) => key.startsWith("powerline-")));
  const runner = session.extensionRunner;
  assert.ok(runner);
  const commandNames = runner
    .getRegisteredCommands()
    .map((command) => command.name);
  assert.ok(commandNames.includes("todos"));
  assert.ok(commandNames.includes("pi-vcc"));
  assert.ok(commandNames.includes("plannotator-review"));
  assert.equal(typeof footerFactory, "function");
  assert.equal(typeof editorFactory, "function");
  assert.ok(inputListeners.size >= 3);
  const inputListenerCountBeforeShutdown = inputListeners.size;
  const text = tui.stripTerminalSequences(renderedLines.join("\n"));
  assert.match(text, /Compatibility history/);

  phase = "checking non-consuming input and auto-compact quit routing";
  for (const listener of inputListeners) {
    const result = listener("x");
    assert.ok(result === undefined || result.consume !== true);
  }
  editorText = "/quit";
  for (const listener of inputListeners) {
    listener("\r");
  }
  assert.equal(editorText, "/compact-quit");
  assert.equal(headerFactory, undefined, "Powerline welcome is disabled and history must not replace the header");

  phase = "checking full cleanup";
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  assert.ok(inputListeners.size < inputListenerCountBeforeShutdown);
  assert.equal(widgets.has("session-history-mount"), false);
  assert.equal(document.children.length, 3);
  for (const widget of widgets.values()) widget.dispose?.();
  widgets.clear();
  inputListeners.clear();
  assert.deepEqual(errors, []);

  passed = true;
  console.log(
    `PASS: Pi ${packageInfo.version}; all configured extensions loaded, shared TUI lifecycle passed, and no UI surface was replaced by session-history`,
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
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: plugin compatibility; temporary fixtures removed\n`);
  }
}
