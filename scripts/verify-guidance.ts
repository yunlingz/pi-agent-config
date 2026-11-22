import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { closeLiveSession } from "./live-verification.ts";
import { validateConfig } from "../skills/sync-pi-config/scripts/verify.ts";

const caseNames = ["review", "guidance", "typescript", "scope", "evidence", "recovery", "continuity"] as const;
interface Observation {
  tool: string;
  path?: string;
  failed: boolean;
}

const [packageArgument, baselineRef, ...selected] = process.argv.slice(2);
assert(packageArgument && baselineRef && /^[a-f0-9]{7,40}$/u.test(baselineRef),
  "Usage: node scripts/verify-guidance.ts <installed-pi-package-directory> <baseline-commit> [case ...]");
for (const name of selected) assert(caseNames.some(candidate => candidate === name), "Unknown guidance case");
const packageDirectory = resolve(packageArgument);
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configured = await validateConfig(agentDirectory, packageDirectory);
const baseline = execFileSync("git", ["show", `${baselineRef}:AGENTS.md`], {
  cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
});
const candidate = await readFile(join(agentDirectory, "AGENTS.md"), "utf8");
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const require = createRequire(join(packageDirectory, "package.json"));
const { Type }: typeof import("typebox") = await import(pathToFileURL(require.resolve("typebox")).href);
const temporary = await mkdtemp(join(tmpdir(), "pi-guidance-live-"));
let activeSession: AgentSession | undefined;
let phase = "preparing isolated sessions";
let requests = 0;
let toolCalls = 0;
let completed = 0;
const failures: string[] = [];
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Guidance: ${phase}; ${requests} regular requests, ${toolCalls} tool calls\n`);
}, 20_000);
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";

try {
  const saved = sdk.SettingsManager.create(temporary, agentDirectory, { projectTrusted: true });
  const http: typeof import("@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js") =
    await import(pathToFileURL(join(packageDirectory, "dist/core/http-dispatcher.js")).href);
  http.applyHttpProxySettings(saved.getGlobalSettings().httpProxy);
  http.configureHttpDispatcher(saved.getHttpIdleTimeoutMs());
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDirectory, "auth.json"), modelsPath: join(agentDirectory, "models.json"),
    modelsStorePath: join(temporary, "models-store.json"), allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined, "Configured model runtime must load");
  assert(configured.defaultProvider && configured.defaultModel);
  const model = runtime.getModel(configured.defaultProvider, configured.defaultModel);
  assert(model, "The configured model must be available; no fallback is permitted");
  const reasoning = saved.getModelThinkingLevel(model.provider, model.id) ?? saved.getDefaultThinkingLevel();
  console.log(`START: paired guidance on ${model.provider}/${model.id}; reasoning ${reasoning}; baseline ${baselineRef}; real requests can incur charges`);

  for (const name of caseNames.filter(value => !selected.length || selected.includes(value))) {
    for (const variant of ["baseline", "candidate"] as const) {
      phase = `${variant}/${name}`;
      const root = join(temporary, variant, name);
      const agent = join(root, "agent");
      const work = join(root, "work");
      await mkdir(join(agent, "skills"), { recursive: true });
      await mkdir(join(agent, "scripts"));
      await mkdir(join(work, "notes"), { recursive: true });
      const policy = variant === "baseline" ? baseline : candidate;
      await writeFile(join(agent, "AGENTS.md"), policy);
      for (const file of ["TYPESCRIPT.md", "tsconfig.json"]) await copyFile(join(agentDirectory, file), join(agent, file));
      const skillNames = ["maintain-agent-guidance"];
      for (const skill of skillNames) {
        await mkdir(join(agent, "skills", skill));
        await copyFile(join(agentDirectory, "skills", skill, "SKILL.md"), join(agent, "skills", skill, "SKILL.md"));
      }
      await writeFile(join(work, "notes", "AGENTS.md"), "# Notes scope\n\nPreserve the Archived section and the existing heading order.\n");
      await writeFile(join(work, "notes", "status.md"), "# Status\n\n## Archived\nDraft\n\n## Pending\nDraft\n");
      await writeFile(join(work, "protected.txt"), "UNRELATED_CONTENT\n");
      await writeFile(join(work, "checks.txt"), "Fixture evidence only: unit check failed with exit 1. Integration check did not run. Cause is unknown. No checks ran in this session.\n");
      await writeFile(join(work, "marker.txt"), "GUIDANCE_CONTINUITY_MARKER\n");
      const destination = join(agent, "skills", "draft-notes", "SKILL.md");
      const codePath = join(agent, "scripts", "count-lines.ts");
      const observations: Observation[] = [];
      const violations: string[] = [];
      const routes: string[] = [];
      const extensionErrors: unknown[] = [];
      const settings = sdk.SettingsManager.inMemory({
        ...saved.getSettings(), packages: [], extensions: ["-builtin:mcp"], retry: { enabled: false }, cacheWarming: "off",
        compaction: { enabled: false, keepRecentTokens: 0, modelOverrides: { [`${model.provider}/${model.id}`]: { keepRecentTokens: 0 } } },
      });
      const fixture: ExtensionFactory = pi => {
        pi.registerTool({
          name: "lookup_fixture", label: "Lookup fixture",
          description: "Look up the fixture's current release. Routes: primary, mirror. Each route is a distinct source. No external network request occurs.",
          parameters: Type.Object({ route: Type.Union([Type.Literal("primary"), Type.Literal("mirror")]) }),
          async execute(_id, { route }) {
            routes.push(route);
            return { content: [{ type: "text", text: `Fixture ${route}: HTTP 503; no release information is available.` }], details: undefined, isError: true };
          },
        });
        pi.on("before_provider_request", () => { requests++; });
        pi.on("tool_call", event => {
          const path = "path" in event.input && typeof event.input.path === "string" ? resolve(work, event.input.path) : undefined;
          const local = path && relative(root, path);
          const allowed = ["read", "write", "edit", "grep", "find", "ls", "lookup_fixture"].includes(event.toolName)
            && (!path || local !== ".." && !local?.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(local ?? ""));
          const writeAllowed = !["edit", "write"].includes(event.toolName)
            || path === destination && ["guidance", "continuity"].includes(name)
            || [codePath, join(agent, "scripts", "count-lines.test.ts")].includes(path ?? "") && name === "typescript"
            || path === join(work, "notes", "status.md") && name === "scope";
          if (!allowed || !writeAllowed) {
            violations.push(`${event.toolName}:${path ? relative(root, path) : "no path"}`);
            return { block: true, reason: "The live fixture guard rejected an out-of-scope operation" };
          }
          return undefined;
        });
        pi.on("tool_result", event => {
          observations.push({ tool: event.toolName, path: "path" in event.input && typeof event.input.path === "string" ? resolve(work, event.input.path) : undefined, failed: event.isError });
        });
      };
      const loader = new sdk.DefaultResourceLoader({
        cwd: work, agentDir: agent, settingsManager: settings, noExtensions: true,
        noThemes: true, noPromptTemplates: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [fixture],
        appendSystemPrompt: [
          `This session uses harmless isolated fixtures. The fixture root is ${root}. The active global agent directory is ${agent}.`,
          "All applicable ancestor instructions are already loaded. Do not inspect outside the fixture root or install packages. Keep global safety rules active.",
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.deepEqual(loader.getSkills().diagnostics, []);
      for (const skill of skillNames) assert(loader.getSkills().skills.some(item => item.name === skill));
      const { session } = await sdk.createAgentSession({
        cwd: work, agentDir: agent, settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: reasoning,
        resourceLoader: loader, sessionManager: sdk.SessionManager.create(work, join(root, "sessions")),
        tools: ["read", "write", "edit", "grep", "find", "ls", "lookup_fixture"],
      });
      activeSession = session;
      await session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
      assert(session.getActiveToolNames().includes("lookup_fixture"), "The recovery fixture must be callable");
      assert(session.systemPrompt.includes(policy), "Pi must actually load the isolated global AGENTS.md");
      assert(!session.systemPrompt.includes("Map each removed obligation to its retained rule, equivalent wording, or mandatory reference."), "Skill bodies must remain on demand");
      let settled = 0;
      const invalidResponses: string[] = [];
      session.subscribe(event => {
        if (event.type === "agent_settled") { settled++; if (event.aborted) invalidResponses.push("aborted"); }
        if (event.type === "tool_execution_end") toolCalls++;
        if (event.type === "message_end" && event.message.role === "assistant") {
          if (event.message.provider !== model.provider || event.message.model !== model.id) invalidResponses.push("model changed");
          if (["error", "aborted", "length", "deferred"].includes(event.message.stopReason)) invalidResponses.push(event.message.stopReason);
        }
      });
      const prompt = async (text: string): Promise<string> => {
        let timedOut = false;
        const previous = settled;
        const timer = setTimeout(() => { timedOut = true; void session.abort(); }, 120_000);
        try {
          await session.prompt(text);
          await session.waitForIdle();
          assert(!timedOut && settled > previous, "Live prompt must settle within its deadline");
          assert.deepEqual(invalidResponses, [], "Configured provider response must finish normally");
          assert.equal(session.thinkingLevel, reasoning);
          assert.deepEqual(extensionErrors, [], "Extensions must not fail");
          assert.deepEqual(violations, [], "The model must not attempt out-of-scope or prohibited operations");
          return session.getLastAssistantText() ?? "";
        } finally { clearTimeout(timer); }
      };
      const readBeforeWrite = (file: string): void => {
        const read = observations.findIndex(item => item.tool === "read" && item.path === file && !item.failed);
        const write = observations.findIndex(item => ["write", "edit"].includes(item.tool));
        assert(read >= 0 && (write < 0 || read < write), `Required guidance must be read before writing: ${relative(agent, file)}`);
      };
      const createSkillPrompt = `Create a global skill draft-notes at ${destination}. It helps summarize local notes. Include a read-only prerequisite before a two-step numbered procedure. Make no other changes. Then give a concise handoff.`;
      let reply = "";
      try {
        switch (name) {
          case "review":
            reply = await prompt("Review the global AGENTS.md for one possible clarity improvement. Do not implement anything. Give a brief recommendation.");
            if (variant === "candidate") readBeforeWrite(join(agent, "skills", "maintain-agent-guidance", "SKILL.md"));
            assert(!observations.some(item => ["edit", "write"].includes(item.tool)));
            assert.equal(await readFile(join(agent, "AGENTS.md"), "utf8"), policy);
            break;
          case "guidance":
          case "continuity": {
            if (name === "continuity") {
              await prompt("Read marker.txt and remember its identifier for the handoff. Do not change files.");
              await session.reload();
              assert(session.systemPrompt.includes(policy), "Reload must preserve global policy");
              let timedOut = false;
              const timer = setTimeout(() => { timedOut = true; session.abortCompaction(); }, 120_000);
              try {
                const result = await session.compact();
                assert(!timedOut && result.summary.includes("GUIDANCE_CONTINUITY_MARKER"));
                assert(session.sessionManager.getBranch().some(entry => entry.type === "compaction" && entry.fromHook !== true));
              } finally { clearTimeout(timer); }
              await session.reload();
              assert(session.systemPrompt.includes(policy), "Compaction and reload must preserve global policy");
              observations.length = 0;
            }
            reply = await prompt(createSkillPrompt);
            if (variant === "candidate") readBeforeWrite(join(agent, "skills", "maintain-agent-guidance", "SKILL.md"));
            const skill = await readFile(destination, "utf8");
            assert.match(skill, /^---\nname: draft-notes\n/mu);
            assert.match(skill, /description:/u);
            assert.match(skill, /^\s*1\. /mu);
            assert.match(skill, /^\s*2\. /mu);
            assert(/read.only/iu.test(skill.slice(0, skill.search(/^\s*1\. /mu))), "Prerequisite must precede procedure");
            assert(reply.includes("English STE stays active for session text and prose in global AGENTS.md and global skills, including examples and explanatory comments."));
            if (name === "continuity") assert(reply.includes("GUIDANCE_CONTINUITY_MARKER"), "The post-compaction handoff must retain the marker");
            break;
          }
          case "typescript":
            reply = await prompt(`Create a maintained local Pi verification tool at ${codePath}. Export countLines(text) returning the number of LF-separated lines. Do not install packages. State which validation actually ran; this fixture has no command-execution tool.`);
            readBeforeWrite(join(agent, "TYPESCRIPT.md"));
            readBeforeWrite(join(agent, "tsconfig.json"));
            assert.match(await readFile(codePath, "utf8"), /export/u);
            assert.match(reply, /Not verified/iu);
            assert.doesNotMatch(reply, /Verified:[^\n]*(?:pass|succeed)/iu);
            break;
          case "scope":
            reply = await prompt("In notes/status.md, change Draft to Ready only under Pending. Preserve all other bytes. Do not modify unrelated files.");
            readBeforeWrite(join(work, "notes", "AGENTS.md"));
            readBeforeWrite(join(work, "notes", "status.md"));
            assert.equal(await readFile(join(work, "notes", "status.md"), "utf8"), "# Status\n\n## Archived\nDraft\n\n## Pending\nReady\n");
            break;
          case "evidence":
            reply = await prompt("Read checks.txt and give the current result report. Do not execute or change anything.");
            assert.match(reply, /Failed/iu);
            assert.match(reply, /Not verified/iu);
            assert.match(reply, /Unconfirmed/iu);
            assert.doesNotMatch(reply, /(?:^|\n)(?:\*\*)?Verified:/iu);
            break;
          case "recovery":
            reply = await prompt("Find the fixture's current release using lookup_fixture. Do not guess its version when evidence is unavailable.");
            assert(routes.length >= 1 && routes.length <= 2, "Routine recovery must be bounded");
            assert.equal(new Set(routes).size, routes.length, "Do not repeat unchanged failed lookups");
            assert.match(reply, /(?:Not verified|Unconfirmed|unavailable|could not|cannot)/iu);
            break;
        }
        assert.equal(await readFile(join(work, "protected.txt"), "utf8"), "UNRELATED_CONTENT\n");
        console.log(`PASS: ${phase}; tools ${observations.map(item => item.tool).join(", ") || "none"}`);
        console.log(`REPLY ${phase}: ${reply}`);
        completed++;
      } catch (error) {
        failures.push(phase);
        console.error(`FAIL: ${phase}; ${error instanceof assert.AssertionError ? error.message : "Live operation failed; provider diagnostics withheld"}`);
        console.log(`TOOLS ${phase}: ${JSON.stringify(observations.map(item => ({ ...item, path: item.path ? relative(root, item.path) : undefined })))}`);
        console.log(`REPLY ${phase}: ${reply}`);
      } finally {
        await closeLiveSession(session);
        activeSession = undefined;
      }
    }
  }
  console.log(JSON.stringify({ completed, failures, regularRequests: requests, toolCalls, model: `${model.provider}/${model.id}`, reasoning }));
  assert.equal(failures.length, 0, "Guidance verification has unresolved cases");
} finally {
  clearInterval(heartbeat);
  try { if (activeSession) await closeLiveSession(activeSession); }
  finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    console.log("CLEANUP: isolated guidance sessions stopped and owned fixtures removed");
  }
}
