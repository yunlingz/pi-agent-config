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
try {
  const marker = `HASHLINE_${randomUUID()}`;
  await writeFile(join(directory, "marker.txt"), marker + "\n");
  await writeFile(join(directory, "line.txt"), "head\nbefore\r\nkeep\r\ntail\n");
  await writeFile(join(directory, "exact.txt"), "before\n");
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
    "Read line.txt with hashline_read. Use the input form of hashline_edit to replace only original line 2 with after. Copy the snapshot header exactly. Do not use exact-text edits or write. Reply LINE_OK.",
    "Use hashline_edit with path and edits[] to replace before followed by its newline in exact.txt with after without a final newline. Do not use the input form or write. Reply EXACT_OK.",
    "Use ordinary write to create written.md containing exactly WRITE_OK followed by a newline. Reply WRITE_OK.",
  ];
  for (const [index, prompt] of prompts.entries()) {
    const events = await client.promptAndWait(prompt, undefined, 90000);
    assert(events.some(event => event.type === "tool_execution_end" && !event.isError));
    assert(!events.some(event => event.type === "tool_execution_end" && event.isError));
    assert(!events.some(event => event.type === "tool_execution_start" && ["read", "edit", "ast_grep", "ast_edit"].includes(event.toolName)));
    const expected = [marker, "LINE_OK", "EXACT_OK", "WRITE_OK"][index];
    assert.equal((await client.getLastAssistantText())?.trim(), expected);
  }
  assert.equal(await readFile(join(directory, "line.txt"), "utf8"), "head\nafter\r\nkeep\r\ntail\n");
  assert.equal(await readFile(join(directory, "exact.txt"), "utf8"), "after");
  assert.equal(await readFile(join(directory, "written.md"), "utf8"), "WRITE_OK\n");
  assert.equal((await client.getState()).thinkingLevel, effort);
  assert.equal(client.getStderr(), "", "Pi emitted diagnostics; raw text is withheld.");
  console.log("PASS: real model reads snapshot output; literal line editing preserves untouched bytes; native exact-text editing removes final newline; ordinary write; exact replies; no native read/edit or AST calls; unchanged model and effort");
} catch {
  throw new Error("Live rw-hashline verification failed; raw model and provider diagnostics are withheld.");
} finally {
  if (client) await client.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(directory));
  console.log("CLEANUP: live session stopped and task-owned fixtures removed");
}
