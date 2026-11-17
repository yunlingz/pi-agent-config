import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { IPty } from "node-pty";
import type { TerminalTrace } from "./tui-fixture.ts";

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
try {
  await mkdir(join(agent, "extensions"), { recursive: true });
  const root = dirname(fileURLToPath(import.meta.url));
  await symlink(root, join(agent, "extensions", "temp-scripts"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(workspace);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: ["-builtin:mcp"], defaultProvider: "scripts-terminal-fixture", defaultModel: "fixture", quietStartup: true, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", powerline: { welcome: false, autoFollowUp: false, git: { polling: "off" }, customItems: [{ id: "temp_scripts", statusKey: "temp-scripts", position: "left", color: "muted" }], layout: { left: ["custom:temp_scripts", "path"], right: [] } } }));
  const info = JSON.parse(await readFile(join(installation, "package.json"), "utf8")) as { bin: { pi: string } };
  terminal = pty.spawn(process.execPath, [resolve(installation, info.bin.pi), "--offline", "--no-approve", "--no-mcp", "--no-session", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "--extension", resolve(footerDirectory), "--extension", join(root, "tui-fixture.ts"), "--tui-mode", "fullscreen"], {
    cols: 120, rows: 36, cwd: workspace, name: "xterm-256color", env: { ...process.env, PI_CODING_AGENT_DIR: agent, TEMP_SCRIPTS_TUI_DIRECTORY: workspace, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_PROGRAM_STATUS: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
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
  assert(!(await traces()).some(value => value.event === "settled"));
  await wait("updating elapsed time while running", () => /elapsed 1\.\ds/u.test(visible()));
  await wait("showing stderr and final output", () => visible().includes("TUI_STDERR") && visible().includes("TUI_LATE"));
  await wait("settled terminal run", async () => (await traces()).some(value => value.event === "settled"));
  child.write("\x0f");
  assert.equal((await checkpoint())?.expanded, true);
  child.resize(60, 24);
  await checkpoint();
  child.resize(120, 36);
  output = "";
  child.write("/temp-scripts off\r");
  assert(!(await checkpoint())?.tools?.includes("script_inline"));
  await wait("off Powerline status", () => /scripts:\s*off/u.test(visible()));
  child.write("/reload\r");
  await wait("restoring disabled state after reload", async () => (await traces()).filter(value => value.event === "start").length >= 2);
  assert(!(await checkpoint())?.tools?.includes("script_inline"));
  output = "";
  child.write("/temp-scripts on\r");
  assert((await checkpoint())?.tools?.includes("script_inline"));
  await wait("restoring on Powerline status", () => /scripts:\s*on/u.test(visible()));
  child.write("/quit\r");
  phase = "waiting for graceful terminal shutdown";
  let quitTimer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>((_accept, reject) => { quitTimer = setTimeout(() => reject(new Error("Terminal shutdown timed out")), 10000); })]); }
  finally { clearTimeout(quitTimer); }
  assert.equal(exit?.exitCode, 0);
  assert(!(await traces()).some(value => value.event === "network" || value.error));
  console.log("PASS: actual Pi TUI; stdout/stderr before completion; elapsed clock; narrow resize; expansion; Powerline on/off; reload; re-enable; graceful shutdown; zero network");
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
