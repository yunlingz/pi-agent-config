import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STATUS_KEY } from "./cache-rate.mjs";

const packageArgument = process.argv[2];
assert.ok(packageArgument, "Usage: node verify-integration.mjs <installed-pi-package-directory>");
const packageDirectory = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = resolve(extensionDirectory, "../..");
const packageInfo = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-cache-rate-check-"));
const require = createRequire(pathToFileURL(join(packageDirectory, "package.json")));
let session;
let phase = "loading the installed Pi";
let passed = false;
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Cache-rate integration: ${phase}\n`);
}, 20_000);
const statuses = new Map();
const updates = [];
const errors = [];

globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("The cache-rate fixture must not use the network");
};

try {
  const sdk = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const ai = await import(pathToFileURL(join(packageDirectory, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], compaction: { enabled: false } });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(temporaryDirectory, "auth.json"), modelsPath: null,
    modelsStorePath: join(temporaryDirectory, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const fixtures = [
    { input: 3, cacheRead: 9200, cacheWrite: 797 },
    { input: 100, cacheRead: 900, cacheWrite: 0 },
  ];
  let calls = 0;
  modelRuntime.registerProvider("cache-rate-test", {
    api: "cache-rate-test", apiKey: "local-fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "fixture", name: "Cache-rate fixture", reasoning: false, input: ["text"],
      contextWindow: 64000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, _context, options = {}) {
      const stream = ai.createAssistantMessageEventStream();
      const fixture = fixtures[calls++];
      assert.ok(fixture, "Only the two planned fixture requests may run");
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending", content: [],
        usage: { ...fixture, output: 1, totalTokens: fixture.input + fixture.cacheRead + fixture.cacheWrite + 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        try {
          await options.onPayload?.({ simulated: true }, model);
          await options.onResponse?.({ status: 200, headers: {} }, model);
          stream.push({ type: "start", partial: message });
          const text = { type: "text", text: "" };
          message.content.push(text);
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          text.text = "Fixture complete.";
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) {
          message.stopReason = "error";
          message.errorMessage = error.message;
          stream.push({ type: "error", reason: "error", error: message });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: temporaryDirectory, agentDir: temporaryDirectory, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ["mcp"],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(extensionDirectory, "index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  ({ session } = await sdk.createAgentSession({
    cwd: temporaryDirectory, agentDir: temporaryDirectory, settingsManager: settings, modelRuntime,
    model: modelRuntime.getModel("cache-rate-test", "fixture"), thinkingLevel: "off",
    sessionManager: sdk.SessionManager.inMemory(), resourceLoader: loader, tools: [],
  }));
  await session.bindExtensions({
    mode: "tui",
    uiContext: { setStatus(key, value) {
      updates.push({ key, value });
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    } },
    onError: (error) => errors.push(error),
  });
  assert.equal(statuses.has(STATUS_KEY), false);
  phase = "checking actual message persistence and lifecycle updates";
  await session.prompt("Run the first local usage fixture.");
  assert.equal(statuses.get(STATUS_KEY), "cache in: 9.2k (92.0%)");
  await session.prompt("Run the second local usage fixture.");
  const expected = "cache in: 10k (91.8%)";
  assert.equal(statuses.get(STATUS_KEY), expected);
  assert.deepEqual([...new Set(updates.map(({ value }) => value).filter(Boolean))], [
    "cache in: 9.2k (92.0%)", expected,
  ], "No lifecycle update may double-count the ending response");
  assert.equal(calls, 2);
  assert.deepEqual(errors, []);

  phase = "checking installed Powerline parsing, layout, and rendering";
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, {
    fsCache: join(temporaryDirectory, "jiti-cache"),
    alias: {
      "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
      "@earendil-works/pi-coding-agent": join(packageDirectory, "dist/index.js"),
      "@earendil-works/pi-ai": join(packageDirectory, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    },
  });
  const footerDirectory = join(agentDirectory, "npm/node_modules/pi-powerline-footer");
  const configApi = await jiti.import(join(footerDirectory, "powerline-config.ts"));
  const presets = await jiti.import(join(footerDirectory, "presets.ts"));
  const segments = await jiti.import(join(footerDirectory, "segments.ts"));
  const globalSettings = JSON.parse(readFileSync(join(agentDirectory, "settings.json"), "utf8"));
  const config = configApi.parsePowerlineConfig(globalSettings.powerline, Object.keys(presets.PRESETS));
  assert.deepEqual(config.invalidLayoutSegments, []);
  assert.deepEqual(config.invalidDisabledSegments, []);
  const preset = presets.getPreset(config.preset);
  const layout = configApi.mergeSegmentsWithCustomItems(preset, config.customItems, config);
  assert.deepEqual(layout.leftSegments, preset.leftSegments.map((id) => id === "cache_read" ? "custom:cache_rate" : id));
  assert.deepEqual(layout.rightSegments, preset.rightSegments);
  assert.deepEqual(layout.secondarySegments, preset.secondarySegments);
  assert.ok(config.disabledSegments.includes("cache_read"));
  const hidden = configApi.collectHiddenExtensionStatusKeys(config.customItems);
  assert.ok(hidden.has(STATUS_KEY));
  const themeApi = await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/theme/theme.js")).href);
  const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
  for (const mode of ["truecolor", "256color"]) {
    const theme = themeApi.loadThemeFromPath(join(agentDirectory, "themes/ci_dark.json"), mode);
    const context = {
      theme, colors: preset.colors,
      customItemsById: new Map(config.customItems.map((item) => [item.id, item])),
      extensionStatuses: statuses, hiddenExtensionStatusKeys: hidden,
    };
    const rendered = segments.renderSegment("custom:cache_rate", context);
    assert.equal(rendered.visible, true);
    assert.equal(rendered.content, theme.fg("muted", expected));
    assert.equal(tui.visibleWidth(rendered.content), expected.length);
    assert.equal(segments.renderSegment("extension_statuses", context).visible, false);
  }
  statuses.set("other-extension", "Other status");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(statuses.has(STATUS_KEY), false);
  assert.equal(statuses.get("other-extension"), "Other status");
  assert.equal(networkAttempts, 0);
  passed = true;
  console.log(`PASS: Pi ${packageInfo.version}; actual lifecycle updates, installed custom renderer in both color modes, original cache position, no duplicate segment, and zero network requests`);
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
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: cache-rate integration; temporary fixtures removed\n`);
  }
}
