import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { IPty } from "node-pty";
import type { TuiTrace } from "./tests/tui-fixture.ts";

async function main(): Promise<void> {
  const [installation, ptyDirectory, footerDirectory] = process.argv.slice(2);
  assert(installation && ptyDirectory && footerDirectory && process.argv.length === 5,
    "Usage: node verify-tui.ts <installed-pi-package-directory> <node-pty-directory> <powerline-directory>");
  const require = createRequire(import.meta.url);
  // The verifier uses an existing terminal driver. CodeAnchor does not depend on it at runtime.
  const pty = require(resolve(ptyDirectory)) as typeof import("node-pty");
  const root = dirname(fileURLToPath(import.meta.url));
  const packageInfo = JSON.parse(await readFile(join(installation, "package.json"), "utf8")) as { name: string; bin: { pi: string } };
  assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
  const temporary = await mkdtemp(join(tmpdir(), "code-anchor-tui-"));
  let terminal: IPty | undefined;
  let exit: { exitCode: number } | undefined;
  let exited: Promise<void> | undefined;
  let phase = "starting actual Pi in a pseudoterminal";
  let output = "";
  let bytes = 0;
  let terminalOutput: ReturnType<IPty["onData"]> | undefined;
  let terminalExit: ReturnType<IPty["onExit"]> | undefined;
  const heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] CodeAnchor TUI: ${phase}; ${bytes} terminal bytes\n`);
  }, 20_000);
  try {
    const agent = join(temporary, "agent");
    const workspace = join(temporary, "workspace");
    await mkdir(join(agent, "extensions"), { recursive: true });
    await symlink(root, join(agent, "extensions", "code-anchor"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(workspace);
    await writeFile(join(workspace, "fixture.ts"), "// terminal fixture\nconsole.log(before);\n");
    const foldedSource = Array.from({ length: 40 }, (_, index) => `console.log("${index === 39 ? "FOLD_UI_TAIL" : `row_${index}`} ${"界".repeat(20)}");`).join("\n") + "\n";
    await writeFile(join(workspace, "fold.ts"), foldedSource);
    await writeFile(join(agent, "settings.json"), JSON.stringify({
      packages: [], extensions: ["-builtin:mcp"], defaultProvider: "code-anchor-tui-fixture", defaultModel: "fixture",
      defaultTools: ["write", "grep", "find", "ls"],
      compaction: { enabled: false }, cacheWarming: "off", quietStartup: true, retry: { enabled: false },
      powerline: {
        welcome: false, git: { polling: "off" }, autoFollowUp: false,
        customItems: [{ id: "code_anchor", statusKey: "code-anchor", position: "left", color: "muted" }],
        layout: { left: ["model", "custom:code_anchor", "path"], right: [] },
      },
    }));
    terminal = pty.spawn(process.execPath, [
      resolve(installation, packageInfo.bin.pi), "--offline", "--no-approve", "--no-mcp", "--no-session",
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--extension", resolve(footerDirectory),
      "--extension", join(root, "tests", "tui-fixture.ts"),
    ], {
      cols: 120, rows: 36, cwd: workspace, name: "xterm-256color",
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, CODE_ANCHOR_TUI_DIRECTORY: workspace, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_PROGRAM_STATUS: "0", TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const child = terminal;
    exited = new Promise<void>(accept => {
      terminalExit = child.onExit(event => { exit = event; accept(); });
    });
    terminalOutput = child.onData(data => {
      bytes += Buffer.byteLength(data);
      output = (output + data).slice(-1_000_000);
      // A basic terminal answers device and cursor queries. These are not user commands.
      if (data.includes("\x1b[c") || data.includes("\x1b[0c")) child.write("\x1b[?1;2c");
      if (data.includes("\x1b[6n")) child.write("\x1b[1;1R");
    });
    const trace = async (): Promise<TuiTrace[]> => {
      const text = await readFile(join(workspace, "trace.jsonl"), "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
      });
      // The fixture owns this JSONL contract. Ignore only a row still being written.
      return text.split("\n").slice(0, -1).map(line => JSON.parse(line) as TuiTrace);
    };
    const wait = async (label: string, predicate: () => Promise<boolean> | boolean): Promise<void> => {
      phase = label;
      const deadline = Date.now() + 20_000;
      while (!await predicate()) {
        assert(!exit, `${label}: Pi exited unexpectedly`);
        assert(Date.now() < deadline, `${label}: timed out; terminal diagnostics withheld`);
        await new Promise(accept => setTimeout(accept, 25));
      }
    };
    const visible = (): string => stripVTControlCharacters(output);
    const checkpoint = async (name: string): Promise<TuiTrace> => {
      child.write(`/terminal-checkpoint ${name}\r`);
      await wait(`waiting for ${name} checkpoint`, async () => (await trace()).some(event => event.event === "checkpoint" && event.phase === name));
      const result = (await trace()).findLast(event => event.event === "checkpoint" && event.phase === name);
      assert(result);
      return result;
    };
    const prompt = async (name: string): Promise<void> => {
      const count = (await trace()).filter(event => event.event === "settled").length;
      child.write(`fixture:${name}\r`);
      await wait(`executing ${name} with actual TUI tools`, async () => (await trace()).filter(event => event.event === "settled").length > count);
      await wait(`rendering ${name} result`, () => visible().includes(`FIXTURE_DONE_${name}`));
      assert(!(await trace()).some(event => event.event === "tool_end" && event.error));
    };
    await wait("waiting for actual TUI startup", async () => (await trace()).some(event => event.event === "session_start"));
    const start = (await trace()).find(event => event.event === "session_start");
    assert.equal(start?.mode, "tui");
    await wait("rendering the default-on Powerline status", () => /code-anchor:\s*on/u.test(visible()));
    assert((await checkpoint("on")).tools?.includes("ast_grep"));
    await prompt("hashline");
    assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.log(after);\n");
    assert(visible().includes("fixture.ts"));
    output = "";
    await prompt("fold");
    assert(!visible().includes("FOLD_UI_TAIL"), "Collapsed read/edit must not display distant source rows");
    assert(visible().includes("hashline_edit fold.ts"), "The hashline edit header must show its target path");
    output = "";
    child.write("\x0f");
    assert.equal((await checkpoint("expanded")).expanded, true);
    await wait("expanding actual read/edit results", () => visible().includes("FOLD_UI_TAIL"));
    output = "";
    child.write("\x0f");
    assert.equal((await checkpoint("collapsed")).expanded, false);
    assert(!visible().includes("FOLD_UI_TAIL"), "The expansion shortcut must collapse read/edit output again");
    assert.equal(await readFile(join(workspace, "fold.ts"), "utf8"), foldedSource.replaceAll("console.log", "console.warn"));
    await prompt("preview");
    assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nconsole.log(after);\n");
    await prompt("resolve");
    assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nlogger.info(after);\n");
    child.write("/code-anchor off\r");
    const off = (await checkpoint("off")).tools ?? [];
    for (const name of ["read", "edit", "hashline_read", "hashline_edit", "ast_grep", "ast_edit"]) assert(!off.includes(name));
    await wait("rendering the off Powerline status", () => /code-anchor:\s*off/u.test(visible()));
    child.write("/reload\r");
    await wait("reloading the actual terminal runtime", async () => (await trace()).filter(event => event.event === "session_start").length >= 2);
    assert(!(await checkpoint("reloaded")).tools?.includes("ast_edit"));
    child.write("/terminal-native-tools\r");
    const explicitNative = (await checkpoint("native-explicit")).tools ?? [];
    assert(explicitNative.includes("read") && explicitNative.includes("edit"));
    await prompt("builtin");
    assert.equal(await readFile(join(workspace, "fixture.ts"), "utf8"), "// terminal fixture\nlogger.warn(after);\n");
    const beforeResize = bytes;
    child.resize(60, 24);
    await wait("redrawing at a narrow terminal size", () => bytes > beforeResize);
    assert.equal((await checkpoint("narrow")).mode, "tui");
    child.resize(120, 36);
    child.write("/code-anchor on\r");
    const enabled = (await checkpoint("enabled")).tools ?? [];
    assert(enabled.includes("ast_edit") && enabled.includes("hashline_read") && !enabled.includes("read") && !enabled.includes("edit"));
    await prompt("raw");
    const events = await trace();
    assert(!events.some(event => event.event === "network_attempt"));
    assert(events.some(event => event.event === "session_shutdown" && event.reason === "reload"));
    assert(events.some(event => event.event === "tool_end" && event.name === "hashline_read" && event.text?.includes("[fixture.ts#")));
    assert(events.some(event => event.event === "tool_end" && event.name === "hashline_read" && event.text === "// terminal fixture\nlogger.warn(after);\n"));
    phase = "quitting the real terminal session";
    child.write("/quit\r");
    await wait("waiting for graceful terminal shutdown", () => exit !== undefined);
    assert.equal(exit?.exitCode, 0);
    assert((await trace()).some(event => event.event === "session_shutdown" && event.reason === "quit"));
    console.log("PASS: actual Pi TUI, automatic discovery, compact read/edit, keyboard expand/collapse, hashline and AST tools, Powerline on/off, reload, built-in restoration, resize, re-enable, and graceful shutdown; zero network requests");
  } catch (error) {
    console.error(JSON.stringify({ phase, terminalBytes: bytes, exitCode: exit?.exitCode, failure: error instanceof assert.AssertionError ? error.message : "Terminal verification failed; diagnostics withheld" }));
    throw error;
  } finally {
    clearInterval(heartbeat);
    try {
      if (terminal && !exit) {
        terminal.kill();
        if (exited) await exited;
      }
      terminalOutput?.dispose();
      terminalExit?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
      assert(!existsSync(temporary));
      console.log("CLEANUP: terminal child stopped and owned fixtures removed");
    }
  }
}

// The installed Windows terminal driver can retain handles after its child exits.
// Exit only after observing child shutdown and completing the owned cleanup above.
let status = 0;
try { await main(); }
catch { status = 1; }
await new Promise<void>(accept => process.stdout.write("", () => accept()));
process.exit(status);
