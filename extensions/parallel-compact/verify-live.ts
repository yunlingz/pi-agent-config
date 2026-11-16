import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createExtensionClock, IDLE_INTERVAL_MS, populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import { closeLiveSession, createLiveSession, parseLiveArguments, waitForVerification } from "../../scripts/live-verification.ts";
import { testUI } from "../../scripts/test-fixtures.ts";

const args = parseLiveArguments(process.argv.slice(2));
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? resolve(extensionDirectory, "../..");
const emptyStatus = "in 0 · cr 0 · cw 0 · out 0 · cache --";
let session: AgentSession | undefined;
let phase = "preparing live verification";
let passed = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
const clock = createExtensionClock();
const root = await mkdtemp(join(tmpdir(), "pi-compaction-live-"));
try {
  heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] Live compaction verification: ${phase}\n`);
  }, 20_000);
  for (const trigger of ["idle", "pre-quit"] as const) {
    phase = `loading plugins for ${trigger}`;
    const cwd = join(root, trigger);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 300 }, retry: { enabled: false, provider: { maxRetries: 0 } },
    }));
    const preparations: { split: boolean; history: number; prefix: number }[] = [];
    const host = await createLiveSession({
      ...args, cwd, agentDirectory, load: (operation) => clock.load(operation),
      extensionPaths: [join(extensionDirectory, "index.ts"), join(extensionDirectory, "../auto-compact/index.ts"),
        join(extensionDirectory, "../token-usage/index.ts")],
      extensionFactories: [(pi) => {
        pi.on("session_before_compact", (event) => {
          assert.equal(event.customInstructions, undefined, "Automatic compaction must not add instructions");
          preparations.push({ split: event.preparation.isSplitTurn,
            history: event.preparation.messagesToSummarize.length, prefix: event.preparation.turnPrefixMessages.length });
        });
      }],
    });
    session = host.session;
    const model = session.model;
    assert(model, "Select a default model or pass an exact provider/model override");
    assert.notEqual(model.api, "pi-virtual", "This plugin leaves virtual models native; select a physical model explicitly");
    const selection = `${model.provider}/${model.id}`;
    const thinkingLevel = session.thinkingLevel;
    const markers = populateSplitHistory(host.manager, model, randomUUID().replaceAll("-", ""));
    const requests: { reasoning: string | undefined; response?: AssistantMessage }[] = [];
    const pending = new Set<Promise<void>>();
    const nativeStream = host.runtime.streamSimple.bind(host.runtime);
    let active = 0;
    let maximumActive = 0;
    // Observe the real SDK streams. Do not replace authentication, transport, or provider responses.
    host.runtime.streamSimple = (requestModel, context, options) => {
      assert.equal(`${requestModel.provider}/${requestModel.id}`, selection, "Live verification must not switch models");
      const record: (typeof requests)[number] = { reasoning: options?.reasoning };
      requests.push(record);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const stream = nativeStream(requestModel, context, options);
      const audit = stream.result().then((response) => { record.response = response; }).finally(() => { active -= 1; });
      pending.add(audit);
      void audit.finally(() => pending.delete(audit));
      return stream;
    };
    const statuses = new Map<string, string>();
    const errors: unknown[] = [];
    const notifications: { text: string; kind: string | undefined }[] = [];
    let compactionFinished = false;
    let compactionSucceeded = false;
    let shutdowns = 0;
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionFinished = true;
        compactionSucceeded = !event.aborted && event.result !== undefined;
      }
    });
    await session.bindExtensions({
      mode: "tui",
      uiContext: testUI(session, {
        onTerminalInput: () => () => {},
        notify: (text, kind) => notifications.push({ text, kind }),
        setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      }),
      shutdownHandler: () => {
        assert(host.manager.getBranch().some((entry) => entry.type === "compaction"), "Shutdown must follow checkpoint persistence");
        shutdowns += 1;
      },
      onError: (error) => errors.push(error),
    });
    const activeSession = session;
    timeout = setTimeout(() => { activeSession.abortCompaction(); void activeSession.abort(); }, 120_000);
    phase = `${selection}: ${trigger}, effort ${thinkingLevel}`;
    console.log(`START: ${phase}; real model requests can incur charges`);
    if (trigger === "idle") {
      clock.advance(IDLE_INTERVAL_MS - 1);
      assert.equal(requests.length, 0, "Idle compaction must not start early");
      clock.advance(1);
    } else {
      await session.prompt("/compact-quit");
    }
    await waitForVerification(() => compactionFinished, "automatic compaction", 120_000);
    await session.waitForIdle();
    await Promise.all(pending);
    assert(compactionSucceeded, "The selected provider could not complete automatic compaction; no fallback was attempted");
    assert.equal(preparations.length, 1);
    assert(preparations[0].split && preparations[0].history > 0 && preparations[0].prefix > 0);
    assert.equal(requests.length, 2, "Automatic split compaction must make exactly two real summary calls");
    assert.equal(maximumActive, 2, "The two real SDK summary streams must overlap");
    const expectedReasoning = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined;
    assert(requests.every((request) => request.reasoning === expectedReasoning && request.response?.stopReason === "stop"));
    const checkpoint = host.manager.getBranch().findLast((entry) => entry.type === "compaction");
    assert(checkpoint?.fromHook === true);
    assert(checkpoint.details && typeof checkpoint.details === "object" && "parallelSummaries" in checkpoint.details
      && checkpoint.details.parallelSummaries === true);
    assert.equal(checkpoint.firstKeptEntryId, markers.firstKeptEntryId);
    assert(checkpoint.summary.includes(markers.historyMarker) && checkpoint.summary.includes(markers.prefixMarker),
      "The live summaries must preserve both verification markers");
    const file = host.manager.getSessionFile();
    assert(file);
    assert.equal(host.sdk.SessionManager.open(file).getBranch().findLast((entry) => entry.type === "compaction")?.summary, checkpoint.summary);
    assert.equal(statuses.get("token-usage"), emptyStatus, "Successful automatic compaction must reset token usage");
    if (trigger === "idle") {
      assert.equal(shutdowns, 0);
      phase = `${selection}: continuation and token usage`;
      await session.prompt("Return the earlier verification marker, then |, then the current verification marker. Reply with only those markers and the separator. Do not use tools.");
      await Promise.all(pending);
      assert.equal(session.getLastAssistantText()?.trim(), `${markers.historyMarker}|${markers.prefixMarker}`);
      assert.equal(requests.at(-1)?.response?.stopReason, "stop");
      assert((requests.at(-1)?.response?.usage.totalTokens ?? 0) > 0,
        "The selected provider must report usage to verify the token-usage display");
      assert.notEqual(statuses.get("token-usage"), emptyStatus);
      assert(statuses.get("token-usage")?.startsWith("in "));
    } else {
      await waitForVerification(() => shutdowns === 1, "shutdown after compaction");
    }
    assert.equal(session.thinkingLevel, thinkingLevel);
    assert.equal(errors.length, 0, "No extension may report an error");
    assert(!notifications.some((item) => item.kind === "error" || item.kind === "warning"));
    console.log(`PASS: ${selection}; ${trigger}; two overlapping real streams, unchanged effort, persisted parallel checkpoint, token reset${trigger === "idle" ? ", exact continuation and reported usage" : ", shutdown after persistence"}`);
    clearTimeout(timeout);
    await closeLiveSession(session);
    session = undefined;
  }
  passed = true;
} finally {
  clearInterval(heartbeat);
  clearTimeout(timeout);
  try {
    if (session) await closeLiveSession(session);
  } finally {
    clock.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(existsSync(root), false);
    process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: live compaction verification; temporary state removed\n`);
  }
}
