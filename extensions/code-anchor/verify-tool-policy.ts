import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import type { TuiTrace } from "./tests/tui-fixture.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-tool-policy.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const packageInfo = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { name: string; bin: { pi: string } };
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-tool-policy-"));
const agent = join(temporary, "agent");
const workspace = join(temporary, "workspace");
const owned = ["hashline_read", "hashline_edit", "ast_grep", "ast_edit"];
let client: RpcClient | undefined;
let sequence = 0;

try {
  await mkdir(join(agent, "extensions"), { recursive: true });
  await symlink(root, join(agent, "extensions", "code-anchor"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(workspace);
  await writeFile(join(workspace, "fixture.ts"), "// policy fixture\nlogger.info(after);\n");
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    packages: [], extensions: ["-builtin:mcp"], defaultTools: ["write", "grep", "find", "ls"],
    defaultProvider: "code-anchor-tui-fixture", defaultModel: "fixture", cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  const start = async (args: string[]) => {
    client = new sdk.RpcClient({
      cliPath: join(packageDirectory, packageInfo.bin.pi), cwd: workspace,
      env: { PI_CODING_AGENT_DIR: agent, CODE_ANCHOR_TUI_DIRECTORY: workspace, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
      args: ["--offline", "--no-mcp", "--no-approve", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates",
        "--extension", join(root, "tests/tui-fixture.ts"), ...args],
    });
    await client.start();
    await client.getState();
    return client;
  };
  const tools = async (active: RpcClient): Promise<string[]> => {
    const label = `policy-${++sequence}`;
    assert.equal(await active.prompt(`/terminal-checkpoint ${label}`), "handled");
    const text = await readFile(join(workspace, "trace.jsonl"), "utf8");
    const trace = text.trim().split("\n").map(line => JSON.parse(line) as TuiTrace);
    const record = trace.findLast(item => item.event === "checkpoint" && item.phase === label);
    assert(record?.tools);
    return record.tools;
  };
  const assertOn = (names: string[]) => {
    for (const name of owned) assert(names.includes(name), `Missing ${name}`);
    for (const name of ["read", "edit"]) assert(!names.includes(name), `Unexpected native ${name}`);
  };
  const normal = await start(["--session-dir", join(temporary, "sessions")]);
  assertOn(await tools(normal));
  await normal.prompt("/code-anchor off");
  for (const name of [...owned, "read", "edit"]) assert(!(await tools(normal)).includes(name), `Off activated ${name}`);
  await normal.prompt("/terminal-reload");
  for (const name of [...owned, "read", "edit"]) assert(!(await tools(normal)).includes(name), `Reload activated ${name}`);
  await normal.prompt("/terminal-native-tools");
  const explicit = await tools(normal);
  assert(explicit.includes("read") && explicit.includes("edit"));
  await normal.promptAndWait("fixture:builtin", undefined, 10000);
  await normal.prompt("/code-anchor on");
  assertOn(await tools(normal));
  const sessionFile = (await normal.getState()).sessionFile;
  assert(sessionFile && existsSync(sessionFile));
  await normal.stop(); client = undefined;

  const resumed = await start(["--session", sessionFile]);
  assertOn(await tools(resumed));
  await resumed.prompt("/terminal-reload");
  assertOn(await tools(resumed));
  await resumed.stop(); client = undefined;
  console.log("PASS: actual Pi CLI registration, off/reload, explicit native selection, and resume of an old native loadout");

  for (const [label, args, expected] of [
    ["allowlist", ["--tools", "grep"], ["grep"]],
    ["exclusions", ["--exclude-tools", "hashline_read,ast_edit"], ["write", "grep", "find", "ls", "hashline_edit", "ast_grep"]],
    ["no-tools", ["--no-tools"], []],
    ["modifier", ["--tools", "-hashline_read"], ["write", "grep", "find", "ls", "hashline_edit", "ast_grep", "ast_edit"]],
  ] as const) {
    const active = await start(["--no-session", ...args]);
    assert.deepEqual((await tools(active)).sort(), [...expected].sort(), `${label}: activation ignored explicit tool restrictions`);
    await active.prompt("/terminal-reload");
    assert.deepEqual((await tools(active)).sort(), [...expected].sort(), `${label}: reload ignored explicit tool restrictions`);
    await active.stop(); client = undefined;
    console.log(`PASS: actual Pi CLI ${label} and reload`);
  }
} finally {
  if (client) await client.stop();
  await rm(temporary, { force: true, recursive: true, maxRetries: 3 });
  assert(!existsSync(temporary));
  console.log("CLEANUP: Pi CLI tool-policy processes and temporary files removed");
}
