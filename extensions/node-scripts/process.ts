import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

export const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
const delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));
function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function terminate(child: ChildProcess, exited: () => boolean): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return true;
  if (process.platform === "win32") {
    if (exited()) return true;
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" });
    const killed = await new Promise<boolean>(accept => {
      const timer = setTimeout(() => { killer.kill(); accept(false); }, 3000);
      killer.once("error", () => { clearTimeout(timer); accept(false); });
      killer.once("close", code => { clearTimeout(timer); accept(code === 0); });
    });
    if (!killed) return exited();
    const end = Date.now() + 2000;
    while (!exited() && Date.now() < end) await delay(20);
    return exited();
  }
  if (!groupExists(pid)) return true;
  try { process.kill(-pid, "SIGTERM"); } catch { /* Recheck the owned process group. */ }
  const grace = Date.now() + 500;
  while (groupExists(pid) && Date.now() < grace) await delay(20);
  if (groupExists(pid)) try { process.kill(-pid, "SIGKILL"); } catch { /* Confirm below. */ }
  const end = Date.now() + 2000;
  while (groupExists(pid) && Date.now() < end) await delay(20);
  return !groupExists(pid);
}

export interface Outcome {
  exitCode: number | null;
  signal: string | null;
  reason?: "timeout" | "deprecated";
  terminationConfirmed: boolean;
  error?: string;
}

export function startProcess(options: {
  args: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutSeconds?: number;
  stdoutPath: string; stderrPath: string; onOutput?: (text: string, stream: "stdout" | "stderr") => void;
}) {
  const child = spawn(process.execPath, options.args, { cwd: options.cwd, env: options.env ?? process.env,
    shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let error: string | undefined;
  let reason: Outcome["reason"];
  let stop: Promise<boolean> | undefined;
  const stopped = Promise.withResolvers<void>();
  const terminateOnce = () => stop ??= terminate(child, () => exited).finally(() => stopped.resolve());
  const started = new Promise<void>((accept, reject) => {
    child.once("spawn", accept);
    child.once("error", (failure: NodeJS.ErrnoException) => reject(new Error(`Node process could not start: ${failure.code ?? "SPAWN_FAILED"}`)));
  });
  const closed = new Promise<void>(accept => {
    child.once("error", (failure: NodeJS.ErrnoException) => { error = failure.code ?? "SPAWN_FAILED"; exited = true; accept(); });
    child.once("exit", (code, value) => { exitCode = code; signal = value; exited = true; accept(); });
  });
  const consume = async (input: NonNullable<typeof child.stdout>, path: string, stream: "stdout" | "stderr") => {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const decoder = new StringDecoder("utf8");
    const outputClosed = new Promise<void>(accept => output.once("close", accept));
    output.on("error", () => { error = "LOG_WRITE_FAILED"; void terminateOnce(); });
    try {
      for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (!output.write(bytes)) await new Promise<void>(accept => {
          const finish = () => { output.off("drain", finish); output.off("error", finish); accept(); };
          output.once("drain", finish); output.once("error", finish);
        });
        options.onOutput?.(clean(decoder.write(bytes)), stream);
      }
      const tail = decoder.end();
      if (tail) options.onOutput?.(clean(tail), stream);
    } catch { error ??= "LOG_STREAM_FAILED"; void terminateOnce(); }
    finally { output.end(); await outputClosed; }
  };
  const reading = Promise.all([consume(child.stdout, options.stdoutPath, "stdout"), consume(child.stderr, options.stderrPath, "stderr")]);
  const deadline = options.timeoutSeconds === undefined ? undefined : setTimeout(() => { reason ??= "timeout"; void terminateOnce(); }, options.timeoutSeconds * 1000);
  const completion = (async (): Promise<Outcome> => {
    try {
      await Promise.race([closed, stopped.promise]);
      const confirmed = await terminateOnce();
      let drain: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([reading, new Promise<void>(accept => { drain = setTimeout(accept, 1000); })]); }
      finally { clearTimeout(drain); }
      child.stdout.destroy(); child.stderr.destroy();
      await reading;
      return { exitCode, signal, reason, terminationConfirmed: confirmed && exited, error };
    } finally { clearTimeout(deadline); }
  })();
  return { started, completion, async deprecate() { reason ??= "deprecated"; await terminateOnce(); return completion; } };
}
