import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QUIT_COMMAND } from "./controller.ts";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSession, SessionBeforeCompactResult, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { testUI } from "../../scripts/test-fixtures.ts";
import { readPackageInfo } from "../../scripts/verification-data.ts";

const packageDirectory = process.argv[2];
assert.ok(packageDirectory, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const packagePath = resolve(packageDirectory);
const packageInfo = readPackageInfo(join(packagePath, "package.json"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-auto-compact-check-"));
const agentDirectory = join(temporaryDirectory, "agent");
mkdirSync(agentDirectory);

let phase = "loading installed Pi";
let session: AgentSession | undefined;
let releaseSummary: ((cancel?: boolean) => void) | undefined;
let previousKeybindings: ReturnType<import("@earendil-works/pi-tui").KeybindingsManager["getUserBindings"]> | undefined;
let keybindings: import("@earendil-works/pi-tui").KeybindingsManager | undefined;
let succeeded = false;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Auto-compact check: ${phase}\n`);
}, 20_000);

function log(message: string) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function waitFor(predicate: () => unknown, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

try {
  log(`Checking auto-compact with installed Pi ${packageInfo.version}`);
  log(`Temporary integration directory: ${temporaryDirectory}`);
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packagePath, "dist", "index.js")).href);
  const require = createRequire(pathToFileURL(join(packagePath, "package.json")));
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
  const settings = SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [] });
  const inputListeners = new Set<TerminalInputHandler>();
  const extensionErrors: unknown[] = [];
  const notifications: { text: string; kind: string | undefined }[] = [];
  const compactionOutcomes: { aborted: boolean; errorMessage: string | undefined }[] = [];
  let editorText = "";
  let shutdowns = 0;
  let compactionHooks = 0;
  let modelRequests = 0;
  const fixtureModel: Model<"openai-responses"> = {
    id: "auto-compact-fixture",
    name: "Auto-compact fixture",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDirectory, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const method of ["stream", "complete", "streamSimple", "completeSimple"] as const) {
    modelRuntime[method] = () => {
      modelRequests += 1;
      throw new Error("The integration fixture must not make model requests");
    };
  }

  phase = "loading the real extension";
  const loader = new DefaultResourceLoader({
    cwd: temporaryDirectory,
    agentDir: agentDirectory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
    extensionFactories: [
      (pi) => {
        pi.on("session_before_compact", async (event) => {
          compactionHooks += 1;
          assert.equal(event.customInstructions, "Write the compaction summary in English.");
          return await new Promise<SessionBeforeCompactResult>((resolveSummary) => {
            let settled = false;
            const finishSummary = (cancel = false) => {
              if (settled) {
                return;
              }
              settled = true;
              event.signal.removeEventListener("abort", cancelSummary);
              resolveSummary(cancel ? { cancel: true } : {
                compaction: {
                  summary: "Native fixture compaction completed in English.",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              });
            };
            releaseSummary = finishSummary;
            const cancelSummary = () => finishSummary(true);
            event.signal.addEventListener("abort", cancelSummary, { once: true });
          });
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);

  const manager = SessionManager.create(temporaryDirectory, join(temporaryDirectory, "sessions"));
  const assistant = (text: string): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: fixtureModel.api,
    provider: fixtureModel.provider,
    model: fixtureModel.id,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  for (let turn = 0; turn < 20; turn += 1) {
    manager.appendMessage({
      role: "user",
      content: `Historical fixture turn ${turn}.\n${"Historical fixture line.\n".repeat(400)}`,
      timestamp: Date.now(),
    });
    manager.appendMessage(assistant(`Historical response ${turn}.`));
  }
  manager.appendMessage({ role: "user", content: "The fixture is ready to compact.", timestamp: Date.now() });
  manager.appendMessage(assistant("Ready."));

  ({ session } = await createAgentSession({
    cwd: temporaryDirectory,
    agentDir: agentDirectory,
    modelRuntime,
    model: fixtureModel,
    thinkingLevel: "off",
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    tools: [],
  }));
  session.subscribe((event) => {
    if (event.type === "compaction_end") {
      compactionOutcomes.push({ aborted: event.aborted, errorMessage: event.errorMessage });
    }
  });
  await session.bindExtensions({
    mode: "tui",
    uiContext: testUI(session, {
      notify: (text, kind) => notifications.push({ text, kind }),
      onTerminalInput(handler) {
        inputListeners.add(handler);
        return () => inputListeners.delete(handler);
      },
      getEditorText: () => editorText,
      setEditorText: (value) => { editorText = value; },
    }),
    shutdownHandler: () => { shutdowns += 1; },
    onError: (error) => extensionErrors.push(error),
  });
  assert.equal(inputListeners.size, 1);

  phase = "checking actual keybinding-aware quit routing";
  keybindings = tui.getKeybindings();
  previousKeybindings = keybindings.getUserBindings();
  editorText = "/quit";
  for (const handler of inputListeners) {
    assert.equal(handler("\r"), undefined);
  }
  assert.equal(editorText, `/${QUIT_COMMAND}`);

  keybindings.setUserBindings({ "tui.input.submit": "ctrl+s" });
  editorText = "/quit";
  for (const handler of inputListeners) {
    handler("\r");
  }
  assert.equal(editorText, "/quit");
  for (const handler of inputListeners) {
    handler("\x13");
  }
  assert.equal(editorText, `/${QUIT_COMMAND}`);
  keybindings.setUserBindings(previousKeybindings);

  phase = "waiting for native compaction before shutdown";
  await session.prompt(editorText);
  await waitFor(() => releaseSummary || shutdowns > 0 || extensionErrors.length > 0
    || notifications.some(({ kind }) => kind === "warning")
    || compactionOutcomes.some(({ errorMessage }) => errorMessage), "a native compaction outcome");
  assert.equal(compactionHooks, 1, JSON.stringify({
    model: session.model?.id,
    idle: session.isIdle,
    modelRequests,
    shutdowns,
    notifications,
    compactionOutcomes,
    entries: manager.getBranch().map((entry) => ({
      type: entry.type,
      role: entry.type === "message" ? entry.message.role : undefined,
      textLength: entry.type === "message" && "content" in entry.message && typeof entry.message.content === "string" ? entry.message.content.length : undefined,
    })),
  }, null, 2));
  assert.deepEqual(extensionErrors, []);
  assert.ok(releaseSummary);
  assert.equal(shutdowns, 0, "Quit must wait for compaction to finish");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  releaseSummary();
  await waitFor(() => shutdowns === 1, "shutdown after native compaction");

  phase = "checking persistence and cleanup";
  const savedSession = manager.getSessionFile();
  assert.ok(savedSession);
  const restored = SessionManager.open(savedSession);
  const compactions = restored.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].summary, "Native fixture compaction completed in English.");
  assert.equal(modelRequests, 0);
  assert.deepEqual(extensionErrors, []);
  const runner = session.extensionRunner;
  assert.ok(runner);
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(inputListeners.size, 0, "Reload must remove the raw input listener");
  succeeded = true;
  log("PASS: real extension loading, default/custom submit keys, native compaction persistence, quit ordering, and cleanup; zero model requests");
} finally {
  clearInterval(heartbeat);
  if (keybindings && previousKeybindings) {
    keybindings.setUserBindings(previousKeybindings);
  }
  try {
    const activeSession = session;
    if (activeSession) {
      releaseSummary?.(true);
      try {
        await activeSession.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        await waitFor(() => activeSession.isIdle, "session cleanup");
      } finally {
        activeSession.dispose();
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    log(`Temporary integration directory removed; ${succeeded ? "SUCCESS" : "FAILED"}`);
  }
}
