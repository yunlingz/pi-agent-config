import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeInvocation } from "./executables.ts";
import { runProcess } from "./process.ts";
import { executionEnvironment, mergeEnvironment, projectBinDirectories } from "./environment.ts";

/** Optional helper for managed JavaScript. No globals or process hooks are patched. */
export function progress(message: string): void {
  if (process.send && process.connected) process.send({ type: "progress", message }, () => {});
}

/** Children join the outer run's process group. The outer controller owns final tree shutdown. */
export async function exec(command: string, args: string[], options: { timeoutSeconds: number; cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean }) {
  const root = process.env.PI_SCRIPT_RUN;
  if (!root) throw new Error("This helper requires a managed script run");
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = executionEnvironment(mergeEnvironment(process.env, options.env), projectBinDirectories(cwd));
  const invocation = await nativeInvocation(command, args, cwd, env);
  const directory = await mkdtemp(join(root, "child-"));
  const result = await runProcess({ command: invocation.command, args: invocation.args, cwd, timeoutSeconds: options.timeoutSeconds, signal: options.signal,
    env, stdin: options.input,
    stdoutPath: join(directory, "stdout.log"), stderrPath: join(directory, "stderr.log"), processGroup: false,
    onProgress: update => progress(`${command}: ${Math.floor(update.elapsedMs / 1000)}s; ${update.outputBytes} output bytes`),
    onOutput: (chunk, stream) => new Promise<void>((accept, reject) => {
      process[stream].write(chunk, error => { if (error) reject(error); else accept(); });
    }),
  });
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (result.status !== "succeeded" && !options.allowFailure) throw new Error(`Native command ${result.status}; exit ${result.exitCode}; logs: ${directory}`);
  return { ...result, logs: directory };
}
