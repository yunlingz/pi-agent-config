import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ProviderModelConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import { testTUI, testUI, type FooterConfigModule, type FooterPresetsModule, type FooterSegmentsModule } from "../../scripts/test-fixtures.ts";
import { readJson, readPackageInfo } from "../../scripts/verification-data.ts";
import type { CitationAnnotation, SearchDetails, SearchResult } from "./types.ts";
import type { FixtureEvent, FixtureMessage, FixtureOutput, FixtureToolCall, VerificationPayload } from "./verification-fixtures.ts";
import { createSearchRenderers } from "./render.ts";

const packageArgument = process.argv[2];
assert.ok(packageArgument, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const packageDirectory = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = resolve(extensionDirectory, "../..");
// The supplied directory is an installed Pi package; check its name before loading its API.
const packageInfo = readPackageInfo(join(packageDirectory, "package.json"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-web-search-integration-"));
const require = createRequire(pathToFileURL(join(packageDirectory, "package.json")));
const originalFetch = globalThis.fetch;
const modelLevels = [["gpt-6-astra", "medium"], ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-terra", "max"]] as const;
const statuses = new Map<string, string>();
const updates: SearchResult[] = [];
const errors: unknown[] = [];
let session: AgentSession | undefined;
let currentModel: string;
let currentLevel: string;
let mainIndex = 0;
let generationCount = 0;
let countChecks = 0;
let totalGenerations = 0;
let passed = false;
let phase = "loading installed Pi";
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Web-search integration: ${phase}\n`);
}, 20_000);

function streamFixture(model: string, output: FixtureOutput[]): string {
  const responseId = `resp_fixture_${totalGenerations++}`;
  const events: FixtureEvent[] = [{ type: "response.created", response: { id: responseId } }];
  for (const [index, item] of output.entries()) {
    if (item.type === "web_search_call") {
      events.push(
        { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } },
        { type: "response.web_search_call.searching", output_index: index, item_id: item.id },
        { type: "response.output_item.done", output_index: index, item },
        { type: "response.web_search_call.completed", output_index: index, item_id: item.id },
      );
    } else if (item.type === "message") {
      events.push(
        { type: "response.output_item.added", output_index: index, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text },
        { type: "response.output_item.done", output_index: index, item },
      );
    } else if (item.type === "function_call") {
      events.push(
        { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: index, delta: item.arguments },
        { type: "response.output_item.done", output_index: index, item },
      );
    }
  }
  events.push({ type: "response.completed", response: {
    id: responseId, model, status: "completed", output,
    usage: { input_tokens: 200, output_tokens: 10, total_tokens: 210, output_tokens_details: { reasoning_tokens: 0 } },
  } });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function message(text: string, annotations: CitationAnnotation[] = []): FixtureMessage {
  return { type: "message", id: `msg_${totalGenerations}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] };
}

function toolCall(name: string, args: Record<string, string>): FixtureToolCall {
  return { type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(args), status: "completed" };
}

try {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, "http://127.0.0.1:1", "Only the local transport fixture is allowed");
    // The installed Responses adapter owns this serialized request shape; assertions below check its relevant fields.
    const payload = await request.json() as VerificationPayload;
    assert.equal(payload.model, currentModel);
    const efforts = payload.input.filter((item) => item.type === "configuration_update").map((item) => item.reasoning?.effort);
    const nested = payload.tools?.some((tool) => tool.type === "web_search");
    if (nested) {
      assert.deepEqual(payload.reasoning, { effort: "low" }, "Every search must use low, even when the main model configuration restricts low");
      assert.deepEqual(efforts, [], "Search must not inherit a reasoning configuration update");
      assert.deepEqual(payload.tools, [{ type: "web_search" }]);
      assert.deepEqual(payload.tool_choice, { type: "web_search" });
      assert.equal(payload.truncation, "disabled");
      assert.doesNotMatch(JSON.stringify(payload.input), /MAIN_HISTORY_ONLY/u, "Main-session history must not enter the independent request");
      assert.match(JSON.stringify(payload.input), /SELECTED_CONTEXT/u);
      if (request.url.endsWith("/input_tokens")) {
        countChecks++;
        assert.equal(payload.max_output_tokens, undefined);
        return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: 64000 }), { headers: { "content-type": "application/json" } });
      }
      assert.equal(payload.max_output_tokens, 32000);
      generationCount++;
      const marker = "\uE200cite\uE202turn0search0\uE201";
      const text = `A verified source.${marker}`;
      return new Response(streamFixture(currentModel, [
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "official fixture source" } },
        message(text, [{ type: "url_citation", title: "Official source", url: "https://example.com/source", start_index: "A verified source.".length, end_index: text.length }]),
      ]), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(efforts.at(-1) ?? payload.reasoning?.effort, currentLevel, "Main-session reasoning must remain unchanged");
    assert.ok(!request.url.endsWith("/input_tokens"), "Main requests must not use the search counter");
    const names = (payload.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes("read"));
    assert.equal(names.includes("web_run"), mainIndex < 2);
    assert.ok(!payload.tools?.some((tool) => ["web_search", "web_search_preview"].includes(tool.type)));
    const index = mainIndex++;
    if (index === 0) {
      return new Response(streamFixture(currentModel, [
        toolCall("web_run", { query: "official source", context: "SELECTED_CONTEXT" }),
        toolCall("read", { path: "marker.txt" }),
      ]), { headers: { "content-type": "text/event-stream" } });
    }
    if (index === 1) {
      assert.match(JSON.stringify(payload.input), /https:\/\/example.com\/source/u, "Source links reach the main follow-up request");
      assert.match(JSON.stringify(payload.input), /WEB_SEARCH_READ_OK/u);
    }
    assert.ok(index < 3, "Only planned requests may run");
    return new Response(streamFixture(currentModel, [message("Fixture complete.")]), { headers: { "content-type": "text/event-stream" } });
  };
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  await writeFile(join(temporaryDirectory, "marker.txt"), "WEB_SEARCH_READ_OK\n");
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(temporaryDirectory, "auth.json"), modelsPath: null,
    modelsStorePath: join(temporaryDirectory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider("existing_gateway", {
    api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only",
    models: [...modelLevels.map(([id, level]): ProviderModelConfig => ({
      id, name: id, reasoning: true, input: ["text"], contextWindow: 1050000, maxTokens: 128000,
      thinkingLevelMap: Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((item) => [item, item === level ? level : null])),
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })), { id: "unsupported", name: "Unsupported fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  let savedResult: SearchResult | undefined;
  for (const [id, level] of modelLevels) {
    currentModel = id;
    currentLevel = level;
    mainIndex = 0;
    generationCount = 0;
    countChecks = 0;
    phase = `testing ${id}, isolation, token budget, usage, and real tools`;
    const settings = sdk.SettingsManager.inMemory({ extensions: ["-builtin:mcp"], packages: [], transport: "sse", retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({
      cwd: temporaryDirectory, agentDir: temporaryDirectory, settingsManager: settings,
      noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(extensionDirectory, "index.ts")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    ({ session } = await sdk.createAgentSession({
      cwd: temporaryDirectory, agentDir: temporaryDirectory, settingsManager: settings, modelRuntime: runtime,
      model: runtime.getModel("existing_gateway", id), thinkingLevel: level,
      resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(), tools: ["read", "web_run"],
    }));
    assert.ok(session);
    await session.bindExtensions({
      mode: "tui", uiContext: testUI(session, {
        setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
        notify() {},
      }), onError: (error: unknown) => errors.push(error),
    });
    session.subscribe((event) => {
      if (event.type === "tool_execution_update" && event.toolName === "web_run") {
        // Pi erases tool-specific details in session events. web_run emits SearchResult updates.
        const update: SearchResult = event.partialResult;
        updates.push(update);
      }
    });
    assert.equal(statuses.get("web-search"), "web: on");
    await session.prompt(`MAIN_HISTORY_ONLY ${"unrelated ".repeat(150000)} Run the fixture.`);
    const messages = session.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message);
    const result = messages.filter((item) => item.role === "toolResult").find((item) => item.toolName === "web_run");
    assert.ok(result && !result.isError, "Independent search must succeed as a normal Pi tool");
    const content = result.content[0];
    assert.ok(content.type === "text");
    assert.match(content.text, /A verified source\. \[Official source\]/u);
    // Persisted tool results erase their generic details. This entry comes from this extension's web_run tool.
    const details = result.details as ToolResultMessage<SearchDetails>["details"];
    assert.ok(details);
    assert.equal(details.inputTokens, 64000);
    assert.equal(details.thinkingLevel, "low");
    assert.ok(result.usage);
    assert.equal(result.usage.totalTokens, 210, "Nested LLM usage must persist on the tool result");
    assert.ok(messages.some((item) => item.role === "toolResult" && item.toolName === "read" && !item.isError));
    assert.equal(session.thinkingLevel, level);
    assert.equal(session.getSessionStats().tokens.total, 630, "Session totals include two main responses plus independent search");
    savedResult = { ...result, details: { ...details, sources: [...details.sources] } };
    await session.prompt("/web-search off");
    assert.equal(statuses.get("web-search"), "web: off");
    assert.ok(!session.getActiveToolNames().includes("web_run"));
    await session.prompt("Run without web search.");
    assert.equal(mainIndex, 3);
    assert.equal(countChecks, 1);
    assert.equal(generationCount, 1);
    await session.prompt("/web-search on");
    const unsupportedModel = runtime.getModel("existing_gateway", "unsupported");
    assert.ok(unsupportedModel);
    await session.setModel(unsupportedModel);
    assert.equal(statuses.get("web-search"), "web: unavailable");
    assert.ok(!session.getActiveToolNames().includes("web_run"));
    const supportedModel = runtime.getModel("existing_gateway", id);
    assert.ok(supportedModel);
    await session.setModel(supportedModel);
    assert.equal(statuses.get("web-search"), "web: on");
    assert.ok(session.getActiveToolNames().includes("web_run"));
    assert.deepEqual(errors, []);
    const runner = session.extensionRunner;
    assert.ok(runner);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    session = undefined;
    assert.equal(statuses.has("web-search"), false);
    console.log(`PASS: ${id}; search reasoning low, main reasoning ${level}, isolated context, budget, usage, read, and controls`);
  }

  phase = "checking installed Powerline and tool renderers";
  const tui: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(join(packageDirectory, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") = await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/theme/theme.js")).href);
  const { ToolExecutionComponent }: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js") = await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/components/tool-execution.js")).href);
  const { createJiti }: {
    createJiti(path: string, options: { fsCache: string; alias: Record<string, string> }): { import<T>(path: string): Promise<T> };
  } = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, { fsCache: join(temporaryDirectory, "jiti-cache"), alias: {
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    "@earendil-works/pi-coding-agent": join(packageDirectory, "dist/index.js"),
    "@earendil-works/pi-ai": join(packageDirectory, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  } });
  const footerDirectory = join(agentDirectory, "npm/node_modules/pi-powerline-footer");
  const configApi = await jiti.import<FooterConfigModule>(join(footerDirectory, "powerline-config.ts"));
  const presets = await jiti.import<FooterPresetsModule>(join(footerDirectory, "presets.ts"));
  const segments = await jiti.import<FooterSegmentsModule>(join(footerDirectory, "segments.ts"));
  const globalSettings = readJson<ReturnType<SettingsManager["getGlobalSettings"]> & { powerline?: unknown }>(join(agentDirectory, "settings.json"));
  const config = configApi.parsePowerlineConfig(globalSettings.powerline, Object.keys(presets.PRESETS));
  assert.deepEqual(config.invalidLayoutSegments, []);
  assert.deepEqual(config.invalidDisabledSegments, []);
  const preset = presets.getPreset(config.preset);
  const layout = configApi.mergeSegmentsWithCustomItems(preset, config.customItems, config);
  assert.ok(layout.leftSegments.includes("custom:web_search"));
  const hidden = configApi.collectHiddenExtensionStatusKeys(config.customItems);
  assert.ok(hidden.has("web-search"));
  const capabilities = tui.getCapabilities();
  const renderers = createSearchRenderers({ ...tui, getMarkdownTheme: themeApi.getMarkdownTheme });
  const longQuery = "What are the latest MSFT and AAPL prices? Verify current quotes and exact timestamps. ".repeat(12);
  assert.ok(savedResult);
  const resultContext = { durationMs: undefined, isError: false };
  const longResult: SearchResult = {
    content: [{ type: "text", text: "### Latest quotes\n\n| Stock | Price | Timestamp |\n| --- | --- | --- |\n".repeat(20) }],
    details: { ...savedResult.details, status: "done", elapsedMs: 61600 },
  };
  try {
    for (const colorMode of ["truecolor", "256color"] as const) {
      const theme = themeApi.loadThemeFromPath(join(agentDirectory, "themes/ci_dark.json"), colorMode);
      themeApi.setThemeInstance(theme);
      for (const value of ["web: on", "web: off", "web: unavailable"]) {
        statuses.set("web-search", value);
        const rendered = segments.renderSegment("custom:web_search", {
          theme, colors: preset.colors, customItemsById: new Map(config.customItems.map((item) => [item.id, item])),
          extensionStatuses: statuses, hiddenExtensionStatusKeys: hidden,
        });
        assert.equal(rendered.visible, true);
        assert.equal(rendered.content, theme.fg("muted", value));
      }
      for (const hyperlinks of [true, false]) {
        tui.setCapabilities({ ...capabilities, hyperlinks });
        for (const width of [8, 16, 24, 32, 80, 120, 240]) {
          const call = renderers.renderCall({ query: longQuery }, theme, { expanded: false });
          const callLines = call.render(width);
          assert.equal(callLines.length, 1);
          assert.equal(stripVTControlCharacters(callLines[0]).trim(), "web.run");
          for (const result of [
            longResult,
            ...updates,
            { ...longResult, isError: true, details: { ...longResult.details, status: "error", error: longQuery } },
            { ...longResult, isError: true, details: { ...longResult.details, status: "cancelled", error: longQuery } },
          ] satisfies SearchResult[]) {
            const component = renderers.renderResult(result, { expanded: false, isPartial: result.details.status === "running" }, theme, resultContext);
            const lines = [...callLines, ...component.render(width)];
            assert.equal(lines.length, 2, "Collapsed searches must use only a label and one status line");
            assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
            assert.doesNotMatch(stripVTControlCharacters(lines.join("\n")), /\.\.\.|…|MSFT|Timestamp|stockanalysis|###|\|/u,
              "Collapsed searches must not show queries, result previews, domains, or truncation marks");
          }
          if (width >= 16) {
            const tool = new ToolExecutionComponent("web_run", "ui_fixture", { query: longQuery }, {}, {
              ...renderers,
              renderCall(args, theme, context) {
                assert.deepEqual(args, { query: longQuery });
                return renderers.renderCall({ query: longQuery }, theme, context);
              },
            }, testTUI(new tui.Container()), temporaryDirectory);
            tool.updateResult({ ...longResult, isError: false });
            const collapsed = tool.render(width).map(stripVTControlCharacters).filter((line: string) => line.trim());
            assert.equal(collapsed.length, 2, "Pi's complete tool component must retain the two-line collapsed UI");
            assert.equal(collapsed[0].trim(), "web.run");
            assert.ok(collapsed.every((line: string) => tui.visibleWidth(line) <= width));
            assert.doesNotMatch(collapsed.join("\n"), /\.\.\.|…|MSFT|Timestamp|###|\|/u);
            if (width === 120) {
              tool.setExpanded(true);
              const expanded = tool.render(width).map(stripVTControlCharacters).join("\n");
              assert.match(expanded, /What are the latest MSFT and AAPL prices/u, "Expansion must retain the query");
              assert.match(expanded, /Latest quotes/u, "Expansion must retain the full findings");
              tool.setExpanded(false);
              assert.equal(tool.render(width).map(stripVTControlCharacters).filter((line: string) => line.trim()).length, 2);
            }
          }
          for (const expanded of [true, false]) {
            const result = renderers.renderResult(savedResult, { expanded, isPartial: false }, theme, resultContext);
            const lines = result.render(width);
            assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
            if (expanded && width === 120) {
              const joined = lines.join("\n");
              assert.match(joined, /Official source/u);
              assert.match(joined, /https:\/\/example.com\/source/u);
              assert.equal(joined.includes("\u001b]8;;https://example.com/source"), hyperlinks);
            }
          }
        }
      }
    }
    assert.ok(updates.some((result) => result.details.phase === "Searching the web"));
    assert.ok(updates.some((result) => result.details.phase === "Preparing findings"));
    await writeFile(join(temporaryDirectory, "render-review.txt"), [
      ...renderers.renderCall({ query: "Node.js official release" }, themeApi.theme, { expanded: false }).render(100),
      ...renderers.renderResult(savedResult, { expanded: false, isPartial: false }, themeApi.theme, resultContext).render(100),
      "", "Expanded:", ...renderers.renderResult(savedResult, { expanded: true, isPartial: false }, themeApi.theme, resultContext).render(100),
    ].join("\n"));
    console.log("RENDER REVIEW:\n" + (await readFile(join(temporaryDirectory, "render-review.txt"), "utf8")).replace(/\u001b\[[0-9;]*m/gu, ""));
  } finally {
    tui.setCapabilities(capabilities);
  }
  passed = true;
  console.log(`PASS: Pi ${packageInfo.version}; two-line collapsed UI, no ellipses, clickable expanded citations, both color modes, narrow widths, Powerline, and no external network`);
} finally {
  clearInterval(heartbeat);
  globalThis.fetch = originalFetch;
  try {
    if (session) {
      await session.abort();
      session.dispose();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: web-search integration; temporary fixtures removed\n`);
  }
}
