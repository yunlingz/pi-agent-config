import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { testUI } from "../../scripts/test-fixtures.ts";

const packageArgument = process.argv[2];
assert(packageArgument, "Usage: node verify.ts <installed-pi-package-directory>");
const packagePath = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
let session: AgentSession | undefined;
let succeeded = false;
let phase = "loading installed Pi";
let heartbeat: NodeJS.Timeout | undefined;
const root = mkdtempSync(join(tmpdir(), "pi-parallel-compact-verify-"));
try {
  heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] Parallel compaction verification: ${phase}\n`);
  }, 20_000);
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packagePath, "dist/index.js")).href);
  const require = createRequire(pathToFileURL(join(packagePath, "package.json")));
  const aiPath = join(packagePath, "node_modules/@earendil-works/pi-ai/dist/index.js");
  const compatPath = join(packagePath, "node_modules/@earendil-works/pi-ai/dist/compat.js");
  const ai: typeof import("@earendil-works/pi-ai") = await import(pathToFileURL(aiPath).href);
  const jitiModule: typeof import("jiti") = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = jitiModule.createJiti(import.meta.url, {
    alias: {
      "@earendil-works/pi-coding-agent": join(packagePath, "dist/index.js"),
      "@earendil-works/pi-ai/compat": compatPath,
      "@earendil-works/pi-ai": aiPath,
    },
  });
  const extension = await jiti.import<typeof import("./index.ts")>(join(extensionDirectory, "index.ts"));
  type Preparation = Parameters<typeof sdk.compact>[0];
  type Stream = NonNullable<Parameters<typeof sdk.compact>[7]>;
  type Kind = "history" | "prefix";
  const model = {
    id: "parallel-compaction-fixture", name: "Parallel compaction fixture", provider: "fixture",
    api: "openai-responses", baseUrl: "http://127.0.0.1:1", reasoning: true,
    input: ["text"], contextWindow: 128000, maxTokens: 32768,
    thinkingLevelMap: { xhigh: "xhigh" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } satisfies NonNullable<ExtensionContext["model"]>;
  const preparation: Preparation = {
    firstKeptEntryId: "kept", tokensBefore: 12000, isSplitTurn: true,
    messagesToSummarize: [{ role: "user", content: "History marker: preserve the earlier decision.", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "Prefix marker: continue the unfinished task.", timestamp: 2 }],
    previousSummary: "Previous summary marker.",
    fileOps: { read: new Set(["old.ts"]), written: new Set(["created.ts"]), edited: new Set(["edited.ts"]) },
    settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 300 },
  };

  interface Capture {
    kind: Kind;
    input: string;
    reasoning: string | undefined;
    cacheRetention: string | undefined;
  }

  function controlledStream({ retryKind, lengthKind, hold = false }: {
    retryKind?: Kind; lengthKind?: Kind; hold?: boolean;
  } = {}) {
    const captures: Capture[] = [];
    let active = 0;
    let maximumActive = 0;
    let aborted = 0;
    const attempts = { history: 0, prefix: 0 };
    const stream: Stream = (requestModel, context, options) => {
      const messages = context.messages.map((message) => ({ role: message.role, content: message.content }));
      const input = JSON.stringify(messages);
      const kind: Kind = input.includes("# Conversation\\n") ? "prefix" : "history";
      captures.push({ kind, input, reasoning: options?.reasoning, cacheRetention: options?.cacheRetention });
      attempts[kind] += 1;
      const attempt = attempts[kind];
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const output = ai.createAssistantMessageEventStream();
      const usage: Usage = {
        input: kind === "history" ? 11 : 13, output: kind === "history" ? 5 : 7,
        cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, reasoning: kind === "history" ? 1 : 2,
        totalTokens: kind === "history" ? 21 : 25,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.10 },
      };
      let finished = false;
      const finish = (cancelled = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        active -= 1;
        if (cancelled) aborted += 1;
        const transient = retryKind === kind && attempt === 1;
        const response: AssistantMessage = {
          role: "assistant", api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
          content: cancelled || transient ? [] : [{ type: "text", text: `${kind} summary fixture` }],
          stopReason: cancelled ? "aborted" : transient ? "error" : lengthKind === kind ? "length" : "stop",
          errorMessage: transient ? "The service is temporarily unavailable" : undefined,
          timestamp: Date.now(), usage,
        };
        output.end(response);
      };
      const cancel = () => finish(true);
      const timer = setTimeout(() => finish(), hold ? 100000 : 10);
      if (options?.signal?.aborted) {
        cancel();
      } else {
        options?.signal?.addEventListener("abort", cancel, { once: true });
      }
      return output;
    };
    return { stream, captures, attempts, get active() { return active; }, get maximumActive() { return maximumActive; }, get aborted() { return aborted; } };
  }

  phase = "comparing native and parallel requests/results";
  const serial = controlledStream();
  const baseline = await sdk.compact(structuredClone(preparation), model, undefined, undefined,
    "Preserve exact paths.", undefined, "xhigh", serial.stream);
  assert.equal(serial.maximumActive, 1);
  const parallel = controlledStream();
  const result = await extension.compactInParallel(structuredClone(preparation), model, undefined, undefined,
    "Preserve exact paths.", undefined, "xhigh", parallel.stream);
  assert.equal(parallel.maximumActive, 2);
  assert.equal(parallel.captures.length, 2, "Prefetch must not add provider requests");
  assert.deepEqual(result, baseline, "Native merge, metadata, and all usage splits must match");
  for (const kind of ["history", "prefix"] as const) {
    assert.equal(parallel.captures.find((capture) => capture.kind === kind)?.input,
      serial.captures.find((capture) => capture.kind === kind)?.input);
  }
  assert(parallel.captures.every((capture) => capture.reasoning === "xhigh" && capture.cacheRetention === "none"));
  assert.equal(result.usage?.reasoning, 3);
  assert.equal(result.usage?.cacheWrite1h, 2);

  phase = "checking history and prefix retries";
  for (const retryKind of ["history", "prefix"] as const) {
    const retried = controlledStream({ retryKind });
    const recovered = await extension.compactInParallel(structuredClone(preparation), model, undefined, undefined,
      undefined, undefined, "xhigh", retried.stream, undefined,
      { enabled: true, maxRetries: 1, baseDelayMs: 1 });
    assert.equal(retried.attempts[retryKind], 2);
    assert.equal(retried.captures.length, 3);
    assert.equal(recovered.summary, baseline.summary);
    assert.equal(retried.active, 0);
  }

  phase = "checking one-summary paths";
  for (const change of [{ isSplitTurn: false }, { messagesToSummarize: [] }, { turnPrefixMessages: [] }]) {
    const selected = { ...structuredClone(preparation), ...change };
    const expected = controlledStream();
    const actual = controlledStream();
    const original = await sdk.compact(selected, model, undefined, undefined, undefined, undefined, "xhigh", expected.stream);
    const unchanged = await extension.compactInParallel(selected, model, undefined, undefined, undefined, undefined, "xhigh", actual.stream);
    assert.deepEqual(unchanged, original);
    assert.equal(actual.captures.length, 1);
  }

  phase = "checking failures and cancellation";
  const failing = controlledStream({ lengthKind: "history", hold: false });
  await assert.rejects(() => extension.compactInParallel(structuredClone(preparation), model, undefined, undefined,
    undefined, undefined, "xhigh", failing.stream), /generation hit the token cap/u);
  assert.equal(failing.active, 0);
  const cancelled = controlledStream({ hold: true });
  const cancellation = new AbortController();
  const cancelledTask = extension.compactInParallel(structuredClone(preparation), model, undefined, undefined,
    undefined, cancellation.signal, "xhigh", cancelled.stream);
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  cancellation.abort();
  await assert.rejects(() => cancelledTask, /abort/iu);
  assert.equal(cancelled.aborted, 2);
  assert.equal(cancelled.active, 0);
  const alreadyCancelled = controlledStream();
  await assert.rejects(() => extension.compactInParallel(structuredClone(preparation), model, undefined, undefined,
    undefined, cancellation.signal, "xhigh", alreadyCancelled.stream), /abort/iu);
  assert.equal(alreadyCancelled.captures.length, 0);

  phase = "loading the actual extension with installed Pi";
  const errors: unknown[] = [];
  const notifications: string[] = [];
  let shutdowns = 0;
  let provider = controlledStream();
  const settings = sdk.SettingsManager.inMemory({
    extensions: ["-builtin:mcp"], packages: [], cacheWarming: "off",
    compaction: { keepRecentTokens: 300, reserveTokens: 1000 },
    retry: { enabled: false },
  });
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.streamSimple = (requestModel, context, options) => {
    const output = provider.stream(requestModel, ai.normalizeContext(context), options);
    assert(!(output instanceof Promise));
    return output;
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    additionalExtensionPaths: [join(extensionDirectory, "index.ts"), join(extensionDirectory, "../auto-compact/index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 2);

  const zeroUsage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  function populate(manager: ReturnType<typeof sdk.SessionManager.create>) {
    manager.appendMessage({ role: "user", content: "Earlier task: preserve old.ts.", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
      content: [{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "old.ts" } }],
      usage: zeroUsage,
    });
    manager.appendMessage({ role: "toolResult", toolCallId: "read-old", toolName: "read", isError: false, content: [{ type: "text", text: "Older file contents." }], timestamp: 3 });
    manager.appendMessage({ role: "user", content: "Continue the current task.", timestamp: 4 });
    manager.appendMessage({
      role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 5,
      content: [{ type: "toolCall", id: "read-prefix", name: "read", arguments: { path: "prefix.ts" } }],
      usage: zeroUsage,
    });
    manager.appendMessage({ role: "toolResult", toolCallId: "read-prefix", toolName: "read", isError: false, content: [{ type: "text", text: "Prefix file contents.".repeat(100) }], timestamp: 6 });
    manager.appendMessage({
      role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 7,
      content: [{ type: "text", text: "Recent retained work. ".repeat(100) }],
      usage: zeroUsage,
    });
  }

  async function createSession() {
    const manager = sdk.SessionManager.create(root, join(root, "sessions"));
    populate(manager);
    const created = await sdk.createAgentSession({
      cwd: root, agentDir: root, model, thinkingLevel: "xhigh", modelRuntime: runtime,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [],
    });
    session = created.session;
    session.agent.streamFunction = (requestModel, context, options) => provider.stream(requestModel, context, options);
    await session.bindExtensions({
      mode: "tui", uiContext: testUI(session, { notify: (text) => notifications.push(text), onTerminalInput: () => () => {} }),
      shutdownHandler: () => { shutdowns += 1; }, onError: (error) => errors.push(error),
    });
    return { manager, session };
  }

  async function disposeSession() {
    if (session) {
      session.abortCompaction();
      await session.waitForIdle();
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
    }
  }

  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert(Date.now() < deadline, "Timed out waiting for the fixture outcome");
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }

  phase = "checking checkpoint persistence and repeated file tracking";
  let current = await createSession();
  const first = await current.session.compact("Preserve exact paths.");
  assert.equal(provider.maximumActive, 2);
  assert.equal(provider.captures.length, 2);
  assert.equal(current.session.thinkingLevel, "xhigh");
  const firstEntry = current.manager.getLeafEntry();
  assert(firstEntry?.type === "compaction");
  assert.equal(firstEntry.fromHook, true);
  assert(firstEntry.summary.includes("old.ts"));
  assert(firstEntry.summary.includes("prefix.ts"));
  assert.equal(first.firstKeptEntryId, firstEntry.firstKeptEntryId);
  const file = current.manager.getSessionFile();
  assert(file);
  assert.equal(sdk.SessionManager.open(file).getLeafEntry()?.type, "compaction");
  current.manager.appendMessage({ role: "user", content: "New independent request. ".repeat(200), timestamp: Date.now() });
  current.manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    content: [{ type: "text", text: "New request completed." }],
    usage: zeroUsage,
  });
  provider = controlledStream();
  const second = await current.session.compact();
  assert.equal(provider.captures.length, 1, "Non-split compaction must remain native");
  assert(second.summary.includes("old.ts"));
  assert(second.summary.includes("prefix.ts"));
  const secondEntry = current.manager.getLeafEntry();
  assert(secondEntry?.type === "compaction");
  assert.equal(secondEntry.fromHook, false, "Non-split compaction must not be replaced");
  await disposeSession();

  phase = "checking successful pre-quit compaction";
  provider = controlledStream();
  current = await createSession();
  await current.session.prompt("/compact-quit");
  await waitFor(() => shutdowns === 1);
  assert.equal(provider.maximumActive, 2);
  assert.equal(current.manager.getLeafEntry()?.type, "compaction");
  await disposeSession();

  phase = "checking failed pre-quit compaction";
  notifications.length = 0;
  provider = controlledStream({ lengthKind: "history" });
  current = await createSession();
  await current.session.prompt("/compact-quit");
  await waitFor(() => notifications.some((text) => text.includes("Pi remains open")));
  assert.equal(shutdowns, 1, "Failed compaction must not quit");
  assert.equal(current.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.equal(provider.active, 0);
  await disposeSession();

  phase = "checking cancellation before quit";
  notifications.length = 0;
  provider = controlledStream({ hold: true });
  current = await createSession();
  await current.session.prompt("/compact-quit");
  await waitFor(() => provider.active === 2);
  current.session.abortCompaction();
  await waitFor(() => notifications.some((text) => text.includes("Pi remains open")));
  assert.equal(shutdowns, 1);
  assert.equal(provider.aborted, 2);
  assert.equal(provider.active, 0);
  assert.equal(current.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  await disposeSession();
  assert.deepEqual(errors, []);
  succeeded = true;
  process.stdout.write("PASS: native prompt/result parity; exactly two concurrent requests; optional usage totals; history/prefix retries; one-summary paths; cancellation; checkpoint persistence; repeated file tracking; successful/failed/cancelled pre-quit flow.\n");
} finally {
  clearInterval(heartbeat);
  try {
    if (session) {
      session.abortCompaction();
      await session.waitForIdle();
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
    process.stderr.write(`[${new Date().toISOString()}] Temporary verification state removed; ${succeeded ? "SUCCESS" : "FAILED"}\n`);
  }
}
