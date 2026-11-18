import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { closeLiveSession, createLiveSession, parseLiveArguments } from "../../../scripts/live-verification.ts";
import { assertMcpDisabled, validateConfig } from "../../../skills/sync-pi-config/scripts/verify.ts";

const { packageDirectory, modelOverride } = parseLiveArguments(process.argv.slice(2));
assert.equal(modelOverride, undefined, "Tool-selection verification must retain the configured model");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-tool-selection-"));
let session: AgentSession | undefined;
let phase = "preparing synthetic fixtures";
let requests = 0;
let toolCalls = 0;
const toolOutcomes: { phase: string; tool: string; failed: boolean }[] = [];
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Tool selection: ${phase}; ${requests} requests, ${toolCalls} tool calls\n`);
}, 20_000);
try {
  const fixtures = new Map([
    ["src/alpha.ts", 'export function persistFirst() {\n  cache.write("first", { value: 1 });\n}\n'],
    ["src/beta.ts", 'export function persistSecond() {\n  cache.write(\n    "second",\n    { value: 2 },\n  );\n}\n'],
    ["src/examples.ts", '// cache.write("comment", {});\nexport const example = \'cache.write("string", {})\';\n'],
    ["events.log", "STARTED\nDOCGEN_READY\nFINISHED\n"],
    ["styles/theme.scss", "$accent: blue;\n.panel { color: $accent; }\n"],
    ["notes.md", "# Status\n\n## Archived\nDraft\n\n## Pending\nDraft\n"],
  ]);
  await mkdir(join(temporary, "src"));
  await mkdir(join(temporary, "styles"));
  for (const [path, content] of fixtures) {
    await writeFile(join(temporary, path), content);
  }
  const live = await createLiveSession({
    packageDirectory,
    agentDirectory,
    cwd: temporary,
    extensionPaths: [join(agentDirectory, "extensions", "code-anchor", "index.ts")],
    includeBuiltinTools: true,
    appendSystemPrompt: [
      "This verification uses synthetic fixtures. Only files explicitly requested by each task may change.",
      "Do not browse or use MCP. Files outside this temporary workspace are outside the task scope.",
    ],
    extensionFactories: [pi => {
      pi.on("before_provider_request", () => { requests++; });
    }],
  });
  session = live.session;
  const model = session.model;
  assert(model);
  assert.equal(model.provider, settings.defaultProvider);
  assert.equal(model.id, settings.defaultModel);
  const reasoning = live.settings.getModelThinkingLevel(model.provider, model.id) ?? live.settings.getDefaultThinkingLevel();
  assert.equal(session.thinkingLevel, reasoning);
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
  assert(!session.systemPrompt.includes("## Inspect code and choose tools"), "Natural selection must not depend on global tool procedures");
  const builtinNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  for (const name of [...builtinNames, "ast_grep", "ast_edit"]) {
    assert(session.getActiveToolNames().includes(name), `Missing tool-selection candidate: ${name}`);
  }
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => {
    if (event.type !== "message_update") events.push(event);
    if (event.type === "tool_execution_end") {
      toolCalls++;
      toolOutcomes.push({ phase, tool: event.toolName, failed: event.isError });
    }
  });
  const runCase = async (label: string, prompt: string, requiredTools: string[]): Promise<string> => {
    phase = label;
    const offset = events.length;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void live.session.abort();
    }, 120_000);
    try {
      await live.session.prompt(prompt);
      await live.session.waitForIdle();
      assert(!timedOut, `${label}: exceeded 120 seconds`);
      const turn = events.slice(offset);
      assert(turn.some(event => event.type === "agent_settled" && !event.aborted), `${label}: did not settle normally`);
      for (const event of turn) {
        if (event.type !== "message_end" || event.message.role !== "assistant") continue;
        assert.equal(event.message.provider, model.provider);
        assert.equal(event.message.model, model.id);
        assert(!["error", "aborted", "length", "deferred"].includes(event.message.stopReason), `${label}: assistant failed`);
      }
      for (const name of requiredTools) {
        assert(turn.some(event => event.type === "tool_execution_end" && event.toolName === name && !event.isError), `${label}: missing successful ${name}`);
      }
      assert.equal(extensionErrors.length, 0, "Extension error; raw diagnostics withheld");
      assert.equal(live.session.thinkingLevel, reasoning);
      const used = turn.filter(event => event.type === "tool_execution_end").map(event => event.toolName);
      console.log(`PASS: natural ${label}; selected ${used.join(", ")}`);
      return live.session.getLastAssistantText() ?? "";
    } finally {
      clearTimeout(timeout);
    }
  };
  const checkFixtures = async (): Promise<void> => {
    for (const [path, expected] of fixtures) {
      assert.equal(await readFile(join(temporary, path), "utf8"), expected, `Unexpected fixture change: ${path}`);
    }
  };

  console.log(`START: natural tool selection on ${model.provider}/${model.id}; reasoning ${reasoning}; real requests can incur charges`);
  await runCase("file discovery", "List the immediate entries in src, then locate every .ts file below src. Do not read contents or change files.", ["ls", "find"]);
  const trace = await runCase("structural exploration", "Locate every actual cache.write(...) call under src. Report each enclosing function and its arguments. Ignore comments and string examples. Do not change files.", ["ast_grep", "read"]);
  assert(trace.includes("persistFirst") && trace.includes("persistSecond"), "The explanation must identify both actual callers");
  await runCase("literal search", "Find the literal DOCGEN_READY in events.log and report its line number. Do not change files.", ["grep"]);
  await runCase("unsupported syntax search", "Find every $accent reference in styles/theme.scss and report its line number. Do not change files.", ["grep"]);
  await checkFixtures();

  await runCase("structural rewrite", "Replace every actual cache.write call under src with cache.save. Preserve arguments, comments, string examples, and all other content.", ["ast_edit", "write"]);
  for (const path of ["src/alpha.ts", "src/beta.ts"]) {
    const before = fixtures.get(path);
    assert(before);
    fixtures.set(path, before.replace("cache.write", "cache.save"));
  }
  await checkFixtures();
  await runCase("context-specific edit", "In notes.md, change Draft to Ready only under the Pending heading. Preserve the Archived section and all other content.", ["read", "edit"]);
  fixtures.set("notes.md", "# Status\n\n## Archived\nDraft\n\n## Pending\nReady\n");
  await checkFixtures();

  await session.prompt("/code-anchor off");
  assert(!session.getActiveToolNames().includes("ast_grep"));
  assert(!session.getActiveToolNames().includes("ast_edit"));
  for (const name of builtinNames) {
    assert(session.getActiveToolNames().includes(name), `Disabling CodeAnchor removed ${name}`);
  }
  const fallback = await runCase("disabled structural fallback", "Find every actual cache.save(...) call under src and report its filename and arguments. Do not change files.", []);
  // When AST tools are off, native search or inspection can satisfy this small, previously inspected scope.
  assert(toolOutcomes.some(outcome => outcome.phase === phase && !outcome.failed && ["grep", "read"].includes(outcome.tool)),
    "Disabled fallback must use native search or inspection");
  for (const marker of ["alpha.ts", "beta.ts", "first", "second"]) assert(fallback.includes(marker), `Disabled fallback omitted ${marker}`);
  assert.match(fallback, /value\W+1/u);
  assert.match(fallback, /value\W+2/u);
  await checkFixtures();
  console.log("PASS: seven natural tasks; no task prompt named tools; all selected built-ins remained available; configured model and reasoning retained");
} catch (error) {
  console.error(JSON.stringify({
    phase,
    requests,
    toolCalls,
    tools: toolOutcomes.filter(outcome => outcome.phase === phase),
    failure: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "Unknown error",
  }));
  throw new Error(`Tool-selection verification failed during ${phase}; provider diagnostics withheld`);
} finally {
  clearInterval(heartbeat);
  try {
    if (session) await closeLiveSession(session);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    console.log("CLEANUP: tool-selection session stopped and temporary fixtures removed");
  }
}
