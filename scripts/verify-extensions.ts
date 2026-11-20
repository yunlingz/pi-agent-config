import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageInfo } from "./verification-data.ts";

const [packageArgument, mode = "offline", modelOverride] = process.argv.slice(2);
assert(packageArgument && ["offline", "live"].includes(mode) && process.argv.length <= 5,
  "Usage: node scripts/verify-extensions.ts <installed-pi-package-directory> [offline|live] [provider/model]");
assert(mode === "live" || modelOverride === undefined, "Model overrides apply only to explicit live verification");
const packageDirectory = resolve(packageArgument);
assert.equal(readPackageInfo(join(packageDirectory, "package.json")).name, "@earendil-works/pi-coding-agent");
const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = mode === "offline" ? [
  { name: "unit tests", args: ["--test",
    "extensions/token-usage/token-usage.test.ts",
    "extensions/web-search/web-search.test.ts", "extensions/code-anchor/controls.test.ts",
    "extensions/code-anchor/file-tracking.test.ts", "extensions/node-scripts/node-scripts.test.ts",
    "extensions/code-anchor/wasm.test.ts", "extensions/code-anchor/reference-fixtures.test.ts",
    "scripts/verification-data.test.ts",
    "scripts/live-verification.test.ts", "skills/sync-pi-config/scripts/verify.test.ts"] },
  ...["compact-quit/verify-integration.ts", "token-usage/verify-integration.ts", "web-search/verify-integration.ts",
    "code-anchor/verify-integration.ts", "code-anchor/verify-tool-policy.ts", "node-scripts/verify-integration.ts"]
    .map((script) => ({ name: script, args: [`extensions/${script}`, packageDirectory] })),
] : ["compact-quit/verify-live.ts", "web-search/verify-live.ts"]
  .map((script) => ({ name: script, args: [`extensions/${script}`, packageDirectory, ...(modelOverride ? [modelOverride] : [])] }));
let child: ChildProcess | undefined;
let phase = "starting";
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Plugin verification: ${phase}\n`);
}, 20_000);
try {
  for (const check of checks) {
    phase = check.name;
    console.log(`START: ${mode}; ${phase}`);
    child = spawn(process.execPath, check.args, {
      cwd: agentDirectory, shell: false, stdio: "inherit",
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    });
    const processChild = child;
    const timeout = setTimeout(() => processChild.kill("SIGKILL"), mode === "live" ? 330_000 : 90_000);
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        processChild.once("error", reject);
        processChild.once("close", resolveExit);
      });
      assert.equal(code, 0, `${phase} failed; dependent verification stopped`);
    } finally {
      clearTimeout(timeout);
    }
  }
  console.log(`SUCCESS: ${mode} plugin verification passed`);
} finally {
  clearInterval(heartbeat);
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolveClose) => child?.once("close", () => resolveClose()));
    child.kill("SIGKILL");
    await closed;
  }
}
