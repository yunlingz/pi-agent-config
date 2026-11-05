import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IDLE_MS, QUIT_COMMAND } from "./controller.mjs";

const piPackage = resolve(process.argv[2] ?? "");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const vccDirectory = resolve(process.argv[3] ?? join(agentDirectory, "npm", "node_modules", "@sting8k", "pi-vcc"));
const historyDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../session-history");
const piInfo = JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8"));
const vccInfo = JSON.parse(readFileSync(join(vccDirectory, "package.json"), "utf8"));
assert.equal(piInfo.name, "@earendil-works/pi-coding-agent");
assert.equal(vccInfo.name, "@sting8k/pi-vcc");
const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-vcc-"));
const realSetTimeout = globalThis.setTimeout;
const RealDate = globalThis.Date;
const previousConfigPath = process.env.PI_VCC_CONFIG_PATH;
const previousOffline = process.env.PI_OFFLINE;
const previousTelemetry = process.env.PI_TELEMETRY;
let phase = "loading installed Pi";
let session;
let timersMocked = false;
let succeeded = false;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new RealDate().toISOString()}] pi-vcc integration: ${phase}\n`);
}, 20_000);

function log(text) {
  process.stderr.write(`[${new RealDate().toISOString()}] ${text}\n`);
}

async function pause(duration) {
  await new Promise((resolveWait) => realSetTimeout(resolveWait, duration));
}

async function waitFor(predicate, label) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (timersMocked) mock.timers.tick(0);
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await pause(10);
  }
}

const fixtureModel = {
  id: "vcc-compaction-fixture",
  name: "VCC compaction fixture",
  provider: "fixture",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:1",
  reasoning: true,
  thinkingLevelMap: {
    off: "none", minimal: "minimal", low: "low", medium: "medium",
    high: "high", xhigh: "xhigh", max: "xhigh",
  },
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 32_768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function appendHistory(manager) {
  for (let turn = 0; turn < 20; turn += 1) {
    manager.appendMessage({
      role: "user",
      content: `Historical fixture turn ${turn}.\n${"Completed fixture evidence.\n".repeat(400)}`,
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Historical response ${turn}.` }],
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
  }
}

try {
  log(`Checking installed Pi ${piInfo.version} and pi-vcc ${vccInfo.version}; temporary workspace: ${root}`);
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  const sdk = await import(pathToFileURL(join(piPackage, "dist", "index.js")).href);
  const tui = await import(pathToFileURL(join(piPackage, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")).href);
  const themeApi = await import(pathToFileURL(join(piPackage, "dist", "modes", "interactive", "theme", "theme.js")).href);
  themeApi.initTheme("dark", false);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
  for (const trigger of ["manual", "quit", "idle"]) {
    phase = `${trigger}: loading actual extensions`;
    const workspace = join(root, trigger);
    const agent = join(workspace, "agent");
    mkdirSync(agent, { recursive: true });
    process.env.PI_VCC_CONFIG_PATH = join(agent, "pi-vcc-config.json");
    const errors = [];
    const notifications = [];
    const notificationsAtShutdown = [];
    const instructions = [];
    const prompts = [];
    const inputListeners = new Set();
    const widgets = new Map();
    let shutdowns = 0;
    let modelRequests = 0;
    const settings = SettingsManager.inMemory({
      extensions: ["-builtin:mcp"],
      packages: [],
      cacheWarming: "off",
      transport: "sse",
      retry: { enabled: false, provider: { maxRetries: 0 } },
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agent, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    for (const method of ["stream", "complete", "streamSimple", "completeSimple"]) {
      modelRuntime[method] = () => {
        modelRequests += 1;
        throw new Error("This fixture must not make model requests");
      };
    }
    if (trigger === "idle") {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      timersMocked = true;
    }
    const paths = [
      join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
      join(vccDirectory, "index.ts"),
      join(historyDirectory, "index.ts"),
    ];
    if (trigger === "quit") paths.reverse();
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: agent,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"],
      additionalExtensionPaths: paths,
      extensionFactories: [(pi) => {
        pi.on("session_before_compact", (event) => { instructions.push(event.customInstructions); });
        pi.on("before_agent_start", (event) => { prompts.push(event.prompt); });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 4);
    const config = JSON.parse(readFileSync(process.env.PI_VCC_CONFIG_PATH, "utf8"));
    assert.equal(config.overrideDefaultCompaction, true, "The published default must enable the override");
    const manager = SessionManager.create(workspace, join(workspace, "sessions"));
    appendHistory(manager);
    ({ session } = await createAgentSession({
      cwd: workspace,
      agentDir: agent,
      modelRuntime,
      model: fixtureModel,
      thinkingLevel: "max",
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: manager,
      tools: [],
    }));
    const originalSettings = JSON.stringify(settings.getCompactionSettings(fixtureModel));
    const header = new tui.Container();
    const resources = new tui.Container();
    const chat = new tui.Container();
    chat.addChild(new tui.Text("Current compacted view"));
    const document = new tui.Container();
    document.addChild(header);
    document.addChild(resources);
    document.addChild(chat);
    let renderedLines = [];
    const fakeTui = {
      mode: "fullscreen",
      children: [document],
      terminal: { columns: 140, rows: 45 },
      viewportTop: 10_000,
      isFollowingOutput: true,
      hasOverlay: () => false,
      requestRender() {},
      renderNow() { renderedLines = document.render(this.terminal.columns); },
      scrollBy(lines) { this.viewportTop = Math.max(0, this.viewportTop + lines); this.isFollowingOutput = false; },
      scrollToTop() { this.viewportTop = 0; this.isFollowingOutput = false; },
      scrollToBottom() { this.viewportTop = Math.max(0, renderedLines.length - this.terminal.rows); this.isFollowingOutput = true; },
    };
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        notify(text, kind) { notifications.push({ text, kind }); },
        onTerminalInput(handler) {
          inputListeners.add(handler);
          return () => inputListeners.delete(handler);
        },
        setWidget(key, content) {
          widgets.get(key)?.dispose?.();
          widgets.delete(key);
          if (typeof content === "function") widgets.set(key, content(fakeTui, themeApi.theme));
        },
        getToolsExpanded() { return false; },
        getEditorText() { return ""; },
        setEditorText() {},
      },
      shutdownHandler() {
        shutdowns += 1;
        notificationsAtShutdown.push(...notifications);
      },
      onError: (error) => errors.push(error),
    });
    assert.equal(inputListeners.size, 2, "Auto-compact and session-history must both observe input");
    assert.equal(widgets.size, 1);
    const compactions = () => manager.getBranch().filter((entry) => entry.type === "compaction");
    phase = `${trigger}: compacting through installed Pi`;
    if (trigger === "manual") {
      await session.compact();
    } else if (trigger === "quit") {
      await session.prompt(`/${QUIT_COMMAND}`);
      await waitFor(() => shutdowns === 1 || errors.length > 0, "pre-quit compaction");
    } else {
      mock.timers.tick(IDLE_MS - 1);
      assert.equal(compactions().length, 0, "Idle compaction started early");
      mock.timers.tick(1);
      await waitFor(() => compactions().length === 1 || errors.length > 0, "idle compaction");
    }
    // Let pi-vcc's delayed stats notification finish within this session.
    if (timersMocked) mock.timers.tick(500);
    else await pause(550);
    fakeTui.renderNow();
    const renderedHistory = tui.stripTerminalSequences(renderedLines.join("\n"));
    assert.match(renderedHistory, /Restored compacted history:/);
    assert.deepEqual(errors, []);
    assert.deepEqual(prompts, [], "Compaction must not launch an unsolicited agent turn");
    assert.equal(modelRequests, 0, "pi-vcc compaction must not call a model");
    assert.deepEqual(instructions, [undefined], "Prose becomes a pi-vcc follow-up prompt");
    assert.equal(compactions().length, 1);
    assert.equal(compactions()[0].fromHook, true);
    assert.equal(compactions()[0].details.compactor, "pi-vcc");
    assert.ok(compactions()[0].summary.trim());
    assert.equal(session.model.id, fixtureModel.id);
    assert.equal(session.thinkingLevel, "max");
    assert.equal(JSON.stringify(settings.getCompactionSettings(fixtureModel)), originalSettings);
    const restored = SessionManager.open(manager.getSessionFile());
    assert.equal(restored.getBranch().filter((entry) => entry.type === "compaction")[0].details.compactor, "pi-vcc");
    if (trigger !== "manual") {
      assert.ok(notifications.some(({ text, kind }) =>
        text === "Auto-compaction completed with pi-vcc." && kind === "info"));
    }
    if (trigger === "quit") {
      assert.ok(notificationsAtShutdown.some(({ text }) => text === "Auto-compaction completed with pi-vcc."));
    } else {
      assert.equal(shutdowns, 0);
    }
    log(`PASS: ${trigger}; actual pi-vcc checkpoint, zero model requests, no follow-up, max thinking, and preserved settings`);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(inputListeners.size, 0);
    assert.equal(widgets.size, 0);
    assert.equal(document.children.length, 3);
    session.dispose();
    session = undefined;
    if (timersMocked) {
      mock.timers.reset();
      timersMocked = false;
    }
  }
  succeeded = true;
  log(`PASS: installed Pi ${piInfo.version} and pi-vcc ${vccInfo.version}; manual, pre-quit, and clock-driven idle compaction`);
} finally {
  clearInterval(heartbeat);
  try {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    if (timersMocked) mock.timers.reset();
    if (previousConfigPath === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = previousConfigPath;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousTelemetry === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = previousTelemetry;
    rmSync(root, { recursive: true, force: true });
    log(`Temporary pi-vcc integration state removed; ${succeeded ? "SUCCESS" : "FAILED"}`);
  }
}
