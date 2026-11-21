import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { IPty } from "node-pty";
import type { TuiTrace } from "./tui-fixture.ts";

const [installation, ptyDirectory, footerDirectory] = process.argv.slice(2);
assert(installation && ptyDirectory && footerDirectory, "Usage: node verify-tui.ts <installed-pi-package-directory> <node-pty-directory> <powerline-directory>");
const require = createRequire(import.meta.url);
// This existing terminal driver is a verification resource, not a plugin dependency.
const pty = require(resolve(ptyDirectory)) as typeof import("node-pty");
const root = dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(await readFile(join(installation, "package.json"), "utf8")) as { name: string; bin: { pi: string } };
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const temporary = await mkdtemp(join(tmpdir(), "rw-hashline-tui-"));
let terminal: IPty | undefined;
let exitCode: number | undefined;
let exited: Promise<void> | undefined;
let output = "";
let phase = "starting";
try {
  const agent = join(temporary, "agent");
  const workspace = join(temporary, "workspace");
  await mkdir(join(agent, "extensions/rw-hashline"), { recursive: true });
  await writeFile(join(agent, "extensions/rw-hashline/index.ts"), `export { default } from ${JSON.stringify(join(root, "extension.ts"))};\n`);
  await mkdir(join(workspace, "skills/ui-fixture"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "# UI fixture\nRESOURCE_UI_MARKER\n");
  await writeFile(join(workspace, "skills/ui-fixture/SKILL.md"), "# UI skill\nSKILL_UI_MARKER\n");
  await writeFile(join(workspace, "fixture.ts"), "// terminal fixture\nconsole.log(before);\n");
  await writeFile(join(workspace, "fold.ts"), Array.from({ length: 40 }, (_, index) => `console.log("${index === 39 ? "FOLD_UI_TAIL" : `row_${index}`} ${"界".repeat(20)}");`).join("\n") + "\n");
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    packages: [], extensions: ["-builtin:mcp"], defaultProvider: "rw-hashline-tui", defaultModel: "fixture", defaultTools: ["write", "grep", "find", "ls"],
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", quietStartup: true,
    powerline: { welcome: false, git: { polling: "off" }, autoFollowUp: false, customItems: [{ id: "rw_hashline", statusKey: "rw-hashline", position: "left", color: "muted" }], layout: { left: ["model", "custom:rw_hashline", "path"], right: [] } },
  }));
  terminal = pty.spawn(process.execPath, [resolve(installation, packageInfo.bin.pi), "--offline", "--no-mcp", "--no-approve", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", resolve(footerDirectory), "--extension", join(root, "tui-fixture.ts")], {
    cols: 120, rows: 36, cwd: workspace, name: "xterm-256color",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, RW_HASHLINE_TUI_DIRECTORY: workspace, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_PROGRAM_STATUS: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const child = terminal;
  exited = new Promise<void>(accept => child.onExit(event => { exitCode = event.exitCode; accept(); }));
  child.onData(data => {
    output = (output + data).slice(-1_000_000);
    if (data.includes("\x1b[c") || data.includes("\x1b[0c")) child.write("\x1b[?1;2c");
    if (data.includes("\x1b[6n")) child.write("\x1b[1;1R");
  });
  const records = async (): Promise<TuiTrace[]> => {
    const text = await readFile(join(workspace, "trace.jsonl"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    return text.split("\n").slice(0, -1).map(line => JSON.parse(line) as TuiTrace);
  };
  const wait = async (label: string, predicate: () => boolean | Promise<boolean>) => {
    phase = label;
    const deadline = Date.now() + 20_000;
    while (!await predicate()) {
      assert.equal(exitCode, undefined, "The terminal exited unexpectedly.");
      assert(Date.now() < deadline, `${label} exceeded the terminal deadline.`);
      await new Promise<void>(accept => setTimeout(accept, 25));
    }
  };
  const visible = () => stripVTControlCharacters(output);
  const checkpoint = async (name: string) => {
    child.write(`/terminal-checkpoint ${name}\r`);
    await wait(name, async () => (await records()).some(record => record.event === "checkpoint" && record.phase === name));
    const record = (await records()).findLast(item => item.event === "checkpoint" && item.phase === name);
    assert(record); return record;
  };
  const prompt = async (name: string, expectedRejection = false) => {
    const previous = await records();
    const count = previous.filter(record => record.event === "settled").length;
    child.write(`fixture:${name}\r`);
    await wait(name, async () => (await records()).filter(record => record.event === "settled").length > count);
    await wait(`${name} render`, () => visible().includes(`FIXTURE_DONE_${name}`));
    const failures = (await records()).slice(previous.length).filter(record => record.event === "tool" && record.error);
    if (expectedRejection) assert(failures.length === 1 && failures[0]?.name === "hashline_edit");
    else assert.equal(failures.length, 0, "Unexpected tool failures must not be hidden.");
  };
  await wait("default-on Powerline", () => visible().includes("rw-hashline: on"));
  const on = await checkpoint("on");
  const onTools = on.tools;
  assert(onTools);
  assert(onTools.includes("hashline_read") && onTools.includes("hashline_edit"));
  assert(!onTools.some(name => ["read", "edit", "ast_grep", "ast_edit"].includes(name)));
  await prompt("resource"); assert(visible().includes("hashline_read resource AGENTS.md"));
  await prompt("skill"); assert(visible().includes("[skill] ui-fixture"));
  await prompt("docs"); assert(visible().includes("hashline_read docs docs/models.md"));
  await prompt("line"); assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.log(after);\n");
  assert(visible().includes("hashline_edit · lines"), "The UI must identify snapshot-checked line editing.");
  await prompt("second"); assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.warn(after);\n");
  output = ""; await prompt("rejected", true);
  assert(visible().includes("hashline_edit · lines"), "Rejected edits must keep their hashline header.");
  assert(!visible().split("\n").some(line => /^\s*edit\s/u.test(line)), "Native result rendering must not relabel a hashline call.");
  assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.warn(after);\n");
  await prompt("write"); assert.equal(await readFile(join(workspace, "written.md"), "utf8"), "WRITE_UI_MARKER\n");
  output = ""; await prompt("fold"); assert(!visible().includes("FOLD_UI_TAIL"));
  child.write("\x0f"); assert.equal((await checkpoint("expanded")).expanded, true);
  await wait("expanded native read", () => visible().includes("FOLD_UI_TAIL"));
  output = ""; child.write("\x0f"); assert.equal((await checkpoint("collapsed")).expanded, false);
  assert(!visible().includes("FOLD_UI_TAIL"));
  child.write("/rw-hashline off\r"); const off = await checkpoint("off");
  assert(off.tools?.includes("read") && off.tools.includes("edit") && !off.tools.includes("hashline_read"));
  await wait("off Powerline", () => visible().includes("rw-hashline: off"));
  child.write("/reload\r"); await wait("reload", async () => (await records()).filter(record => record.event === "start").length >= 2);
  assert((await checkpoint("reloaded")).tools?.includes("edit"));
  await prompt("native"); assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.info(after);\n");
  child.resize(60, 24); await checkpoint("narrow");
  child.resize(120, 36); child.write("/rw-hashline on\r");
  const restored = await checkpoint("restored"); assert(restored.tools?.includes("hashline_edit") && !restored.tools.includes("edit"));
  await wait("restored Powerline", () => visible().includes("rw-hashline: on"));
  child.write("/quit\r"); await wait("shutdown", () => exitCode !== undefined); assert.equal(exitCode, 0);
  console.log("PASS: actual Pi terminal; native read/write presentation; mandatory anchored edits and explicit line-mode headers; resource/skill/docs headers; keyboard expansion; Powerline on/off; reload; native restoration; resize; no AST tools; graceful shutdown");
} catch (error) {
  console.error(JSON.stringify({ phase, failure: error instanceof assert.AssertionError ? error.message : "Terminal check failed; raw diagnostics withheld." }));
  throw error;
} finally {
  if (terminal && exitCode === undefined) { terminal.kill(); if (exited) await exited; }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(temporary));
  console.log("CLEANUP: terminal stopped and task-owned fixtures removed");
}
