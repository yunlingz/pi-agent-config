import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { IPty } from "node-pty";
import type { TerminalTrace } from "./tui-fixture.ts";
import type { RunResult } from "./types.ts";

const [installation, ptyDirectory, footerDirectory] = process.argv.slice(2);
assert(installation && ptyDirectory && footerDirectory, "Usage: node verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>");
const pty = createRequire(import.meta.url)(resolve(ptyDirectory)) as typeof import("node-pty");
const temporary = await mkdtemp(join(tmpdir(), "temp-scripts-tui-"));
let terminal: IPty | undefined;
let exit: { exitCode: number } | undefined;
let exited: Promise<void> | undefined;
let output = "";
let phase = "starting actual Pi terminal";
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] Script terminal check: ${phase}\n`), 20_000);
const agent = join(temporary, "agent");
const workspace = join(temporary, "workspace");
const tracePath = join(workspace, "trace.jsonl");
const traces = async (): Promise<TerminalTrace[]> => {
  const text = await readFile(tracePath, "utf8").catch(() => "");
  return text.split("\n").slice(0, -1).map(line => JSON.parse(line) as TerminalTrace);
};
const assertServiceStopped = async (root: string) => {
  assert(!existsSync(join(root, "lease")), "Session transition must release the stopped service lease");
  const runs = await readdir(join(root, "runs"));
  assert.equal(runs.length, 1);
  const result = JSON.parse(await readFile(join(root, "runs", runs[0], "result.json"), "utf8")) as RunResult;
  assert.equal(result.status, "cancelled");
  assert(result.terminationConfirmed);
  const pid = /^PANEL_LIVE (\d+)$/mu.exec(result.output)?.[1];
  assert(pid, "Service output must identify the actual process");
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/u);
};
try {
  await mkdir(join(agent, "extensions"), { recursive: true });
  const root = dirname(fileURLToPath(import.meta.url));
  await symlink(root, join(agent, "extensions", "temp-scripts"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(workspace);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [resolve(footerDirectory)], extensions: ["-builtin:mcp"], defaultProvider: "scripts-terminal-fixture", defaultModel: "fixture", quietStartup: true, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", powerline: { welcome: false, autoFollowUp: false, git: { polling: "off" }, customItems: [{ id: "temp_scripts", statusKey: "temp-scripts", position: "left", color: "muted" }], layout: { left: ["custom:temp_scripts", "path"], right: [] } } }));
  const info = JSON.parse(await readFile(join(installation, "package.json"), "utf8")) as { bin: { pi: string } };
  terminal = pty.spawn(process.execPath, [resolve(installation, info.bin.pi), "--offline", "--no-approve", "--no-mcp", "--no-session", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "--extension", join(root, "tui-fixture.ts"), "--tui-mode", "fullscreen"], {
    cols: 120, rows: 36, cwd: workspace, name: "xterm-256color", env: { ...process.env, PI_TEMP_SCRIPTS_DIR:join(temporary,"script-storage"), PI_CODING_AGENT_DIR: agent, TEMP_SCRIPTS_TUI_DIRECTORY: workspace, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_PROGRAM_STATUS: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
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
    phase = label;
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      assert(!exit, `${label}: Pi exited`);
      assert(Date.now() < deadline, `${label}: timed out`);
      await new Promise(accept => setTimeout(accept, 25));
    }
  };
  const checkpoint = async () => {
    const count = (await traces()).filter(value => value.event === "checkpoint").length;
    child.write("/scripts-checkpoint\r");
    await wait("waiting for terminal checkpoint", async () => (await traces()).filter(value => value.event === "checkpoint").length > count);
    return (await traces()).findLast(value => value.event === "checkpoint");
  };
  await wait("default-on Powerline status", () => /scripts:\s*on/u.test(visible()));
  child.write("Run the terminal fixture.\r");
  await wait("showing stdout before completion", () => visible().includes("TUI_EARLY"));
  assert(visible().includes("Inline JS"));
  assert(visible().includes("INLINE_SOURCE_VISIBLE"));
  assert(visible().includes("Commands ("));
  await wait("adding the running job to the retention panel", () => /◐ Terminal streaming fixture \(running\)/u.test(visible()));
  assert(!(await traces()).some(value => value.event === "settled"));
  await wait("updating elapsed time while running", () => /elapsed 1\.\ds/u.test(visible()));
  await wait("showing stderr and final output", () => visible().includes("TUI_STDERR") && visible().includes("TUI_LATE"));
  await wait("settled terminal run", async () => (await traces()).some(value => value.event === "settled"));
  assert((await traces()).filter(value=>value.event==="job").every(value=>value.root && !existsSync(value.root)));
  child.resize(120,180); // Source and command details must fit when checking expansion, not be offscreen.
  await wait("showing successful inline cleanup",()=>visible().includes("temporary files removed"));
  child.write("\x0f");
  assert.equal((await checkpoint())?.expanded, true);
  await wait("inspecting inline source after disk cleanup",()=>visible().includes("INLINE_SOURCE_END"));
  child.resize(60, 24);
  await checkpoint();
  child.resize(120,180);
  child.write("\x0f");
  assert.equal((await checkpoint())?.expanded,false);
  const settledCount=(await traces()).filter(value=>value.event==="settled").length;
  child.write("Run the workspace fixture.\r");
  await wait("workspace and job mode headers",async()=> (await traces()).filter(value=>value.event==="settled").length>settledCount);
  assert(visible().includes("Workspace JS"));
  assert(visible().includes("Script job"));
  assert(visible().includes("WORKSPACE_SOURCE_VISIBLE"));
  assert((await traces()).filter(value=>value.event==="job").every(value=>value.root && !existsSync(value.root)));
  output = "";
  child.resize(121, 180);
  await wait("named workspace release header", () => /Script job · release · Terminal workspace/u.test(visible()));
  const beforeRetained = (await traces()).filter(value => value.event === "settled").length;
  child.write("Run the retention fixture.\r");
  await wait("showing a running retained helper", () => /◐ Terminal retained fixture \(running\)/u.test(visible()));
  await wait("keeping the retained job visible after success", async () => (await traces()).filter(value => value.event === "settled").length > beforeRetained);
  const retainedRoot = (await traces()).findLast(value => value.event === "job")?.root;
  assert(retainedRoot && existsSync(retainedRoot));
  output = "";
  child.resize(119, 60);
  await wait("retention panel above Powerline", () => visible().includes("Job retention (") && /scripts:\s*on/u.test(visible()));
  assert(visible().lastIndexOf("Job retention (") < visible().lastIndexOf("scripts:"));
  assert(/└─ ○ Terminal retained fixture \(retained\)/u.test(visible()), "The retained row must use the compact Todo-style layout");
  const retainedStarts = (await traces()).filter(value => value.event === "start").length;
  output = "";
  child.write("/reload\r");
  await wait("restoring retained jobs after reload", async () => (await traces()).filter(value => value.event === "start").length > retainedStarts);
  await wait("retained-job reload completed", () => visible().includes("Reloaded keybindings"));
  output = "";
  child.resize(118, 60);
  await wait("retention panel restored above Powerline", () => visible().includes("Job retention (") && /scripts:\s*on/u.test(visible()));
  assert(visible().lastIndexOf("Job retention (") < visible().lastIndexOf("scripts:"));
  const beforeRelease = (await traces()).filter(value => value.event === "settled").length;
  child.write("Please release retained records.\r");
  await wait("named release removes retained files", async () => (await traces()).filter(value => value.event === "settled").length > beforeRelease);
  assert(!existsSync(retainedRoot));
  output = "";
  child.resize(116, 100);
  await wait("named retained-job release header", () => /Script job · release · Terminal retained fixture/u.test(visible()));
  output = "";
  child.resize(117, 60);
  await wait("Powerline redraw after release", () => /scripts:\s*on/u.test(visible()));
  assert(!visible().includes("Job retention ("));
  output = "";
  child.write("/temp-scripts off\r");
  assert(!(await checkpoint())?.tools?.includes("script_inline"));
  await wait("off Powerline status", () => /scripts:\s*off/u.test(visible()));
  output = "";
  child.write("/reload\r");
  await wait("restoring disabled state after reload", async () => (await traces()).filter(value => value.event === "start").length >= 2);
  await wait("disabled-state reload completed", () => visible().includes("Reloaded keybindings"));
  assert(!(await checkpoint())?.tools?.includes("script_inline"));
  output = "";
  child.write("/temp-scripts on\r");
  assert((await checkpoint())?.tools?.includes("script_inline"));
  await wait("restoring on Powerline status", () => /scripts:\s*on/u.test(visible()));
  child.resize(100,40);
  const beforeService=(await traces()).filter(value=>value.event==="settled").length;
  child.write("Run the background fixture.\r");
  await wait("nonblocking background startup",async()=> (await traces()).filter(value=>value.event==="settled").length>beforeService);
  await wait("fixed background panel",()=>visible().includes("Background jobs")&&visible().includes("Fixed panel service")&&visible().includes("PANEL_LIVE"));
  const snapshotsBefore=(await traces()).filter(value=>value.event==="settled").length;
  output="";
  child.write("An unrelated query.\r");
  await wait("new user query while background work runs",async()=> (await traces()).filter(value=>value.event==="settled").length>snapshotsBefore);
  child.resize(99,40); // Force a full redraw; incremental terminal output need not repeat an unchanged panel heading.
  await wait("background panel stays near editor",()=>visible().includes("Background jobs"));
  await wait("both job panels remain above Powerline", () => visible().includes("Job retention (") && /scripts:\s*on/u.test(visible()));
  assert(visible().lastIndexOf("Background jobs (") < visible().lastIndexOf("scripts:"));
  assert(visible().lastIndexOf("Job retention (") < visible().lastIndexOf("scripts:"));
  console.log("RENDER: compact job panels\n" + visible().slice(visible().lastIndexOf("● Background jobs ("), visible().lastIndexOf("scripts:")));
  child.write("/script-jobs expand\r");
  await checkpoint();
  const starts=(await traces()).filter(value=>value.event==="start").length;
  output = "";
  child.write("/reload\r");
  await wait("background controller restored after reload",async()=> (await traces()).filter(value=>value.event==="start").length>starts);
  await wait("background reload completed", () => visible().includes("Reloaded keybindings"));
  await wait("fixed panel redraw after reload",()=>visible().includes("Background jobs"));
  const stopCount=(await traces()).filter(value=>value.event==="settled").length;
  child.write("Please stop service.\r");
  await wait("stopping service and releasing job",async()=> (await traces()).filter(value=>value.event==="settled").length>stopCount);
  assert((await traces()).filter(value=>value.event==="job").every(value=>value.root&&!existsSync(value.root)));
  const startService = async () => {
    const settled = (await traces()).filter(value => value.event === "settled").length;
    child.write("Run the background fixture.\r");
    await wait("starting service for a native session transition", async () => (await traces()).filter(value => value.event === "settled").length > settled);
    const root = (await traces()).findLast(value => value.event === "job")?.root;
    assert(root && existsSync(root));
    return root;
  };
  const replacedRoot = await startService();
  const beforeNew = (await traces()).filter(value => value.event === "start").length;
  child.write("/new\r");
  await wait("native session replacement stops active service", async () => (await traces()).filter(value => value.event === "start").length > beforeNew);
  await assertServiceStopped(replacedRoot);
  const quitRoot = await startService();
  child.write("/quit\r");
  phase = "waiting for graceful terminal shutdown";
  let quitTimer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>((_accept, reject) => { quitTimer = setTimeout(() => reject(new Error("Terminal shutdown timed out")), 10000); })]); }
  finally { clearTimeout(quitTimer); }
  assert.equal(exit?.exitCode, 0);
  await assertServiceStopped(quitRoot);
  assert(!(await traces()).some(value => value.event === "network" || value.error));
  console.log("PASS: actual Pi TUI; named release; Todo-style job trees; retention start/keep/release; both panels above Powerline after redraw/reload; source; streaming; resize/expansion; stop/release; native new-session and quit stop active services; zero network");
} catch (error) {
  console.error(JSON.stringify({ phase, traces: (await traces()).slice(-12), terminalTail: stripVTControlCharacters(output).slice(-6000) }));
  throw error;
} finally {
  clearInterval(heartbeat);
  if (terminal && !exit) { terminal.kill(); if (exited) await exited; }
  for (const value of await traces()) {
    if (value.event === "job" && value.root) {
      assert(!existsSync(join(value.root, "lease")), "Unresolved terminal job lease retained");
      await rm(value.root, { recursive: true, force: true });
      assert(!existsSync(value.root));
    }
  }
  await rm(temporary, { recursive: true, force: true });
  assert(!existsSync(temporary));
  console.log("CLEANUP: terminal child and owned jobs removed");
}
