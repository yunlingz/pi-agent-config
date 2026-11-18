import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CompactionDetails } from "@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../scripts/live-verification.ts";
import { assertMcpDisabled, validateConfig } from "../../skills/sync-pi-config/scripts/verify.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "CodeAnchor acceptance must retain the configured model");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-live-session-"));
let session: AgentSession | undefined;
let phase = "loading isolated Pi with the configured model";
let settled = 0;
let requests = 0;
let toolCalls = 0;
let timedOut = false;
const observedEventTypes = new Set<string>();
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] CodeAnchor live session: ${phase}; ${requests} regular-request hooks, ${toolCalls} tool calls\n`);
}, 20_000);
try {
  const marker = `CODE_ANCHOR_${randomUUID().replaceAll("-", "")}`;
  const path = join(temporary, "fixture.ts");
  const source = `// ${marker}\nconsole.log("before");\n`;
  await writeFile(path, source);
  assert(settings.defaultProvider && settings.defaultModel);
  // Retain no recent history for this isolated manual-compaction case. Global settings stay unchanged.
  await mkdir(join(temporary, ".pi"));
  await writeFile(join(temporary, ".pi", "settings.json"), JSON.stringify({
    compaction: {
      enabled: false,
      keepRecentTokens: 0,
      modelOverrides: { [`${settings.defaultProvider}/${settings.defaultModel}`]: { keepRecentTokens: 0 } },
    },
  }));
  const events: AgentSessionEvent[] = [];
  const guard: ExtensionFactory = pi => {
    pi.on("tool_call", event => {
      assert(["read", "edit", "write", "ast_grep", "ast_edit"].includes(event.toolName), "Unexpected tool in isolated live verification");
      const inside = (value: string): void => {
        if (value === "xd://resolve" || value === "xd://reject") return;
        assert(!value.startsWith("~") && !value.includes("://"), "Unexpected resource path");
        const local = relative(temporary, resolve(temporary, value.replace(/:raw$/u, "")));
        assert(local !== ".." && !local.startsWith("../") && !local.startsWith("..\\") && !isAbsolute(local), "Live fixture escaped its directory");
      };
      if ("path" in event.input && typeof event.input.path === "string") inside(event.input.path);
      if ("paths" in event.input && Array.isArray(event.input.paths)) {
        for (const value of event.input.paths) { assert.equal(typeof value, "string"); inside(value); }
      }
      if ("input" in event.input && typeof event.input.input === "string") {
        for (const header of event.input.input.matchAll(/^\[([^\]\n]+)#[0-9A-Fa-f]{4}\]/gmu)) {
          const value = header[1];
          assert(value);
          inside(value);
        }
        assert(!/^(?:MV|REM)\b/mu.test(event.input.input), "Live acceptance does not need file moves or deletes");
      }
    });
    pi.on("before_provider_request", () => { requests++; });
  };
  const live = await createLiveSession({
    packageDirectory, agentDirectory, cwd: temporary,
    extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "extension.ts")],
    extensionFactories: [guard],
    includeBuiltinTools: true,
    appendSystemPrompt: [
      "This is CodeAnchor acceptance with temporary fixtures. Only the requested local fixture may change.",
      "Do not browse, invoke skills, run shells, or use MCP. Follow each requested tool workflow exactly.",
    ],
  });
  session = live.session;
  const model = session.model;
  assert(model, "The configured model must be present");
  assert.equal(model.provider, settings.defaultProvider);
  assert.equal(model.id, settings.defaultModel);
  const reasoning = live.settings.getModelThinkingLevel(model.provider, model.id) ?? live.settings.getDefaultThinkingLevel();
  assert.equal(session.thinkingLevel, reasoning);
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
  for (const name of ["read", "edit", "write", "ast_grep", "ast_edit"]) {
    assert(session.getActiveToolNames().includes(name), `Live setup is missing ${name}`);
  }
  session.setActiveToolsByName(["read", "edit", "write", "ast_grep", "ast_edit"]);
  const nativeGuidelines = [live.sdk.createReadToolDefinition(temporary), live.sdk.createEditToolDefinition(temporary), live.sdk.createWriteToolDefinition(temporary)]
    .flatMap(tool => tool.promptGuidelines ?? []);
  const codeAnchorGuidelines = session.getAllTools()
    .filter(tool => ["read", "edit", "write", "ast_grep", "ast_edit"].includes(tool.name))
    .flatMap(tool => tool.promptGuidelines ?? []).filter(rule => !nativeGuidelines.includes(rule));
  assert(codeAnchorGuidelines.length > 0);
  const assertGuidance = (): void => {
    const enabled = live.session.getActiveToolNames().includes("ast_grep");
    for (const guideline of codeAnchorGuidelines) {
      assert.equal(live.session.systemPrompt.includes(guideline), enabled, "CodeAnchor guidance must follow active definitions");
    }
  };
  assertGuidance();
  session.subscribe(event => {
    observedEventTypes.add(event.type);
    if (event.type !== "message_update") events.push(event);
    if (event.type === "agent_settled") settled++;
    if (event.type === "tool_execution_end") toolCalls++;
  });
  const prompt = async (label: string, text: string, required: string[]): Promise<void> => {
    phase = label;
    const offset = events.length;
    const previousSettled = settled;
    const timer = setTimeout(() => { timedOut = true; void session?.abort(); }, 120_000);
    try {
      await live.session.prompt(text);
      await live.session.waitForIdle();
      assert(!timedOut, `${label}: exceeded 120 seconds`);
      const turn = events.slice(offset);
      assert(settled > previousSettled, `${label}: missing settled event`);
      for (const event of turn) {
        if (event.type === "agent_settled") assert.equal(event.aborted, false, label);
        if (event.type === "auto_retry_end") assert.equal(event.success, true, label);
        if (event.type === "tool_execution_end") assert.equal(event.isError, false, `${label}: ${event.toolName} failed; raw result withheld`);
        if (event.type === "message_end" && event.message.role === "assistant") {
          assert.equal(event.message.provider, model.provider, label);
          assert.equal(event.message.model, model.id, label);
          assert(!["error", "aborted", "length", "deferred"].includes(event.message.stopReason), `${label}: assistant did not finish normally`);
        }
      }
      for (const name of required) {
        assert(turn.some(event => event.type === "tool_execution_end" && event.toolName === name), `${label}: missing ${name}`);
      }
      assert.equal(live.session.thinkingLevel, reasoning);
      assert.equal(extensionErrors.length, 0, "Extension error; raw diagnostics withheld");
      assertGuidance();
      console.log(`PASS: live ${label}`);
    } finally { clearTimeout(timer); }
  };
  console.log(`START: live CodeAnchor workflows on ${model.provider}/${model.id}; reasoning ${reasoning}; real requests can incur charges`);
  await prompt("hashline read and edit", "Read fixture.ts, then use hashline edit to change only the string before to after. Preserve the marker comment and file formatting. Do not use write. Reply briefly.", ["read", "edit"]);
  assert.equal(await readFile(path, "utf8"), source.replace('"before"', '"after"'));
  await prompt("structural search and preview", 'Use ast_grep to find console.log($VALUE) in fixture.ts. Then use ast_edit to stage console.log($VALUE) -> logger.info($VALUE). Do not resolve yet. Reply briefly.', ["ast_grep", "ast_edit"]);
  assert.equal(await readFile(path, "utf8"), source.replace('"before"', '"after"'));
  await prompt("preview application", "Apply the pending AST preview by using write with path xd://resolve and a nonempty reason. Do not directly overwrite fixture.ts. Reply briefly.", ["write"]);
  assert.equal(await readFile(path, "utf8"), source.replace('console.log("before")', 'logger.info("after")'));
  await prompt("preview discard", 'Use ast_edit to stage logger.info($VALUE) -> logger.warn($VALUE) in fixture.ts. Then discard the preview by writing a reason to xd://reject. Reply briefly.', ["ast_edit", "write"]);
  assert.equal(await readFile(path, "utf8"), source.replace('console.log("before")', 'logger.info("after")'));
  await live.session.prompt("/code-anchor off");
  assert(!live.session.getActiveToolNames().includes("ast_grep"));
  assert(!live.session.getActiveToolNames().includes("ast_edit"));
  await live.session.reload();
  assert(!live.session.getActiveToolNames().includes("ast_grep"));
  assertGuidance();
  await prompt("built-in tools after off and reload", 'Read fixture.ts, then use the built-in exact-text edit tool to change logger.info("after") to logger.warn("after"). Preserve everything else. Do not use write. Reply briefly.', ["read", "edit"]);
  assert.equal(await readFile(path, "utf8"), source.replace('console.log("before")', 'logger.warn("after")'));
  await live.session.prompt("/code-anchor on");
  assert(live.session.getActiveToolNames().includes("ast_grep"));
  await prompt("raw read after re-enable", "Use read with path fixture.ts:raw. Reply with exactly the marker comment identifier, without // or formatting. Do not modify files.", ["read"]);
  assert.equal(live.session.getLastAssistantText()?.trim(), marker);
  assert.equal(await readFile(path, "utf8"), source.replace('console.log("before")', 'logger.warn("after")'));
  phase = "manual compaction, persisted file metadata, and continuation";
  const compactionTimeout = setTimeout(() => { timedOut = true; live.session.abortCompaction(); }, 120_000);
  try {
    const result = await live.session.compact();
    assert(!timedOut, "Manual compaction exceeded 120 seconds");
    assert(result.summary.includes(marker), "The real summary must retain the fixture marker");
    const checkpoint = live.manager.getBranch().findLast(entry => entry.type === "compaction");
    assert(checkpoint && checkpoint.fromHook !== true, "Pi must persist its real model-generated compaction");
    // Pi produces CompactionDetails for its built-in compaction result.
    const details = checkpoint.details as CompactionDetails;
    const canonical = (await realpath(path)).replaceAll("\\", "/");
    assert(details.modifiedFiles.some(file => file.replaceAll("\\", "/") === canonical), "Compaction must retain canonical CodeAnchor mutations");
    assert(![...details.readFiles, ...details.modifiedFiles].some(file => file.startsWith("xd://") || file.endsWith(":raw")), "Virtual paths and selectors must not become tracked files");
    const sessionFile = live.manager.getSessionFile();
    assert(sessionFile);
    assert.equal(live.sdk.SessionManager.open(sessionFile).getBranch().findLast(entry => entry.type === "compaction")?.summary, checkpoint.summary);
    assert.equal(live.session.thinkingLevel, reasoning);
    assertGuidance();
    console.log("PASS: live manual compaction, canonical file metadata, and persisted summary");
  } finally { clearTimeout(compactionTimeout); }
  await live.session.reload();
  assertGuidance();
  await prompt("hashline continuation after compaction and reload", "Read fixture.ts, then use hashline edit to change logger.warn to logger.error. Preserve the marker and all other bytes. Reply with exactly the marker identifier, without // or formatting.", ["read", "edit"]);
  assert.equal(live.session.getLastAssistantText()?.trim(), marker);
  assert.equal(await readFile(path, "utf8"), source.replace('console.log("before")', 'logger.error("after")'));
  assert.equal(extensionErrors.length, 0);
  console.log(`PASS: seven live workflows plus real compaction; ${requests} regular-request hooks, ${toolCalls} real tool calls; compaction excluded from the request-hook count; configured model and reasoning retained`);
} catch (error) {
  console.error(JSON.stringify({
    phase, requests, toolCalls, settled,
    failure: error instanceof Error ? error.name : "Unknown error",
    activeTools: session?.getActiveToolNames(),
    messages: session?.messages.map(message => ({
      role: message.role,
      stopReason: message.role === "assistant" ? message.stopReason : undefined,
      toolCalls: message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.name) : undefined,
      contentBlocks: "content" in message && Array.isArray(message.content) ? message.content.length : undefined,
    })),
    eventTypes: [...observedEventTypes],
    assertion: error instanceof assert.AssertionError ? error.message : undefined,
    frames: error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /u.test(line)).slice(0, 3) : undefined,
  }));
  throw new Error(`CodeAnchor live session failed during ${phase}; provider diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
  try { if (session) await closeLiveSession(session); }
  finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    console.log("CLEANUP: live session stopped and temporary fixtures removed");
  }
}
