import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { ProcessResult, Progress, RunStatus } from "./types.ts";
import { CommandLog } from "./commands.ts";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));

export function displayText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

async function stopTree(child: ChildProcess, exited: () => boolean, processGroup: boolean): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return true;
  if (!processGroup) {
    if (!exited()) child.kill("SIGTERM");
    const deadline = Date.now() + 500;
    while (!exited() && Date.now() < deadline) await delay(20);
    if (!exited()) child.kill("SIGKILL");
    const forced = Date.now() + 2000;
    while (!exited() && Date.now() < forced) await delay(20);
    return exited();
  }
  if (process.platform === "win32") {
    if (exited()) return true; // Detached descendants are unsupported; do not kill a saved PID after restart.
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" });
    const outcome = await new Promise<boolean>(accept => {
      const timer = setTimeout(() => { killer.kill(); accept(false); }, 3000);
      killer.once("error", () => { clearTimeout(timer); accept(false); });
      killer.once("close", code => { clearTimeout(timer); accept(code === 0); });
    });
    return outcome;
  }
  if (!groupExists(pid)) return true;
  try { process.kill(-pid, "SIGTERM"); } catch { /* Recheck the process group below. */ }
  const grace = Date.now() + 500;
  while (Date.now() < grace && groupExists(pid)) await delay(20);
  if (groupExists(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Absence is checked below. */ }
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && groupExists(pid)) await delay(20);
  return !groupExists(pid);
}

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  stdoutPath: string;
  stderrPath: string;
  stdin?: string;
  ipc?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  heartbeatMs?: number;
  maxLogBytes?: number;
  processGroup?: boolean;
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => Promise<void>;
  onSpawn?: () => void;
  untilStopped?: boolean;
}

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (options.timeoutSeconds === undefined ? !options.untilStopped : !Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0 || options.timeoutSeconds > 7 * 86400) {
    throw new Error("An explicit positive deadline (at most seven days) or authorized untilStopped execution is required");
  }
  if (!options.command || [options.command, options.cwd, ...options.args].some(value => value.includes("\0"))) {
    throw new Error("Executable, cwd, and arguments must be valid strings without NUL bytes");
  }
  options.signal?.throwIfAborted();
  const start = performance.now();
  let reason: RunStatus | undefined;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let bytes = 0;
  let tail = Buffer.alloc(0);
  let lastOutput: number | null = null;
  let scriptReport: string | undefined;
  let stopped: Promise<boolean> | undefined;
  let ioFailure = false;
  let launchError: string | undefined;
  const commands = new CommandLog();
  const stdout = createWriteStream(options.stdoutPath, { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(options.stderrPath, { flags: "wx", mode: 0o600 });
  const stdoutClosed = new Promise<void>(accept => stdout.once("close", accept));
  const stderrClosed = new Promise<void>(accept => stderr.once("close", accept));
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true,
    detached: options.processGroup !== false && process.platform !== "win32",
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(options.ipc ? ["ipc" as const] : [])],
  });
  let notifyStopped: () => void = () => {};
  const stopFinished = new Promise<void>(accept => { notifyStopped = accept; });
  const stop = (): Promise<boolean> => stopped ??= stopTree(child, () => exited, options.processGroup !== false).finally(notifyStopped);
  const failIO = () => { ioFailure = true; reason ??= "failed"; void stop(); };
  stdout.on("error", failIO);
  stderr.on("error", failIO);
  const completion = new Promise<void>(accept => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      launchError = error.code ?? "SPAWN_FAILED";
      stderr.write(`Process launch failed: ${launchError}\n`);
      reason ??= "failed";
      exited = true;
      accept();
    });
    child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; exited = true; accept(); });
  });
  child.once("spawn", () => { try { options.onSpawn?.(); } catch { failIO(); } });
  const report = () => {
    try {
      options.onProgress?.({ phase: "running", elapsedMs: performance.now() - start, outputBytes: bytes,
        lastOutputMs: lastOutput === null ? null : performance.now() - lastOutput, scriptReport, outputTail: displayText(tail.subarray(-8192).toString("utf8")), commands: commands.snapshot(), commandsTruncated: commands.truncated });
    } catch { /* A disconnected progress consumer must not leave the child running. */ }
  };
  const abort = () => { reason ??= "cancelled"; void stop(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(() => { reason ??= "timed_out"; void stop(); }, options.timeoutSeconds * 1000);
  const heartbeat = setInterval(report, options.heartbeatMs ?? 1000);
  let lastProgressAt = -Infinity;
  let lastOutputUpdate = -Infinity;
  child.on("message", (value: unknown) => {
    if (value !== null && typeof value === "object" && "type" in value && value.type === "progress" && "message" in value && typeof value.message === "string") {
      scriptReport = displayText(value.message).slice(0, 500);
      if (performance.now() - lastProgressAt >= 500) { lastProgressAt = performance.now(); report(); }
    }
    if (value !== null && typeof value === "object" && "type" in value && value.type === "command" && "event" in value) {
      commands.append(value.event);
      report();
    }
  });
  const consume = async (input: NodeJS.ReadableStream | null, output: typeof stdout, stream: "stdout" | "stderr"): Promise<void> => {
    if (!input) return;
    try {
      for await (const value of input) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
        const remaining = Math.max(0, (options.maxLogBytes ?? MAX_LOG_BYTES) - bytes);
        const accepted = chunk.subarray(0, remaining);
        bytes += accepted.length;
        lastOutput = performance.now();
        tail = Buffer.concat([tail, accepted]).subarray(-MAX_RESULT_BYTES);
        if (accepted.length && !output.write(accepted)) await once(output, "drain");
        if (accepted.length) await options.onOutput?.(accepted, stream);
        if (accepted.length < chunk.length) { reason ??= "output_limit"; void stop(); }
        if (performance.now() - lastOutputUpdate >= 250) { lastOutputUpdate = performance.now(); report(); }
      }
    } catch { failIO(); }
    finally { output.end(); }
  };
  const reading = Promise.all([consume(child.stdout, stdout, "stdout"), consume(child.stderr, stderr, "stderr")]);
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.stdin);
  let confirmed = false;
  try {
    report();
    await Promise.race([completion, stopFinished]);
    confirmed = await stop();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reading, new Promise<void>(accept => { drainTimer = setTimeout(accept, 1000); })]); }
    finally { clearTimeout(drainTimer); }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await reading;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", abort);
    confirmed = await stop() && exited;
    child.stdout?.destroy();
    child.stderr?.destroy();
    stdout.end();
    stderr.end();
    await Promise.all([stdoutClosed, stderrClosed]);
    if (child.connected) child.disconnect();
  }
  const decoder = new StringDecoder("utf8");
  const output = displayText(decoder.write(tail) + decoder.end()).split("\n").slice(-1800).join("\n");
  return {
    status: !confirmed ? "termination_unconfirmed" : reason ?? (exitCode === 0 && !ioFailure ? "succeeded" : "failed"),
    exitCode, signal: exitSignal, elapsedMs: performance.now() - start,
    output, outputBytes: bytes, truncated: bytes > Buffer.byteLength(output) || reason === "output_limit",
    terminationConfirmed: confirmed,
    launchError,
    commands: commands.snapshot(), commandsTruncated: commands.truncated,
  };
}
