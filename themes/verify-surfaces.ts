import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Terminal as Emulator } from "@xterm/xterm";
import type { Terminal } from "@earendil-works/pi-tui";
import { readJson } from "../scripts/verification-data.ts";

export async function verifySurfaces(packageDirectory: string): Promise<void> {
  const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const require = createRequire(join(agentDirectory, "npm/package.json"));
  const { Terminal: Xterm } = require("@xterm/xterm") as typeof import("@xterm/xterm");
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
  const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") = await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/theme/theme.js")).href);
  const saved = readJson<{ powerline: unknown }>(join(agentDirectory, "settings.json"));
  const root = await mkdtemp(join(tmpdir(), "pi-surface-ui-"));
  let mode: InstanceType<typeof sdk.InteractiveMode> | undefined;
  let runtime: InstanceType<typeof sdk.AgentSessionRuntime> | undefined;
  let emulator: Emulator | undefined;
  const pause = () => new Promise<void>(done => setTimeout(done, 60));
  try {
    globalThis.fetch = async () => { throw new Error("The surface fixture must not use the network."); };
    for (const layout of ["regular", "fullscreen"] as const) {
      for (const terminalBackground of ["#000000", "#ffffff"]) {
        const agent = join(root, `${layout}-${terminalBackground.slice(1)}`);
        await mkdir(join(agent, "themes"), { recursive: true });
        await mkdir(join(agent, "extensions/powerline-footer"), { recursive: true });
        await writeFile(join(agent, "themes/ci_dark.json"), await readFile(join(agentDirectory, "themes/ci_dark.json")));
        await writeFile(join(agent, "extensions/powerline-footer/theme.json"), await readFile(join(agentDirectory, "extensions/powerline-footer/theme.json")));
        await symlink(join(agentDirectory, "bin"), join(agent, "bin"));
        const settings = sdk.SettingsManager.inMemory({
          theme: "ci_dark", quietStartup: true, cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
          packages: [], terminal: { trueColor: true, images: false }, defaultTools: ["read", "write", "edit", "bash"],
        });
        await writeFile(join(agent, "settings.json"), JSON.stringify({ workingVibe: "off", powerline: saved.powerline }));
        process.env.PI_CODING_AGENT_DIR = agent;
        const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null,
          modelsStorePath: join(agent, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
        modelRuntime.registerProvider("surface-fixture", {
          api: "openai-responses", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
          models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        });
        const model = modelRuntime.getModel("surface-fixture", "fixture");
        assert(model);
        let starts = 0;
        const services = await sdk.createAgentSessionServices({ cwd: agent, agentDir: agent, modelRuntime, settingsManager: settings,
          resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
            extensionFactories: [pi => { pi.on("session_start", () => { starts++; }); }],
            disabledBuiltinExtensions: ["mcp"], additionalExtensionPaths: [
              join(agentDirectory, "npm/node_modules/pi-powerline-footer/index.ts"),
              join(agentDirectory, "extensions/ci-dark/index.ts"),
            ] } });
        assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
        const manager = sdk.SessionManager.inMemory(agent);
        manager.appendMessage({ role: "user", content: "USER_SURFACE", timestamp: 1 });
        manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2,
          stopReason: "stop", content: [{ type: "thinking", thinking: "THINKING_SURFACE" }, { type: "text", text: "## Heading\n\nBODY_SURFACE and `inline code`.\n\n```ts\nconst color = true;\n```" }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        runtime = await sdk.createAgentSessionRuntime(async options => ({
          ...await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, model, thinkingLevel: "xhigh" }),
          services, diagnostics: services.diagnostics,
        }), { cwd: agent, agentDir: agent, sessionManager: manager });
        emulator = new Xterm({ cols: 100, rows: 36, allowProposedApi: true,
          theme: { background: terminalBackground, foreground: terminalBackground === "#ffffff" ? "#000000" : "#ffffff" } });
        const screen = emulator;
        const writes: string[] = [];
        let input: ((data: string) => void) | undefined;
        let resize: (() => void) | undefined;
        let columns = 100;
        const terminal: Terminal = {
          start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {}, async drainInput() {},
          write(data) { writes.push(data); }, get columns() { return columns; }, rows: 36, kittyProtocolActive: false,
          moveBy(lines) { writes.push(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`); },
          hideCursor() {}, showCursor() {}, clearLine() { writes.push("\x1b[K"); }, clearFromCursor() { writes.push("\x1b[J"); },
          clearScreen() { writes.push("\x1b[2J\x1b[H"); }, setTitle() {}, setProgress() {}, setProgramStatus() {},
        };
        const originalWrite = terminal.write;
        mode = new sdk.InteractiveMode(runtime, { terminal, tuiMode: layout });
        await mode.init();
        input?.("INPUT_SURFACE");
        await pause();
        const flush = async () => {
          const data = writes.splice(0).join("");
          await new Promise<void>(done => screen.write(data, done));
        };
        await flush();
        const snapshot = () => Array.from({ length: screen.buffer.active.length }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? "");
        const checkEditor = () => {
          const lines = snapshot();
          assert(lines.some(line => line.includes("BODY_SURFACE")) && lines.some(line => line.includes("INPUT_SURFACE")), "The actual UI must render chat and editor text.");
          const row = lines.findIndex(line => line.includes("INPUT_SURFACE"));
          const column = lines[row].indexOf("INPUT_SURFACE");
          const line = screen.buffer.active.getLine(row);
          assert(line);
          assert.equal(line.getCell(column)?.getFgColor(), 0xf6f8fa, "Editor text must use ci_dark, not terminal defaults.");
          assert.equal(line.getCell(column)?.getBgColor(), 0x24292e, "Editor background must use ci_dark.");
        };
        checkEditor();
        for (let row = 0; row < screen.rows; row++) {
          const line = screen.buffer.active.getLine(screen.buffer.active.viewportY + row);
          assert(line);
          for (let column = 0; column < screen.cols; column++) {
            assert(line.getCell(column)?.isBgRGB(), "Every visible cell must have an explicit theme background.");
          }
        }
        columns = 80;
        screen.resize(80, 36);
        resize?.();
        await pause();
        await flush();
        checkEditor();
        assert(themeApi.setTheme("dark", false).success);
        await pause();
        await flush();
        assert(themeApi.setTheme("ci_dark", false).success);
        await pause();
        await flush();
        checkEditor();
        const themePath = join(agent, "themes/ci_dark.json");
        const originalTheme = await readFile(themePath, "utf8");
        await writeFile(themePath, originalTheme.replace('"background": "#24292e"', '"background": "#202020"'));
        // setTheme(name) reuses the registry; the host's watcher reloads a fresh instance from disk.
        themeApi.setThemeInstance(themeApi.loadThemeFromPath(themePath));
        await pause();
        await flush();
        const changedLines = snapshot();
        const changedRow = changedLines.findIndex(line => line.includes("INPUT_SURFACE"));
        const changedColumn = changedLines[changedRow].indexOf("INPUT_SURFACE");
        assert.equal(screen.buffer.active.getLine(changedRow)?.getCell(changedColumn)?.getBgColor(), 0x202020, "Reloading the same theme name must update its surface defaults.");
        await writeFile(themePath, originalTheme);
        themeApi.setThemeInstance(themeApi.loadThemeFromPath(themePath));
        await pause();
        await flush();
        checkEditor();
        mode.clearEditor();
        const previousStarts = starts;
        input?.("/reload");
        input?.("\r");
        const deadline = Date.now() + 15_000;
        while (starts === previousStarts) {
          assert(Date.now() < deadline, "Reload must bind a new extension runtime.");
          await pause();
        }
        await pause();
        input?.("INPUT_SURFACE");
        await pause();
        await flush();
        checkEditor();
        mode.clearEditor();
        input?.("/settings");
        input?.("\r");
        await pause();
        await flush();
        assert(snapshot().some(line => /Theme/iu.test(line)), "The actual settings selector must render.");
        input?.("\x1b");
        await pause();
        mode.stop();
        await runtime.dispose();
        assert.equal(terminal.write, originalWrite, "Shutdown must restore the original terminal transport.");
        runtime = undefined;
        mode = undefined;
        themeApi.stopThemeWatcher();
        emulator.dispose();
        emulator = undefined;
        console.log(`PASS: ${layout}; terminal ${terminalBackground}; actual chat/editor/Powerline, explicit cell backgrounds, resize, theme refresh, reload, settings, and restored transport.`);
      }
    }
  } finally {
    mode?.stop();
    if (runtime) await runtime.dispose();
    emulator?.dispose();
    themeApi.stopThemeWatcher();
    globalThis.fetch = originalFetch;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(root));
  }
}
