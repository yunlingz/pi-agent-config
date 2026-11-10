import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent, SessionHeader } from "@earendil-works/pi-coding-agent";
import { parseTrustedJson } from "../../scripts/verification-data.ts";
import type { SearchDetails } from "./types.ts";
import type { VerificationAudit } from "./verification-fixtures.ts";

const [packageArgument, modelId] = process.argv.slice(2);
const levels: Record<string, string> = { "gpt-6-astra": "medium", "gpt-6.1-sol": "xhigh", "gpt-6.1-terra": "max" };
assert.ok(packageArgument && modelId && levels[modelId], "Usage: node verify-live.ts <installed-pi-package-directory> <model-id>");
const packageDirectory = resolve(packageArgument);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const agentDirectory = resolve(extensionDirectory, "../..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-web-search-live-"));
const observerPath = join(temporaryDirectory, "observer.ts");
const auditPath = join(temporaryDirectory, "audit.jsonl");
const marker = "WEB_SEARCH_FOLLOW_UP_OK";
let child: ChildProcess | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let passed = false;
let timedOut = false;
let eventBuffer = "";
let errorBytes = 0;
let invalidRecords = 0;
const messages: AgentMessage[] = [];

try {
  await writeFile(join(temporaryDirectory, "marker.txt"), `${marker}\n`);
  await mkdir(join(temporaryDirectory, ".pi"));
  await writeFile(join(temporaryDirectory, ".pi/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(observerPath, `import { createObserver } from ${JSON.stringify(pathToFileURL(join(extensionDirectory, "verify-observer.ts")).href)};
export default createObserver(${JSON.stringify(auditPath)});
`);
  const args = [
    join(packageDirectory, "dist/cli.js"), "--no-mcp", "--no-extensions",
    "--extension", join(extensionDirectory, "index.ts"), "--extension", observerPath,
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
    "--offline", "--approve", "--no-session", "--mode", "json", "--tools", "read,web_run",
    "--provider", "existing_gateway", "--model", modelId, "--thinking", levels[modelId],
    "--system-prompt", "You are testing independent web search and local read compatibility. Follow the user's requests exactly. Keep answers brief.",
    "Transform this supplied text to uppercase: stable_test_ok. Reply with only the transformed text.",
    "Use web_run to search the official Node.js website. What is Node.js? Return one sentence and a source citation. Do not use read for this answer.",
    "/web-search off",
    "Do not search. Read marker.txt with read. Return its exact marker and one source URL from your previous answer. Do not change files.",
  ];
  console.log(`START: ${modelId}; no-search task, independent search, off control, and read follow-up; 240-second limit`);
  const processChild = spawn(process.execPath, args, {
    cwd: temporaryDirectory, shell: false, windowsHide: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = processChild;
  processChild.stdout.setEncoding("utf8");
  processChild.stdout.on("data", (chunk: string) => {
    eventBuffer += chunk;
    let newline: number;
    while ((newline = eventBuffer.indexOf("\n")) >= 0) {
      const line = eventBuffer.slice(0, newline);
      eventBuffer = eventBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = parseTrustedJson<JsonAgentSessionEvent | SessionHeader>(line);
        if (event.type === "message_end") messages.push(event.message);
        if (event.type === "tool_execution_end") console.log(`PROGRESS: ${modelId}; ${event.toolName} ${event.isError ? "failed" : "finished"}`);
      } catch {
        invalidRecords++;
      }
    }
  });
  processChild.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.length; });
  heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] ${modelId}: waiting for Pi; ${messages.length} completed messages\n`);
  }, 20_000);
  timeout = setTimeout(() => { timedOut = true; child?.kill(); }, 240_000);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    processChild.once("error", reject);
    processChild.once("close", resolveExit);
  });
  assert.equal(timedOut, false, "Live verification exceeded 240 seconds");
  assert.equal(code, 0, `Pi exited with code ${code}; raw provider diagnostics withheld`);
  assert.equal(errorBytes, 0, "Pi emitted startup or extension diagnostics; review privately");
  assert.equal(invalidRecords, 0);
  assert.equal(eventBuffer.trim(), "");
  // createObserver writes this discriminated audit format to the task-owned file.
  const records = (await readFile(auditPath, "utf8")).trim().split("\n").map(parseTrustedJson<VerificationAudit>);
  const audit = records.filter((item) => item.type === "main");
  const searchRequests = records.filter((item) => item.type === "search");
  assert.equal(searchRequests.length, 2, "Require one search token check and one generation request");
  assert.deepEqual(searchRequests.map((item) => item.count), [true, false]);
  for (const request of searchRequests) {
    assert.equal(request.model, modelId);
    assert.deepEqual(request.reasoning, { effort: "low" });
    assert.deepEqual(request.configurationUpdates, []);
  }
  assert.ok(audit.length >= 5, "Require the stable answer, research call/follow-up, and read call/follow-up");
  for (const request of audit) {
    assert.equal(request.model, modelId);
    assert.equal(request.effort, levels[modelId]);
    assert.ok(!request.toolTypes?.some((type) => ["web_search", "web_search_preview"].includes(type)), "Main requests must not declare hosted search");
    assert.notEqual(request.toolChoice, "required");
  }
  assert.ok(audit[0].names?.includes("web_run"));
  const lastAudit = audit.at(-1);
  assert.ok(lastAudit?.names);
  assert.ok(!lastAudit.names.includes("web_run"), "Off removes the main tool declaration");
  const assistants = messages.filter((message): message is AssistantMessage => message.role === "assistant");
  assert.equal(assistants[0].content.filter((block) => block.type === "text").map((block) => block.text).join("").trim(), "STABLE_TEST_OK");
  assert.ok(!assistants[0].content.some((block) => block.type === "toolCall"), "The supplied-text task must not search");
  for (const message of assistants) {
    assert.ok(!["error", "aborted", "length"].includes(message.stopReason), `A main request did not complete: ${message.stopReason}; diagnostics withheld`);
  }
  // The only web_run implementation in this isolated session writes SearchDetails to its tool results.
  const searches = messages.filter((message): message is ToolResultMessage<SearchDetails> => message.role === "toolResult" && message.toolName === "web_run");
  assert.equal(searches.length, 1, "One deliberate search call is sufficient");
  const search = searches[0];
  assert.equal(search.isError, false, search.details?.error ?? "Independent search failed");
  assert.equal(search.details?.model, modelId);
  assert.equal(search.details?.thinkingLevel, "low");
  assert.ok(search.details?.inputTokens !== undefined && search.details.inputTokens <= 64000);
  assert.equal(search.details.outputLimit, 32000);
  assert.ok(search.details.searchCount !== undefined && search.details.searchCount > 0);
  assert.ok(search.details.sources.length > 0);
  assert.ok(search.usage && search.usage.totalTokens > 0, "Independent usage reaches the tool result");
  assert.ok(typeof search.usage.reasoning === "number" && search.usage.reasoning >= 0, "The provider must report search reasoning usage");
  const sourceText = search.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.ok(search.details.sources.some((source) => sourceText.includes(`](<${source.url}>)`)), "Tool result must include a usable citation link");
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError));
  const finalAssistant = assistants.at(-1);
  assert.ok(finalAssistant);
  const finalText = finalAssistant.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(finalText, new RegExp(marker));
  assert.match(finalText, /https?:\/\//u);
  passed = true;
  console.log(`PASS: ${modelId}; main effort ${levels[modelId]}, search effort low, ${search.usage.reasoning} reasoning tokens, ${(search.details.elapsedMs / 1000).toFixed(1)}s search, ${search.details.inputTokens} counted input tokens, ${search.details.sources.length} sources; no-search task and off control passed`);
} finally {
  clearInterval(heartbeat);
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
  process.stderr.write(`${passed ? "SUCCESS" : "FAILED"}: ${modelId}; temporary files removed\n`);
}
