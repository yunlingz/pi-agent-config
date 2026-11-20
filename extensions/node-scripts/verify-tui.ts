import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { IPty } from "node-pty";
import type { Trace } from "./tui-fixture.ts";
import type { Job, Query } from "./types.ts";

const [installation, ptyDirectory, footerDirectory] = process.argv.slice(2);
assert(installation && ptyDirectory && footerDirectory, "Usage: node verify-tui.ts <Pi> <node-pty> <Powerline>");
const pty = createRequire(import.meta.url)(resolve(ptyDirectory)) as typeof import("node-pty");
const root = await realpath(await mkdtemp(join(tmpdir(), "node-scripts-terminal-")));
const agent = join(root, "agent"), project = join(root, "project");
let terminal: IPty | undefined;
let exit: { exitCode: number } | undefined;
let exited: Promise<void> | undefined;
let output = "";
let phase = "starting actual Pi terminal";
const traces = async (): Promise<Trace[]> => (await readFile(join(root, "trace.jsonl"), "utf8").catch(() => "")).split("\n").slice(0, -1).map(line => JSON.parse(line) as Trace);
const heartbeat = setInterval(() => console.error(`[${new Date().toISOString()}] node-scripts terminal: ${phase}`), 20000);
try {
  await mkdir(join(agent, "extensions"), { recursive: true }); await mkdir(project);
  const extension = dirname(fileURLToPath(import.meta.url));
  await symlink(extension, join(agent, "extensions", "node-scripts"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(agent, "pi-node-scripts.json"), JSON.stringify({ rootFolder: join(root, "workspaces"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [resolve(footerDirectory)], extensions: ["-builtin:mcp"], defaultTools: ["read", "edit", "write", "grep", "find", "ls"], defaultProvider: "node-terminal-fixture", defaultModel: "fixture", quietStartup: true, retry: { enabled: false }, cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 0 }, powerline: { welcome: false, autoFollowUp: false, git: { polling: "off" }, customItems: [{ id: "node_scripts", statusKey: "node-scripts", position: "left", color: "muted" }], layout: { left: ["custom:node_scripts", "path"], right: [] } } }));
  const info = JSON.parse(await readFile(join(installation, "package.json"), "utf8")) as { bin: { pi: string } };
  terminal = pty.spawn(process.execPath, [resolve(installation, info.bin.pi), "--offline", "--no-mcp", "--no-approve", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "--extension", join(extension, "tui-fixture.ts"), "--tui-mode", "fullscreen"], {
    cols: 120, rows: 44, cwd: project, name: "xterm-256color", env: { ...process.env, PI_CODING_AGENT_DIR: agent, NODE_SCRIPTS_TUI_ROOT: root, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_PROGRAM_STATUS: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const child = terminal;
  exited = new Promise<void>(accept => child.onExit(value => { exit = value; accept(); }));
  child.onData(data => {
    output = (output + data).slice(-1_000_000);
    if (data.includes("\x1b[c") || data.includes("\x1b[0c")) child.write("\x1b[?1;2c");
    if (data.includes("\x1b[6n")) child.write("\x1b[1;1R");
  });
  const visible = () => stripVTControlCharacters(output);
  const wait = async (label: string, predicate: () => boolean | Promise<boolean>) => {
    phase = label; const deadline = Date.now() + 20000;
    while (!await predicate()) { assert(!exit, `${label}: Pi exited`); assert(Date.now() < deadline, `${label}: timed out`); await new Promise(accept => setTimeout(accept, 25)); }
  };
  const count = async (event: string) => (await traces()).filter(value => value.event === event).length;
  const prompt = async (text: string) => { const before = await count("settled"); child.write(`${text}\r`); await wait(text, async () => await count("settled") > before); };
  const latest = async (name: string) => { const value = (await traces()).findLast(value => value.job?.name === name)?.job; assert(value); return value; };
  const persisted = async (job: Query | Awaited<ReturnType<typeof latest>>) => JSON.parse(await readFile(join(job.workspace, "jobs", `${job.id}.json`), "utf8")) as Job;
  const reload = async () => {
    const before = await count("start"); output = ""; child.write("/reload\r");
    await wait("native reload", async () => await count("start") > before);
    await wait("reload complete", () => visible().includes("Reloaded keybindings"));
    await new Promise(accept => setTimeout(accept, 150));
  };
  await wait("exact Powerline on label", () => /node-scripts:\s*on/u.test(visible()));
  await prompt("Run a background service.");
  const service = await latest("Terminal service");
  await wait("actual service output and panel", async () => /SERVICE_LIVE \d+/u.test(await readFile(service.stdoutPath, "utf8")) && visible().includes("Node jobs") && visible().includes("LATEST_SERVICE_LINE"));
  const pid = Number(/SERVICE_LIVE (\d+)/u.exec(await readFile(service.stdoutPath, "utf8"))?.[1]); assert(pid > 0);
  output = ""; child.resize(119, 44);
  await wait("panel above Powerline", () => visible().includes("Node jobs") && /node-scripts:\s*on/u.test(visible()));
  assert(visible().lastIndexOf("Node jobs") < visible().lastIndexOf("node-scripts:"));
  const settled = await count("settled"); await new Promise(accept => setTimeout(accept, 1200));
  assert.equal(await count("settled"), settled, "Background output must not resume the agent");
  await prompt("Add history for native compaction.");
  output = ""; child.write("/compact\r");
  await wait("native compaction completes", () => /Compacted|compacted|tokens before|tokens/u.test(visible()) && !visible().includes("Compaction failed"));
  await reload(); process.kill(pid, 0);
  assert.equal((await persisted(service)).status, "started");
  const beforeTimed = await count("job"); child.write("Run a timed job.\r");
  await wait("timed process starts", async () => {
    const job = (await traces()).findLast(value => value.job?.name === "Terminal timed job")?.job;
    return Boolean(job && await count("job") > beforeTimed && /TIMED_LIVE \d+/u.test(await readFile(job.stdoutPath, "utf8").catch(() => "")));
  });
  const timed = await latest("Terminal timed job");
  child.write("\x1b");
  await wait("Escape deprecates timed job", async () => (await persisted(timed)).status === "deprecated");
  await reload(); process.kill(pid, 0);
  assert.equal((await persisted(timed)).terminationConfirmed, true);
  assert(visible().includes("node → Terminal timed job"));
  assert(!visible().includes("SHA-256 at launch:"), "Historical tool results stay compact after reload");
  await prompt("Create many panel jobs.");
  output = ""; child.resize(120, 100);
  await wait("collapsed eight-job panel", () => visible().includes("jobs · /node-scripts expand"));
  child.write("/node-scripts expand\r"); output = ""; child.resize(119, 100);
  const oldest = await latest("Stored terminal 0");
  await wait("expanded all-job panel", () => visible().includes(`[${oldest.id}] Stored terminal 0`));
  console.log("RENDER: " + visible().slice(visible().lastIndexOf("Node jobs"), visible().lastIndexOf("node-scripts:")));
  child.resize(60, 24); await new Promise(accept => setTimeout(accept, 100)); child.resize(120, 100);
  await prompt("Please deprecate the active worker.");
  assert.equal((await persisted(service)).status, "deprecated"); assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  assert(existsSync(service.stdoutPath));
  const launchHash = (await persisted(service)).scriptSha256AtStart;
  assert.match(launchHash ?? "", /^[0-9a-f]{64}$/u);
  await rm(join(service.workspace, service.scriptPath));
  await prompt("Do a source check.");
  const checked = await latest("Terminal service") as Query;
  assert.equal(checked.sourceState, "missing"); assert.equal(checked.scriptSha256AtStart, launchHash);
  await wait("compact source warning", () => visible().includes("Source missing"));
  child.write("/node-scripts off\r"); await wait("exact Powerline off label", () => /node-scripts:\s*off/u.test(visible()));
  await reload(); await wait("off survives reload", () => /node-scripts:\s*off/u.test(visible()));
  await prompt("Check guidance while disabled.");
  assert.equal((await traces()).findLast(value => value.event === "prompt")?.workspace, undefined);
  child.write("/node-scripts on\r"); await wait("on restored", () => /node-scripts:\s*on/u.test(visible()));
  await prompt("Run a background service.");
  const replaced = await latest("Terminal service");
  const startsBeforeNew = await count("start");
  output = ""; child.write("/new\r");
  await wait("new session deprecates the old background process", async () => await count("start") > startsBeforeNew);
  await wait("native new-session transition complete", () => visible().includes("New session started") && /node-scripts:\s*on/u.test(visible()));
  assert.equal((await persisted(replaced)).status, "deprecated");
  assert.equal((await persisted(replaced)).terminationConfirmed, true);
  assert(existsSync(replaced.stdoutPath));
  await prompt("Run a background service."); const quitting = await latest("Terminal service");
  child.write("/quit\r");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>((_accept, reject) => { timer = setTimeout(() => reject(new Error("Graceful quit timed out")), 10000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(exit?.exitCode, 0); assert.equal((await persisted(quitting)).status, "deprecated");
  assert.notEqual(quitting.workspace, replaced.workspace, "A new session needs a different consistent workspace");
  const promptWorkspaces = (await traces()).filter(value => value.event === "prompt").map(value => value.workspace);
  assert(promptWorkspaces.includes(replaced.workspace) && promptWorkspaces.includes(quitting.workspace));
  assert(!(await traces()).some(value => value.event === "network" || value.error));
  console.log("PASS: actual Pi TUI; exact node-scripts Powerline labels; service output and panel; no callback turns; compaction/reload continuity; timed Escape/deprecation; eight-row/expanded selection; resize; retained logs; off/on/reload; native new-session isolation/deprecation; graceful quit");
} catch (error) {
  console.error(JSON.stringify({ phase, failure: error instanceof Error ? error.message : "unknown", exit, trace: (await traces()).slice(-8), tail: stripVTControlCharacters(output).slice(-5000) })); throw error;
} finally {
  clearInterval(heartbeat);
  if (terminal && !exit) {
    terminal.write("\x1b");
    await new Promise(accept => setTimeout(accept, 100));
    terminal.write("/quit\r");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<void>(accept => { timer = setTimeout(accept, 10000); })]); }
    finally { clearTimeout(timer); }
    if (!exit) { terminal.kill(); if (exited) await exited; }
  }
  for (const value of await traces()) if (value.job && existsSync(join(value.job.workspace, "jobs", `${value.job.id}.json`))) {
    const job = JSON.parse(await readFile(join(value.job.workspace, "jobs", `${value.job.id}.json`), "utf8")) as Job;
    assert(job.status !== "started" && job.terminationConfirmed !== false, "Unresolved terminal job evidence must remain");
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(root));
  console.log("CLEANUP: terminal session, owned processes and isolated fixture removed");
}
// ConPTY can keep its host handles open after the child has exited and evidence cleanup is complete.
await new Promise<void>(accept => process.stdout.write("", () => accept()));
process.exit(0);
