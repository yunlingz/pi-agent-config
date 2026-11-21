import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { assertMcpDisabled, validateConfig } from "../../skills/sync-pi-config/scripts/verify.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-live.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const info = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { name: string; bin: { pi: string } };
assert.equal(info.name, "@earendil-works/pi-coding-agent");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
assert(settings.defaultProvider && settings.defaultModel);
const effort = settings.modelThinkingLevels?.[`${settings.defaultProvider}/${settings.defaultModel}`] ?? settings.defaultThinkingLevel;
const directory = await mkdtemp(join(tmpdir(), "rw-hashline-live-"));
let client: RpcClient | undefined;
let phase = "startup";
try {
  const marker = `HASHLINE_${randomUUID()}`;
  await writeFile(join(directory, "marker.txt"), marker + "\n");
  await writeFile(join(directory, "line.txt"), "head\nbefore\r\nkeep\r\ntail\n");
  await writeFile(join(directory, "newline.txt"), "before\n");
  client = new sdk.RpcClient({ cliPath: join(packageDirectory, info.bin.pi), cwd: directory,
    env: { PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    args: ["--no-session", "--no-mcp", "--offline", "--no-approve", "--no-extensions", "--extension", join(dirname(fileURLToPath(import.meta.url)), "extension.ts"), "--no-context-files", "--no-skills", "--no-prompt-templates", "--tools", "hashline_read,hashline_edit,write"],
  });
  await client.start();
  const state = await client.getState();
  assert.equal(state.model?.provider, settings.defaultProvider);
  assert.equal(state.model?.id, settings.defaultModel);
  assert.equal(state.thinkingLevel, effort);
  console.log(`START: real Pi rw-hashline workflows; ${settings.defaultProvider}/${settings.defaultModel}; ${effort}`);
  const prompts = [
    "Use hashline_read to read marker.txt. Reply with only its marker text, without the snapshot header or line numbers.",
    "Read line.txt with hashline_read. Use hashline_edit to replace only original line 2 with after. Copy the snapshot header exactly. Do not use write. Reply LINE_OK.",
    "Read newline.txt with hashline_read. Use hashline_edit to replace line 1 with after. Then read the changed file again and use its fresh snapshot header to cut the final empty row, removing the final newline. Use two edit calls with a read before each. Do not use write or exact-text arguments. Reply NEWLINE_OK.",
    "Use ordinary write to create written.md containing exactly WRITE_OK followed by a newline. Reply WRITE_OK.",
  ];
  for (const [index, prompt] of prompts.entries()) {
    phase = ["marker read", "line edit", "newline edits", "ordinary write"][index] ?? "unknown step";
    console.log(`STEP: ${phase}`);
    const events = await client.promptAndWait(prompt, undefined, 90000);
    for (const event of events) {
      if (event.type === "tool_execution_start") {
        const name = ["hashline_read", "hashline_edit", "write", "read", "edit", "ast_grep", "ast_edit"].includes(event.toolName) ? event.toolName : "unknown";
        console.log(JSON.stringify({ phase, tool: name, inputForm: typeof event.args.input === "string", snapshotHeader: typeof event.args.input === "string" && /#[0-9A-F]{12}\]/u.test(event.args.input) }));
      }
      if (event.type === "tool_execution_end" && event.isError) console.log(JSON.stringify({ phase, toolFailed: true }));
    }
    assert(events.some(event => event.type === "tool_execution_end" && !event.isError));
    assert(!events.some(event => event.type === "tool_execution_end" && event.isError));
    assert(!events.some(event => event.type === "tool_execution_start" && ["read", "edit", "ast_grep", "ast_edit"].includes(event.toolName)));
    for (const event of events) {
      if (event.type === "tool_execution_start" && event.toolName === "hashline_edit") {
        assert(typeof event.args.input === "string" && !Object.hasOwn(event.args, "path") && !Object.hasOwn(event.args, "edits"));
        assert(/#[0-9A-F]{12}\]/u.test(event.args.input), "Every live edit must carry its snapshot header.");
      }
    }
    const expected = [marker, "LINE_OK", "NEWLINE_OK", "WRITE_OK"][index];
    assert.equal((await client.getLastAssistantText())?.trim(), expected);
  }
  phase = "filesystem results";
  assert.equal(await readFile(join(directory, "line.txt"), "utf8"), "head\nafter\r\nkeep\r\ntail\n");
  assert.equal(await readFile(join(directory, "newline.txt"), "utf8"), "after");
  assert.equal(await readFile(join(directory, "written.md"), "utf8"), "WRITE_OK\n");
  assert.equal((await client.getState()).thinkingLevel, effort);
  assert.equal(client.getStderr(), "", "Pi emitted diagnostics; raw text is withheld.");
  console.log("PASS: real model reads snapshot output; every edit uses snapshot-checked line documents; untouched bytes stay exact; anchored final-newline removal; ordinary write; exact replies; no native read/edit or AST calls; unchanged model and effort");
} catch (error) {
  console.error(JSON.stringify({ phase, kind: error instanceof assert.AssertionError ? "assertion" : "runtime", operator: error instanceof assert.AssertionError ? error.operator : undefined }));
  throw new Error("Live rw-hashline verification failed; raw model and provider diagnostics are withheld.");
} finally {
  if (client) await client.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(directory));
  console.log("CLEANUP: live session stopped and task-owned fixtures removed");
}
