import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHealthy, assertMcpDisabled, validateConfig,
  type VerificationEvent,
} from "../../skills/sync-pi-config/scripts/verify.ts";
import { parseTrustedJson, readJson } from "../../scripts/verification-data.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-live.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const packageInfo = readJson<{ name: string; bin: { pi: string } }>(join(packageDirectory, "package.json"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-live-"));
let phase = "starting read-only live verification";
let records = 0;
try {
  const marker = `CODE_ANCHOR_OK_${randomUUID()}`;
  await writeFile(join(temporary, "healthcheck.txt"), marker + "\n");
  const prompt = "This is a read-only CodeAnchor verification. Use hashline_read with path healthcheck.txt:raw. Reply with exactly the file contents, without formatting or commentary. Do not invoke skills or other tools.";
  console.log("START: CodeAnchor read-only live check; configured provider/model/reasoning; real requests can incur charges");
  const child = spawn(process.execPath, [resolve(packageDirectory, packageInfo.bin.pi), "--mode", "json", "--no-session", "--offline", "--no-approve", "--no-mcp", "--extension", join(extensionDirectory, "index.ts"), "--tools", "hashline_read", prompt], {
    cwd: temporary, shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  let pending = "";
  let diagnostics = 0;
  let invalidJson = false;
  let timedOut = false;
  const events: VerificationEvent[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      try {
        const event = parseTrustedJson<VerificationEvent>(line);
        records++;
        if (event.type !== "message_update") events.push(event);
      } catch { invalidJson = true; }
    }
  });
  child.stderr.on("data", (bytes: Buffer) => { diagnostics += bytes.length; });
  phase = "waiting for the configured model and read tool";
  const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] ${phase}; ${records} JSON records\n`), 20_000);
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90_000);
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    assert(!timedOut, "CodeAnchor live check exceeded 90 seconds");
    assert.equal(code, 0, "Pi live subprocess failed; raw diagnostics withheld");
    assert.equal(diagnostics, 0, "Unexpected Pi diagnostics; raw content withheld");
    assert.equal(invalidJson, false, "Pi did not emit valid JSONL");
    assert.equal(pending.length, 0, "Pi emitted incomplete JSONL");
    const model = assertHealthy(events, settings, marker);
    const read = events.find(event => event.type === "tool_execution_end" && event.toolName === "hashline_read");
    assert(read?.type === "tool_execution_end");
    assert(read.result.content.some(block => block.type === "text" && block.text.trim() === marker), "The CodeAnchor raw selector must return the marker without anchors");
    console.log(`PASS: CodeAnchor WASM read tool, raw selector, exact marker and settled lifecycle on ${model}; configured reasoning retained`);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(accept => child.once("close", () => accept()));
      child.kill("SIGKILL");
      await stopped;
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  assert.equal(existsSync(temporary), false);
  console.log("CLEANUP: live subprocess stopped and owned marker directory removed");
}
