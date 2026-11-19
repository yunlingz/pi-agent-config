import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { populateSplitHistory } from "../../scripts/compaction-fixtures.ts";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { testCommandActions, testUI } from "../../scripts/test-fixtures.ts";

const args = parseLiveArguments(process.argv.slice(2));
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? resolve(extensionDirectory, "../..");
const emptyStatus = "in 0 · cr 0 · cw 0 · out 0 · cache --";
const root = await mkdtemp(join(tmpdir(), "pi-compact-quit-live-"));
let session: AgentSession | undefined;
let phase = "loading configured model";
let passed = false;
let timeout: ReturnType<typeof setTimeout> | undefined;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Live compact-quit verification: ${phase}\n`);
}, 20_000);
try {
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi/settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 300 }, retry: { enabled: false, provider: { maxRetries: 0 } },
  }));
  const preparations: { split: boolean; history: number; prefix: number }[] = [];
  const host = await createLiveSession({
    ...args, cwd: root, agentDirectory,
    extensionPaths: [join(extensionDirectory, "index.ts"), join(extensionDirectory, "../token-usage/index.ts")],
    extensionFactories: [pi => {
      pi.on("session_before_compact", event => {
        assert.equal(event.customInstructions, undefined);
        preparations.push({ split: event.preparation.isSplitTurn,
          history: event.preparation.messagesToSummarize.length, prefix: event.preparation.turnPrefixMessages.length });
      });
    }],
  });
  session = host.session;
  const model = session.model;
  assert(model, "Select a configured default model or pass an exact provider/model override");
  const selection = `${model.provider}/${model.id}`;
  const thinkingLevel = session.thinkingLevel;
  const markers = populateSplitHistory(host.manager, model, randomUUID().replaceAll("-", ""));
  const statuses = new Map<string, string>();
  const errors: unknown[] = [];
  const notifications: string[] = [];
  let shutdowns = 0;
  const ui = (activeSession: AgentSession) => testUI(activeSession, {
    notify: (_text, kind) => { if (kind === "error" || kind === "warning") notifications.push(kind); },
    setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
  });
  await session.bindExtensions({
    mode: "tui", uiContext: ui(session), commandContextActions: testCommandActions(session),
    shutdownHandler: () => {
      assert(host.manager.getBranch().some(entry => entry.type === "compaction"), "Checkpoint persistence must precede shutdown");
      shutdowns += 1;
    },
    onError: error => errors.push(error),
  });
  const activeSession = session;
  timeout = setTimeout(() => { activeSession.abortCompaction(); void activeSession.abort(); }, 120_000);
  phase = `${selection}: native compact-quit, effort ${thinkingLevel}`;
  console.log(`START: ${phase}; real model requests can incur charges`);
  await session.prompt("/compact-quit");
  await session.waitForIdle();
  assert.equal(shutdowns, 1, "Native compaction must complete before shutdown");
  assert.equal(preparations.length, 1);
  assert(preparations[0].split && preparations[0].history > 0 && preparations[0].prefix > 0);
  const checkpoint = host.manager.getBranch().findLast(entry => entry.type === "compaction");
  assert(checkpoint && checkpoint.fromHook === false, "Pi must create a native checkpoint");
  assert((checkpoint.usage?.totalTokens ?? 0) > 0, "The configured provider must report summary usage");
  assert.equal(checkpoint.firstKeptEntryId, markers.firstKeptEntryId);
  assert(checkpoint.summary.includes(markers.historyMarker) && checkpoint.summary.includes(markers.prefixMarker));
  assert.equal(statuses.get("token-usage"), emptyStatus);
  const file = host.manager.getSessionFile();
  assert(file);
  assert.equal(host.sdk.SessionManager.open(file).getBranch().findLast(entry => entry.type === "compaction")?.summary, checkpoint.summary);
  assert.equal(session.thinkingLevel, thinkingLevel);
  clearTimeout(timeout);
  await closeLiveSession(session);
  session = undefined;

  phase = `${selection}: resume and continuation`;
  await host.loader.reload();
  ({ session } = await host.sdk.createAgentSession({
    cwd: root, agentDir: agentDirectory, modelRuntime: host.runtime, model, thinkingLevel,
    settingsManager: host.settings, resourceLoader: host.loader,
    sessionManager: host.sdk.SessionManager.open(file), tools: [],
  }));
  await session.bindExtensions({
    mode: "tui", uiContext: ui(session), commandContextActions: testCommandActions(session),
    onError: error => errors.push(error),
  });
  assert.equal(statuses.get("token-usage"), emptyStatus);
  const resumedSession = session;
  timeout = setTimeout(() => { void resumedSession.abort(); }, 90_000);
  await session.prompt("Return the earlier verification marker, then |, then the current verification marker. Reply with only those markers and the separator. Do not use tools.");
  assert.equal(session.getLastAssistantText()?.trim(), `${markers.historyMarker}|${markers.prefixMarker}`);
  assert.notEqual(statuses.get("token-usage"), emptyStatus);
  assert.equal(`${session.model?.provider}/${session.model?.id}`, selection);
  assert.equal(session.thinkingLevel, thinkingLevel);
  assert.deepEqual(errors, []);
  assert.deepEqual(notifications, []);
  passed = true;
  console.log(`PASS: ${selection}; native checkpoint, unchanged effort, token reset, persistence before shutdown, reopened session, and exact continuation`);
} catch {
  throw new Error(`Live compact-quit verification failed during ${phase}; provider diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
  clearTimeout(timeout);
  try {
    if (session) await closeLiveSession(session);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
    console.log(`CLEANUP: live compact-quit session and fixtures removed; ${passed ? "SUCCESS" : "FAILED"}`);
  }
}
