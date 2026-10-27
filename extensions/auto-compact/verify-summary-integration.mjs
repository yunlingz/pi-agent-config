import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QUIT_COMMAND } from "./controller.mjs";

const packagePath = resolve(process.argv[2] ?? "");
const packageInfo = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-summary-"));
const agentDirectory = join(root, "agent");
mkdirSync(agentDirectory);
let session;
let phase = "loading installed Pi";
let succeeded = false;
let shutdowns = 0;
let summaryCalls = 0;
let failSummaries = true;
const requests = [];
const failures = [];
const notifications = [];
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Native summary check: ${phase}\n`);
}, 20_000);

function log(text) {
  process.stderr.write(`[${new Date().toISOString()}] ${text}\n`);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function event(response, type, fields) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}

function answer(response, request, index, length) {
  const text = length ? "Incomplete fixture summary." : "## Goal\nContinue the verified fixture.\n## Critical Context\nComplete native handoff.";
  const item = { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const result = {
    id: `resp_${index}`, object: "response", model: request.model, created_at: 1,
    status: length ? "incomplete" : "completed", output: [item], error: null,
    incomplete_details: length ? { reason: "max_output_tokens" } : null,
    usage: { input_tokens: 100, output_tokens: length ? request.max_output_tokens : 30, total_tokens: length ? request.max_output_tokens + 100 : 130 },
  };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  event(response, "response.created", { response: { ...result, status: "in_progress", output: [] } });
  event(response, "response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event(response, "response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event(response, "response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text });
  event(response, "response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text });
  event(response, "response.output_item.done", { output_index: 0, item });
  event(response, length ? "response.incomplete" : "response.completed", { response: result });
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const summary = JSON.stringify(body.input).includes("context summarization assistant");
    requests.push({ summary, model: body.model, effort: body.reasoning?.effort, limit: body.max_output_tokens });
    if (summary) {
      summaryCalls += 1;
    }
    answer(response, body, requests.length, summary && failSummaries);
  } catch (error) {
    failures.push(error.message);
    response.writeHead(500).end();
  }
});

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const sdk = await import(pathToFileURL(join(packagePath, "dist", "index.js")).href);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
  const fixture = {
    id: "auto-compact-summary-fixture", name: "Summary fixture", provider: "fixture",
    api: "openai-responses", baseUrl, reasoning: true, input: ["text"],
    thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
    contextWindow: 872000, maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelsPath = join(agentDirectory, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { api: fixture.api, baseUrl, apiKey: "local-fixture-key", models: [fixture] } } }), { mode: 0o600 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"), modelsPath,
    modelsStorePath: join(agentDirectory, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const settings = SettingsManager.inMemory({
    extensions: ["-builtin:mcp"], packages: [], cacheWarming: "off", transport: "sse",
    retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: agentDirectory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.create(root, join(root, "sessions"));
  for (let index = 0; index < 24; index += 1) {
    manager.appendMessage({ role: "user", content: `Synthetic historical turn ${index}. ${"Completed fixture evidence. ".repeat(300)}`, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Historical work is complete." }],
      api: fixture.api, provider: fixture.provider, model: fixture.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
  }
  ({ session } = await createAgentSession({
    cwd: root, agentDir: agentDirectory, modelRuntime, model: fixture, thinkingLevel: "max",
    settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [],
  }));
  const extensionErrors = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: { notify(text, kind) { notifications.push({ text, kind }); }, onTerminalInput() { return () => {}; }, getEditorText() { return ""; }, setEditorText() {} },
    shutdownHandler() { shutdowns += 1; },
    onError: (error) => extensionErrors.push(error),
  });
  phase = "reproducing the native max-reasoning output-cap failure";
  await assert.rejects(() => session.compact(), /generation hit the token cap/);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(requests[0].effort, "xhigh");
  assert.equal(requests[0].limit, 13107);
  assert.equal(session.thinkingLevel, "max");
  const originalSettings = JSON.stringify(settings.getCompactionSettings(fixture));
  const thinkingEntries = manager.getBranch().filter((entry) => entry.type === "thinking_level_change").length;
  phase = "checking trigger-only plugin preserves native failure and keeps Pi open";
  await session.prompt(`/${QUIT_COMMAND}`);
  await waitFor(() => notifications.some(({ kind }) => kind === "warning") || extensionErrors.length > 0, "native compaction failure");
  assert.equal(summaryCalls, 2, "The trigger-only plugin must not retry or alter native output policy");
  assert.equal(shutdowns, 0);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(session.thinkingLevel, "max");
  phase = "checking an explicit retry persists only a completed native handoff";
  failSummaries = false;
  await session.prompt(`/${QUIT_COMMAND}`);
  await waitFor(() => shutdowns === 1 || extensionErrors.length > 0, "completed native compaction");
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(failures, []);
  const owned = requests.filter((request) => request.summary).slice(1);
  assert.equal(owned.length, 2);
  assert.ok(owned.every((request) => request.model === fixture.id && request.effort === "xhigh" && request.limit === 13107));
  assert.equal(manager.getBranch().filter((entry) => entry.type === "thinking_level_change").length, thinkingEntries);
  assert.equal(JSON.stringify(settings.getCompactionSettings(fixture)), originalSettings);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  const restored = SessionManager.open(manager.getSessionFile());
  assert.equal(restored.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(session.thinkingLevel, "max");
  phase = "checking normal requests remain max reasoning";
  await session.prompt("Make one ordinary fixture response.");
  assert.equal(requests.at(-1).summary, false);
  assert.equal(requests.at(-1).effort, "xhigh");
  assert.equal(session.thinkingLevel, "max");
  succeeded = true;
  log(`PASS: installed Pi ${packageInfo.version}; manual/owned summaries preserve model, max reasoning and native output cap; failure keeps Pi open with no partial checkpoint; explicit retry persists a complete handoff; ${summaryCalls} local summary requests`);
} finally {
  if (!succeeded) {
    log(JSON.stringify({ phase, requests, shutdowns, summaryCalls, failures, notifications }));
  }
  clearInterval(heartbeat);
  try {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
    log(`Temporary integration state removed; ${succeeded ? "SUCCESS" : "FAILED"}`);
  }
}
