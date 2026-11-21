import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import type { ReadLiveAudit } from "./read-live-observer.ts";
import { assertMcpDisabled, validateConfig } from "../../skills/sync-pi-config/scripts/verify.ts";
import { parseTrustedJson, readJson } from "../../scripts/verification-data.ts";

const installation = process.argv[2];
assert(installation, "Usage: node verify-read-live.ts <installed-pi-package-directory>");
const packageDirectory = resolve(installation);
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(pathToFileURL(join(packageDirectory, "dist/index.js")).href);
const info = readJson<{ name: string; bin: { pi: string } }>(join(packageDirectory, "package.json"));
assert.equal(info.name, "@earendil-works/pi-coding-agent");
const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const settings = await validateConfig(agentDirectory, packageDirectory);
assertMcpDisabled(settings);
assert(settings.defaultProvider && settings.defaultModel);
const effort = settings.modelThinkingLevels?.[`${settings.defaultProvider}/${settings.defaultModel}`] ?? settings.defaultThinkingLevel;
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-read-live-"));
const auditPath = join(temporary, "audit.jsonl");
let client: RpcClient | undefined;
try {
  await mkdir(join(temporary, "reader-live-fixture"));
  const skillPath = join(temporary, "reader-live-fixture/SKILL.md");
  await writeFile(skillPath, "---\nname: reader-live-fixture\ndescription: Complete the requested file-reader parity check.\n---\n\nUse hashline_read to open AGENTS.md in the current directory.\nUse hashline_read to read the first line of the supplied Pi model documentation file.\nReply with the marker from AGENTS.md, then |, then the documentation heading.\nDo not change files, search, or use native read.\n");
  const marker = `READ_PARITY_${randomUUID()}`;
  await writeFile(join(temporary, "AGENTS.md"), `# Read parity fixture\n${marker}\n`);
  const image = Buffer.alloc(54 + 16 * 16 * 3);
  image.write("BM"); image.writeUInt32LE(image.length, 2); image.writeUInt32LE(54, 10); image.writeUInt32LE(40, 14);
  image.writeInt32LE(16, 18); image.writeInt32LE(16, 22); image.writeUInt16LE(1, 26); image.writeUInt16LE(24, 28);
  await writeFile(join(temporary, "color.bmp"), image);
  client = new sdk.RpcClient({ cliPath: join(packageDirectory, info.bin.pi), cwd: temporary,
    env: { PI_CODING_AGENT_DIR: agentDirectory, CODE_ANCHOR_READ_AUDIT: auditPath, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    args: ["--no-session", "--no-mcp", "--offline", "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--skill", skillPath, "--extension", join(dirname(fileURLToPath(import.meta.url)), "read-live-observer.ts"), "--tools", "hashline_read"],
  });
  await client.start();
  const state = await client.getState();
  assert.equal(state.model?.provider, settings.defaultProvider);
  assert.equal(state.model?.id, settings.defaultModel);
  assert.equal(state.thinkingLevel, effort);
  console.log(`START: actual Pi CLI read parity on ${settings.defaultProvider}/${settings.defaultModel}; effort ${effort}`);
  const first = await client.promptAndWait(`This is a read-only Pi file-reader compatibility test. Use the reader-live-fixture skill. The Pi documentation file is ${join(sdk.getDocsPath(), "models.md")}. Return only the exact result specified by the skill.`, undefined, 90000);
  for (const event of first) {
    if (event.type === "tool_execution_end") assert.equal(event.isError, false, "All live parity reads must succeed");
    if (event.type === "message_end" && event.message.role === "assistant") assert(!["error", "aborted", "length"].includes(event.message.stopReason));
  }
  for (const filename of ["SKILL.md", "AGENTS.md", "models.md"]) {
    assert(first.some(event => event.type === "tool_execution_start" && event.toolName === "hashline_read" && typeof event.args.path === "string" && event.args.path.includes(filename)), `Missing live ${filename} read`);
  }
  assert.equal((await client.getLastAssistantText())?.trim(), `${marker}|# Choose a Model`);
  const second = await client.promptAndWait("Use hashline_read to inspect color.bmp. Name the center color as exactly one of BLACK, WHITE, RED, BLUE. Reply with only the color.", undefined, 90000);
  assert(second.some(event => event.type === "tool_execution_end" && event.toolName === "hashline_read" && !event.isError));
  assert.equal((await client.getLastAssistantText())?.trim(), "BLACK");
  const records = (await readFile(auditPath, "utf8")).trim().split("\n").map(parseTrustedJson<ReadLiveAudit>);
  const requests = records.filter(record => record.type === "request");
  assert(requests.length > 0 && requests.every(record => record.catalog), "The actual model must see the available skill catalog");
  assert(requests.some(record => record.imageInput), "The image attachment must reach the actual provider payload");
  assert(records.filter(record => record.type === "tool").every(record => record.tool === "hashline_read" && record.succeeded));
  assert.equal((await client.getState()).thinkingLevel, effort);
  assert.equal(client.getStderr().length, 0, "Pi emitted diagnostics; raw text withheld");
  console.log("PASS: skill catalog in real requests; skill/resource/internal-doc reads; exact marker and heading; image attachment and color; no native tools; unchanged effort");
} catch {
  throw new Error("Live Pi read parity failed; raw provider diagnostics withheld.");
} finally {
  if (client) await client.stop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  assert(!existsSync(temporary));
  console.log("CLEANUP: live Pi read parity process and temporary fixtures removed");
}
