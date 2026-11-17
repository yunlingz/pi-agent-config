import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  testUI,
  type FooterConfigModule,
  type FooterPresetsModule,
  type FooterSegmentsModule,
} from "../../scripts/test-fixtures.ts";
import { readJson, readPackageInfo, resolveInstalledEntry } from "../../scripts/verification-data.ts";
import { STATUS_KEY } from "./token-usage.ts";
import { STATUS_KEY as CODE_ANCHOR_STATUS_KEY } from "../code-anchor/controls.ts";

const argument = process.argv[2];
assert.ok(argument, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const packageDirectory = resolve(argument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = resolve(extensionDirectory, "../..");
const packageInfo = readPackageInfo(join(packageDirectory, "package.json"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
let session: AgentSession | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let phase = "loading the installed Pi";
let networkAttempts = 0;
let passed = false;
const originalFetch = globalThis.fetch;
const statuses = new Map<string, string>();
const updates: string[] = [];
const errors: unknown[] = [];
const emptyStatus = "in 0 · cr 0 · cw 0 · out 0 · cache --";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-token-usage-check-"));
try {
  heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] Token-usage integration: ${phase}\n`);
  }, 20_000);
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("The token-usage fixture must not use the network");
  };
  const require = createRequire(pathToFileURL(join(packageDirectory, "package.json")));
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const aiEntry = resolveInstalledEntry("@earendil-works/pi-ai", packageDirectory);
  const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(aiEntry).href);
  const settings = sdk.SettingsManager.inMemory({
    extensions: ["-builtin:mcp"],
    packages: [],
    compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 0 },
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(temporaryDirectory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(temporaryDirectory, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const normalFixtures = [
    { input: 100, cacheRead: 900, cacheWrite: 20, output: 10 },
    { input: 20, cacheRead: 980, cacheWrite: 5, output: 5 },
    { input: 50, cacheRead: 60, cacheWrite: 15, output: 9 },
    { input: 63000, cacheRead: 100, cacheWrite: 0, output: 1 },
    { input: 10, cacheRead: 90, cacheWrite: 0, output: 2 },
  ];
  const summaryFixture = { input: 30, cacheRead: 80, cacheWrite: 10, output: 7 };
  const zeroFixture = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let normalCalls = 0;
  let summaryCalls = 0;
  let summarizing = false;
  let failCompaction = false;
  let cancelNextCompaction = false;
  const completedReasons: string[] = [];
  modelRuntime.registerProvider("token-usage-test", {
    api: "token-usage-test",
    apiKey: "local-fixture-only",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "fixture",
      name: "Token-usage fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 64000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, _context, options = {}) {
      const stream = ai.createAssistantMessageEventStream();
      const aborted = options.signal?.aborted === true;
      const failed = summarizing && failCompaction;
      const fixture = aborted || failed
        ? zeroFixture
        : summarizing ? summaryFixture : normalFixtures[normalCalls++];
      if (summarizing) summaryCalls += 1;
      assert.ok(fixture, "Only the planned normal requests may run");
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "pending",
        content: [],
        usage: {
          ...fixture,
          totalTokens: fixture.input + fixture.cacheRead + fixture.cacheWrite + fixture.output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        try {
          options.signal?.throwIfAborted();
          if (failed) throw new Error("Intentional fixture summary failure");
          await options.onPayload?.({ simulated: true }, model);
          await options.onResponse?.({ status: 200, headers: {} }, model);
          stream.push({ type: "start", partial: message });
          const text: TextContent = { type: "text", text: "" };
          message.content.push(text);
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          text.text = "Fixture complete.";
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) {
          const reason = options.signal?.aborted ? "aborted" : "error";
          message.stopReason = reason;
          message.errorMessage = error instanceof Error ? error.message : "Fixture stream failed.";
          stream.push({ type: "error", reason, error: message });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
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

  async function startSession(sessionManager: SessionManager): Promise<AgentSession> {
    const created = await sdk.createAgentSession({
      cwd: temporaryDirectory,
      agentDir: temporaryDirectory,
      settingsManager: settings,
      modelRuntime,
      model: modelRuntime.getModel("token-usage-test", "fixture"),
      thinkingLevel: "off",
      sessionManager,
      resourceLoader: loader,
      tools: [],
    });
    await created.session.bindExtensions({
      mode: "tui",
      uiContext: testUI(created.session, { setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else {
          statuses.set(key, value);
          if (key === STATUS_KEY) updates.push(value);
        }
      } }),
      onError: (error) => errors.push(error),
    });
    return created.session;
  }

  session = await startSession(sdk.SessionManager.create(temporaryDirectory, join(temporaryDirectory, "sessions")));
  session.subscribe((event) => {
    if (event.type === "compaction_start") {
      summarizing = true;
      if (cancelNextCompaction) {
        cancelNextCompaction = false;
        session?.abortCompaction();
      }
    } else if (event.type === "compaction_end") {
      summarizing = false;
      if (event.result) completedReasons.push(event.reason);
    }
  });
  assert.equal(statuses.get(STATUS_KEY), emptyStatus);
  phase = "checking native manual compaction";
  await session.prompt("Run the first local usage fixture.");
  const firstStatus = "in 100 · cr 900 · cw 20 · out 10 · cache 88.2%";
  assert.equal(statuses.get(STATUS_KEY), firstStatus);
  await session.prompt("Run the second local usage fixture.");
  const secondStatus = "in 120 · cr 1.9K · cw 25 · out 15 · cache 92.8%";
  assert.equal(statuses.get(STATUS_KEY), secondStatus);
  const beforeCompaction = session.sessionManager.getEntries().length;
  await session.compact();
  assert.equal(statuses.get(STATUS_KEY), emptyStatus);
  assert.ok(session.sessionManager.getEntries().length > beforeCompaction, "Compaction must retain old entries");
  await session.prompt("Continue after manual compaction.");
  const afterManual = "in 50 · cr 60 · cw 15 · out 9 · cache 48.0%";
  assert.equal(statuses.get(STATUS_KEY), afterManual);

  phase = "checking failed and cancelled compaction";
  const savedCompactions = session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
  failCompaction = true;
  await assert.rejects(session.compact(), /Intentional fixture summary failure/);
  failCompaction = false;
  assert.equal(statuses.get(STATUS_KEY), afterManual);
  cancelNextCompaction = true;
  await assert.rejects(session.compact(), /cancel|abort/i);
  assert.equal(statuses.get(STATUS_KEY), afterManual);
  assert.equal(session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, savedCompactions);

  phase = "checking native automatic compaction";
  session.setAutoCompactionEnabled(true);
  await session.prompt("Run the high-usage fixture to trigger automatic compaction.");
  assert.deepEqual(completedReasons, ["manual", "threshold"]);
  assert.equal(statuses.get(STATUS_KEY), emptyStatus);
  session.setAutoCompactionEnabled(false);
  await session.prompt("Continue after automatic compaction.");
  const expected = "in 10 · cr 90 · cw 0 · out 2 · cache 90.0%";
  assert.equal(statuses.get(STATUS_KEY), expected);
  assert.equal(normalCalls, normalFixtures.length);
  assert.ok(summaryCalls >= 2, "Both native compaction paths must call the local provider");
  const automaticStatus = "in 63.1K · cr 160 · cw 15 · out 10 · cache 0.3%";
  assert.deepEqual([...new Set(updates)], [emptyStatus, firstStatus, secondStatus, afterManual, automaticStatus, expected],
    "Lifecycle events must not double-count usage");

  phase = "checking reload and persisted-session resume";
  await session.reload();
  assert.equal(statuses.get(STATUS_KEY), expected);
  const sessionFile = session.sessionManager.getSessionFile();
  assert.ok(sessionFile, "The fixture session must be persisted");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  session = undefined;
  session = await startSession(sdk.SessionManager.open(sessionFile));
  assert.equal(statuses.get(STATUS_KEY), expected);
  assert.deepEqual(errors, []);

  phase = "checking installed Powerline layout and rendering";
  assert.equal(existsSync(join(agentDirectory, "extensions/cache-rate")), false);
  const { createJiti }: typeof import("jiti") = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, {
    fsCache: join(temporaryDirectory, "jiti-cache"),
    alias: {
      "@earendil-works/pi-tui": resolveInstalledEntry("@earendil-works/pi-tui", packageDirectory),
      "@earendil-works/pi-coding-agent": join(packageDirectory, "dist/index.js"),
      "@earendil-works/pi-ai": aiEntry,
    },
  });
  const footerDirectory = join(agentDirectory, "npm/node_modules/pi-powerline-footer");
  const configApi = await jiti.import<FooterConfigModule>(join(footerDirectory, "powerline-config.ts"));
  const presets = await jiti.import<FooterPresetsModule>(join(footerDirectory, "presets.ts"));
  const segments = await jiti.import<FooterSegmentsModule>(join(footerDirectory, "segments.ts"));
  const globalSettings = readJson<ReturnType<SettingsManager["getGlobalSettings"]> & { powerline?: unknown }>(join(agentDirectory, "settings.json"));
  const config = configApi.parsePowerlineConfig(globalSettings.powerline, Object.keys(presets.PRESETS));
  assert.deepEqual(config.invalidLayoutSegments, []);
  assert.deepEqual(config.invalidDisabledSegments, []);
  assert.deepEqual(config.customItems.map((item) => item.id), ["web_search", "code_anchor", "token_usage"]);
  const preset = presets.getPreset(config.preset);
  const layout = configApi.mergeSegmentsWithCustomItems(preset, config.customItems, config);
  assert.deepEqual(layout.leftSegments, [
    "model", "thinking", "custom:web_search", "custom:code_anchor", "shell_mode", "path", "git", "queue",
    "context_pct", "custom:token_usage",
  ]);
  assert.deepEqual(layout.rightSegments, preset.rightSegments);
  assert.deepEqual(layout.secondarySegments, preset.secondarySegments);
  const hidden = configApi.collectHiddenExtensionStatusKeys(config.customItems);
  assert.ok(hidden.has(STATUS_KEY));
  assert.ok(hidden.has(CODE_ANCHOR_STATUS_KEY));
  const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") = await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/theme/theme.js")).href);
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(resolveInstalledEntry("@earendil-works/pi-tui", packageDirectory)).href);
  for (const mode of ["truecolor", "256color"] as const) {
    const theme = themeApi.loadThemeFromPath(join(agentDirectory, "themes/ci_dark.json"), mode);
    const context = {
      theme,
      colors: preset.colors,
      customItemsById: new Map(config.customItems.map((item) => [item.id, item])),
      extensionStatuses: statuses,
      hiddenExtensionStatusKeys: hidden,
    };
    const rendered = segments.renderSegment("custom:token_usage", context);
    assert.equal(rendered.visible, true);
    assert.equal(rendered.content, theme.fg("muted", expected));
    assert.equal(tui.visibleWidth(rendered.content), expected.length);
    for (const status of ["code-anchor: on", "code-anchor: off"]) {
      statuses.set(CODE_ANCHOR_STATUS_KEY, status);
      const codeAnchor = segments.renderSegment("custom:code_anchor", context);
      assert.equal(codeAnchor.visible, true);
      assert.equal(codeAnchor.content, theme.fg("muted", status));
      assert.equal(tui.visibleWidth(codeAnchor.content), status.length);
      assert.equal(segments.renderSegment("extension_statuses", context).visible, false);
    }
    statuses.delete(CODE_ANCHOR_STATUS_KEY);
    assert.equal(segments.renderSegment("extension_statuses", context).visible, false);
    for (const width of [60, 100, 160]) assert.ok(tui.visibleWidth(rendered.content) <= width);
  }
  statuses.set("other-extension", "Other status");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(statuses.has(STATUS_KEY), false);
  assert.equal(statuses.get("other-extension"), "Other status");
  assert.equal(networkAttempts, 0);
  passed = true;
  console.log(`PASS: Pi ${packageInfo.version}; manual/automatic resets, failed/cancelled compaction, reload/resume, five values, installed renderer in both color modes, zero network requests`);
} finally {
  clearInterval(heartbeat);
  globalThis.fetch = originalFetch;
  try {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    assert.equal(existsSync(temporaryDirectory), false, "Temporary fixtures must be removed");
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: token-usage integration; temporary fixtures removed\n`);
  }
}
