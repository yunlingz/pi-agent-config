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
    ["src/params.ts", '// params.include = ["reasoning.encrypted_content"];\nexport const example = \'params.include = ["reasoning.encrypted_content"]\';\nexport function configure(params, reasoning) {\n  if (reasoning) {\n    params.include = ["reasoning.encrypted_content"];\n  }\n}\n'],
    ["src/single.ts", '// console.warn("comment");\nexport const sample = \'console.warn("string")\';\nconsole.warn("actual");\n'],
    ["known.txt", "first\nsecond\nKNOWN_RANGE_OK\nfourth\n"],
    ["legacy/source.ex", 'defmodule Fixture do\n  def persist do\n    Cache.write("legacy")\n  end\nend\n'],
    ["batch-one.txt", "unused\nBATCH_ONE_A\nunused\nunused\nBATCH_ONE_B\n"],
    ["batch-two.txt", "unused\nunused\nBATCH_TWO\n"],
  ]);
  await mkdir(join(temporary, "src"));
  await mkdir(join(temporary, "styles"));
  await mkdir(join(temporary, "legacy"));
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
  const builtinNames = ["bash", "write", "grep", "find", "ls"];
  const codeAnchorNames = ["hashline_read", "hashline_edit", "ast_grep", "ast_edit"];
  session.setActiveToolsByName([...session.getActiveToolNames(), ...builtinNames]);
  for (const name of [...builtinNames, ...codeAnchorNames]) {
    assert(session.getActiveToolNames().includes(name), `Missing tool-selection candidate: ${name}`);
  }
  for (const name of ["read", "edit"]) assert(!session.getActiveToolNames().includes(name));
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => {
    if (event.type !== "message_update") events.push(event);
    if (event.type === "tool_execution_end") {
      toolCalls++;
      toolOutcomes.push({ phase, tool: event.toolName, failed: event.isError });
    }
  });
  const runCase = async (label: string, prompt: string, requiredTools: string[], checks: { first?: string; ordered?: string[]; forbidden?: string[]; readFiles?: string[] } = {}): Promise<string> => {
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
      const started = turn.filter(event => event.type === "tool_execution_start").map(event => event.toolName);
      if (checks.first) assert.equal(started[0], checks.first, `${label}: incorrect first tool`);
      let previous = -1;
      for (const name of checks.ordered ?? []) {
        const index = started.indexOf(name);
        assert(index > previous, `${label}: ${name} must follow source inspection or preview`);
        previous = index;
      }
      for (const name of checks.forbidden ?? []) assert(!started.includes(name), `${label}: unnecessary or unsupported ${name}`);
      if (checks.readFiles) {
        const reads = turn.filter(event => event.type === "tool_execution_start" && event.toolName === "hashline_read");
        for (const file of checks.readFiles) {
          assert(reads.some(event => event.type === "tool_execution_start" && typeof event.args.path === "string" && (event.args.path === file || event.args.path.startsWith(`${file}:`))), `${label}: missing separate call for ${file}`);
        }
        assert(!turn.some(event => event.type === "tool_execution_end" && event.isError), `${label}: all separate reads must succeed`);
      }
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
  const trace = await runCase("structural exploration", "Locate every actual cache.write(...) call under src. Report each enclosing function and its arguments. Ignore comments and string examples. Do not change files.", ["ast_grep", "hashline_read"], { first: "ast_grep" });
  assert(trace.includes("persistFirst") && trace.includes("persistSecond"), "The explanation must identify both actual callers");
  const assignment = await runCase("literal in a structural question", "Where does the code assign reasoning.encrypted_content to the outgoing params.include array under src, and under what condition? Ignore examples. Do not change files.", ["ast_grep", "hashline_read"], { first: "ast_grep" });
  assert(assignment.includes("configure") && assignment.includes("reasoning"), "Identify the actual assignment and its condition");
  const known = await runCase("known range", "Return only the content of line 3 in known.txt. Do not change files.", ["hashline_read"], { first: "hashline_read", forbidden: ["grep", "ast_grep", "find", "ls"] });
  assert.equal(known.trim(), "KNOWN_RANGE_OK");
  const batch = await runCase("multiple files with selectors", "Return only lines 2 and 5 from batch-one.txt and line 3 from batch-two.txt, in that order. Preserve their text. Do not change files.", ["hashline_read"], { first: "hashline_read", forbidden: ["grep", "ast_grep", "find", "ls", "bash"], readFiles: ["batch-one.txt", "batch-two.txt"] });
  assert.equal(batch.trim(), "BATCH_ONE_A\nBATCH_ONE_B\nBATCH_TWO");
  await runCase("literal search", "Find the literal DOCGEN_READY in events.log and report its line number. Do not change files.", ["grep"], { first: "grep" });
  await runCase("unsupported syntax search", "Find every $accent reference in styles/theme.scss and report its line number. Do not change files.", ["grep"], { first: "grep", forbidden: ["ast_grep"] });
  const legacy = await runCase("unsupported language", "Locate the Cache.write call in legacy/source.ex and report its line number. Do not change files.", ["grep"], { forbidden: ["ast_grep"] });
  assert(legacy.includes("3"), "Unsupported-language search must identify the call line");
  await checkFixtures();

  await runCase("structural rewrite", "Replace every actual cache.write call under src with cache.save. Preserve arguments, comments, string examples, and all other content.", ["hashline_read", "ast_edit", "write"], { ordered: ["hashline_read", "ast_edit", "write"] });
  for (const path of ["src/alpha.ts", "src/beta.ts"]) {
    const before = fixtures.get(path);
    assert(before);
    fixtures.set(path, before.replace("cache.write", "cache.save"));
  }
  await checkFixtures();
  await runCase("single-match structural rewrite", "In src/single.ts, replace the actual console.warn call with logger.warn. Preserve its argument, comments, and string examples.", ["hashline_read", "ast_edit", "write"], { ordered: ["hashline_read", "ast_edit", "write"] });
  fixtures.set("src/single.ts", '// console.warn("comment");\nexport const sample = \'console.warn("string")\';\nlogger.warn("actual");\n');
  await runCase("unsupported dialect edit", "In styles/theme.scss, change the $accent definition from blue to red. Preserve all other bytes.", ["hashline_read", "hashline_edit"], { ordered: ["hashline_read", "hashline_edit"], forbidden: ["ast_edit", "ast_grep"] });
  fixtures.set("styles/theme.scss", "$accent: red;\n.panel { color: $accent; }\n");
  await checkFixtures();
  await runCase("context-specific edit", "In notes.md, change Draft to Ready only under the Pending heading. Preserve the Archived section and all other content.", ["hashline_read", "hashline_edit"], { ordered: ["hashline_read", "hashline_edit"] });
  fixtures.set("notes.md", "# Status\n\n## Archived\nDraft\n\n## Pending\nReady\n");
  await checkFixtures();

  await session.prompt("/code-anchor off");
  for (const name of codeAnchorNames) assert(!session.getActiveToolNames().includes(name));
  for (const name of ["read", "edit"]) assert(!session.getActiveToolNames().includes(name), "Off must not activate native read/edit");
  for (const name of builtinNames) assert(session.getActiveToolNames().includes(name));
  session.setActiveToolsByName([...session.getActiveToolNames(), "read"]);
  const fallback = await runCase("disabled structural fallback", "Find every actual cache.save(...) call under src and report its filename and arguments. Do not change files.", []);
  // When AST tools are off, native search or inspection can satisfy this small, previously inspected scope.
  assert(toolOutcomes.some(outcome => outcome.phase === phase && !outcome.failed && ["grep", "read"].includes(outcome.tool)),
    "Disabled fallback must use native search or inspection");
  for (const marker of ["alpha.ts", "beta.ts", "first", "second"]) assert(fallback.includes(marker), `Disabled fallback omitted ${marker}`);
  assert.match(fallback, /value\W+1/u);
  assert.match(fallback, /value\W+2/u);
  await checkFixtures();
  console.log("PASS: thirteen natural tasks; separate multi-file reads, tool order, language fallback, exact file changes, model, and reasoning verified");
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
