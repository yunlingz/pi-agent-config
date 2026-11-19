import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import { testCommandActions, testUI } from "../../scripts/test-fixtures.ts";
import { parseTrustedJson, readPackageInfo } from "../../scripts/verification-data.ts";

interface Payload {
  model: string;
  input: unknown;
  max_output_tokens: number;
  reasoning?: { effort?: string };
}

const packageArgument = process.argv[2];
assert(packageArgument, "Usage: node verify-integration.ts <installed-pi-package-directory>");
const installation = resolve(packageArgument);
assert.equal(readPackageInfo(join(installation, "package.json")).name, "@earendil-works/pi-coding-agent");
const root = await mkdtemp(join(tmpdir(), "pi-compact-quit-check-"));
const agent = join(root, "agent");
let session: AgentSession | undefined;
let commandTask: Promise<void> | undefined;
let phase = "loading installed Pi";
let passed = false;
let shutdowns = 0;
let active = 0;
let maximumActive = 0;
let failSummaries = false;
let holdSummaries = false;
let holdOrdinary = false;
let networkAttempts = 0;
const releases: (() => void)[] = [];
const requests: { summary: boolean; model: string; input: string; effort: string | undefined; limit: number }[] = [];
const notifications: { text: string; kind: string | undefined }[] = [];
const errors: unknown[] = [];
const originalFetch = globalThis.fetch;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Compact-quit verification: ${phase}\n`);
}, 20_000);

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
}

function answer(response: ServerResponse, body: Payload, index: number, summary: boolean, incomplete: boolean) {
  const text = summary ? "Native summary fixture." : "Ordinary response fixture.";
  const item = { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const result = {
    id: `resp_${index}`, object: "response", model: body.model, created_at: 1,
    status: incomplete ? "incomplete" : "completed", output: [item], error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
  };
  const event = (type: string, fields: Record<string, unknown>) => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  event("response.created", { response: { ...result, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text });
  event("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text });
  event("response.output_item.done", { output_index: 0, item });
  event(incomplete ? "response.incomplete" : "response.completed", { response: result });
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    // Only Pi's installed Responses adapter writes this loopback payload.
    const body = parseTrustedJson<Payload>(Buffer.concat(chunks).toString("utf8"));
    const input = JSON.stringify(body.input);
    const summary = input.includes("context summarization assistant");
    requests.push({ summary, input, model: body.model, effort: body.reasoning?.effort, limit: body.max_output_tokens });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      active -= 1;
    };
    response.once("finish", finish);
    response.once("close", finish);
    const release = () => {
      if (!response.destroyed) answer(response, body, requests.length, summary, summary && failSummaries);
    };
    if (summary ? holdSummaries : holdOrdinary) releases.push(release);
    else release();
  } catch (error) {
    errors.push(error);
    response.writeHead(500).end();
  }
});

try {
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${baseUrl}/`)) {
      networkAttempts += 1;
      throw new Error("External network access is prohibited in this fixture");
    }
    return originalFetch(input, init);
  };
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(installation, "dist/index.js")).href);
  await mkdir(join(agent, "extensions"), { recursive: true });
  await symlink(dirname(fileURLToPath(import.meta.url)), join(agent, "extensions", "compact-quit"), process.platform === "win32" ? "junction" : "dir");
  const model: Model<"openai-responses"> = {
    id: "compact-quit-fixture", name: "Compact-quit fixture", provider: "fixture",
    api: "openai-responses", baseUrl, reasoning: true, input: ["text"],
    thinkingLevelMap: { xhigh: "xhigh" }, contextWindow: 872000, maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelsPath = join(agent, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { api: model.api, baseUrl, apiKey: "local-fixture-key", models: [model] } } }));
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agent, "auth.json"), modelsPath, modelsStorePath: join(agent, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const settings = sdk.SettingsManager.inMemory({
    extensions: ["-builtin:mcp"], packages: [], cacheWarming: "off", transport: "sse",
    compaction: { keepRecentTokens: 300 }, retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const originalSettings = JSON.stringify(settings.getSettings());

  async function createSession(withExtension = true, withHistory = true) {
    shutdowns = 0;
    maximumActive = 0;
    notifications.length = 0;
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: agent, settingsManager: settings, noExtensions: !withExtension,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extensions = loader.getExtensions().extensions;
    assert.equal(extensions.length, withExtension ? 1 : 0);
    if (withExtension) {
      assert.deepEqual([...extensions[0].commands.keys()], ["compact-quit"]);
      assert.equal(extensions[0].handlers.size, 0, "The command must not intercept idle, input, quit, or compaction events");
      assert.equal(extensions[0].tools.size, 0);
      assert.equal(extensions[0].shortcuts.size, 0);
    }
    const manager = sdk.SessionManager.create(root, join(root, "sessions"));
    if (withHistory) populateSplitHistory(manager, model, "CHECK");
    ({ session } = await sdk.createAgentSession({
      cwd: root, agentDir: agent, modelRuntime: runtime, model, thinkingLevel: "xhigh",
      settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [],
    }));
    await session.bindExtensions({
      mode: "tui", uiContext: testUI(session, {
        notify: (text, kind) => notifications.push({ text, kind }),
        onTerminalInput: () => assert.fail("The command must not intercept terminal input"),
      }),
      commandContextActions: testCommandActions(session),
      shutdownHandler: () => { shutdowns += 1; }, onError: error => errors.push(error),
    });
    return { session, manager };
  }

  async function disposeSession() {
    if (!session) return;
    session.abortCompaction();
    await session.abort();
    await commandTask;
    commandTask = undefined;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    session = undefined;
    await waitFor(() => active === 0, "closed fixture responses");
    releases.length = 0;
  }

  phase = "capturing native sequential compaction";
  let current = await createSession(false);
  await current.session.compact();
  const baseline = requests.splice(0);
  assert.equal(baseline.length, 2);
  assert(baseline.every(request => request.summary));
  assert.equal(maximumActive, 1);
  const baselineSummary = current.manager.getBranch().find(entry => entry.type === "compaction")?.summary;
  await disposeSession();

  phase = "checking automatic discovery, reload, and argument handling";
  current = await createSession();
  await current.session.reload();
  await current.session.prompt("/compact-quit unexpected");
  assert(notifications.some(item => item.text === "Usage: /compact-quit"));
  assert.equal(shutdowns, 0);
  assert.equal(requests.length, 0);

  phase = "checking native request parity, duplicate commands, and shutdown ordering";
  holdSummaries = true;
  commandTask = current.session.prompt("/compact-quit");
  await waitFor(() => releases.length === 1, "first native summary");
  await current.session.prompt("/compact-quit");
  assert.equal(requests.length, 1, "A repeated command must not start another compaction");
  assert.equal(shutdowns, 0);
  assert(!current.manager.getBranch().some(entry => entry.type === "compaction"));
  const releaseHistory = releases.shift();
  assert(releaseHistory);
  releaseHistory();
  await waitFor(() => releases.length === 1, "second native summary");
  assert.equal(shutdowns, 0);
  const releasePrefix = releases.shift();
  assert(releasePrefix);
  releasePrefix();
  await commandTask;
  holdSummaries = false;
  assert.equal(shutdowns, 1);
  assert.equal(maximumActive, 1, "Pi must keep its native sequential scheduling");
  assert.deepEqual(requests.splice(0), baseline, "The command must preserve native prompts, model, effort, and output limits");
  const checkpoint = current.manager.getBranch().find(entry => entry.type === "compaction");
  assert(checkpoint && checkpoint.fromHook === false);
  assert.equal(checkpoint.summary, baselineSummary);
  const saved = current.manager.getSessionFile();
  assert(saved);
  assert.equal(sdk.SessionManager.open(saved).getBranch().find(entry => entry.type === "compaction")?.summary, checkpoint.summary);
  assert.equal(current.session.thinkingLevel, "xhigh");
  await current.session.prompt("/compact-quit");
  assert.equal(shutdowns, 2, "An already-compacted session must exit without another summary");
  assert.equal(requests.length, 0);
  await disposeSession();

  phase = "checking empty-session no-op";
  current = await createSession(true, false);
  await current.session.prompt("/compact-quit");
  assert.equal(shutdowns, 1);
  assert.equal(requests.length, 0);
  await disposeSession();

  phase = "checking failure and explicit retry";
  current = await createSession();
  failSummaries = true;
  await current.session.prompt("/compact-quit");
  assert.equal(requests.splice(0).length, 1, "Native history failure must not start the prefix request");
  assert.equal(shutdowns, 0);
  assert(notifications.some(item => item.kind === "warning" && item.text.includes("Pi remains open")));
  assert(!current.manager.getBranch().some(entry => entry.type === "compaction"));
  failSummaries = false;
  await current.session.prompt("/compact-quit");
  assert.equal(shutdowns, 1);
  assert.equal(requests.splice(0).length, 2);
  await disposeSession();

  phase = "checking cancellation keeps Pi open";
  current = await createSession();
  holdSummaries = true;
  commandTask = current.session.prompt("/compact-quit");
  await waitFor(() => releases.length === 1, "cancellable native summary");
  current.session.abortCompaction();
  await commandTask;
  assert.equal(shutdowns, 0);
  assert(notifications.some(item => item.kind === "warning" && item.text.includes("Pi remains open")));
  assert(!current.manager.getBranch().some(entry => entry.type === "compaction"));
  holdSummaries = false;
  requests.length = 0;
  await disposeSession();

  phase = "checking active work finishes before compaction";
  current = await createSession();
  holdOrdinary = true;
  const ordinaryTask = current.session.prompt("Complete the ordinary fixture response.");
  await waitFor(() => releases.length === 1, "ordinary response");
  commandTask = current.session.prompt("/compact-quit");
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  assert.equal(requests.length, 1);
  assert.equal(shutdowns, 0);
  const releaseOrdinary = releases.shift();
  assert(releaseOrdinary);
  releaseOrdinary();
  holdOrdinary = false;
  await ordinaryTask;
  await commandTask;
  assert.equal(current.session.getLastAssistantText(), "Ordinary response fixture.");
  assert.equal(shutdowns, 1);
  assert(requests.slice(1).every(request => request.summary));
  assert.equal(JSON.stringify(settings.getSettings()), originalSettings);
  assert.deepEqual(errors, []);
  assert.equal(networkAttempts, 0);
  await disposeSession();
  passed = true;
  console.log("PASS: automatic discovery; command-only registration; reload; arguments; native sequential prompt/model/effort/limit parity; persistence before shutdown; duplicate commands; empty/already-compacted no-ops; failure/retry; cancellation; active-work completion; no external requests");
} finally {
  clearInterval(heartbeat);
  globalThis.fetch = originalFetch;
  try {
    if (session) {
      session.abortCompaction();
      await session.abort();
      await commandTask;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
    console.log(`CLEANUP: native compaction session and loopback fixtures removed; ${passed ? "SUCCESS" : "FAILED"}`);
  }
}
