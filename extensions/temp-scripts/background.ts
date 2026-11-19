import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeJob, inspectJob } from "./jobs.ts";
import { displayText } from "./process.ts";
import type { ExecutionDetails, JobEvent, JobReference, Progress, RunOptions } from "./types.ts";
import { discardJobEvents, publishJobEvent } from "./job-events.ts";

interface JobHandle {
  reference: JobReference;
  sessionId: string;
  purpose: string;
  startedAt: number;
  controller: AbortController;
  completion: Promise<void>;
  spawned: Promise<void>;
  didSpawn: boolean;
  visible: boolean;
  service: boolean;
  details: ExecutionDetails;
  publish?: (update: Progress) => void;
  publishSource?: RunOptions["onSource"];
  error?: string;
  finished: boolean;
  eventRun: string;
  eventSequence: number;
  reporting: boolean;
  updates: JobEvent[];
  omittedUpdates: number;
  lastMilestone?: string;
}

// Only extension-owned process state survives /reload. No Pi contexts or private methods are retained.
const registryKey = Symbol.for("pi.temp-scripts.jobs.v1");
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, JobHandle> };
const registry = host[registryKey] ??= new Map<string, JobHandle>();
const delay = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms));

export interface BackgroundOptions {
  startupSeconds: number;
  runtimeSeconds?: number;
  service?: boolean;
  readyUrl?: string;
}

function find(reference: JobReference, sessionId: string): JobHandle | undefined {
  const value = registry.get(reference.id);
  if (value && (value.sessionId !== sessionId || value.reference.root !== reference.root || value.reference.token !== reference.token)) {
    throw new Error("Job controller belongs to another job or session");
  }
  return value;
}

function snapshot(handle: JobHandle): ExecutionDetails {
  return { ...handle.details, commands: handle.details.commands.map(value => ({ ...value, args: [...value.args] })),
    elapsedMs: handle.finished ? handle.details.elapsedMs : Date.now() - handle.startedAt };
}
function update(handle: JobHandle, kind: JobEvent["kind"], status: JobEvent["status"], fields: Partial<Pick<JobEvent, "message" | "command" | "output" | "exitCode" | "terminationConfirmed">> = {}): void {
  // Controllers created before event reporting can survive a hot reload.
  handle.eventRun ??= randomUUID();
  handle.eventSequence ??= 0;
  handle.reporting ??= false;
  handle.updates ??= [];
  handle.omittedUpdates ??= 0;
  const event: JobEvent = { job: handle.reference.id, run: handle.eventRun, purpose: handle.purpose,
    sequence: ++handle.eventSequence, timestamp: Date.now(), kind, status, ...fields };
  if (handle.reporting) publishJobEvent(handle.sessionId, event);
  else {
    if (kind === "progress") {
      const previous = handle.updates.findIndex(value => value.kind === "progress");
      if (previous >= 0) { handle.updates.splice(previous, 1); handle.omittedUpdates++; }
    }
    handle.updates.push(event);
    if (handle.updates.length > 64) { handle.updates.shift(); handle.omittedUpdates++; }
  }
}

function reportEvents(handle: JobHandle): void {
  handle.reporting = true;
  for (const [index, event] of handle.updates.entries()) publishJobEvent(handle.sessionId, event, index === 0 ? handle.omittedUpdates : 0);
  handle.updates = [];
  handle.omittedUpdates = 0;
}

export function backgroundActive(sessionId?: string, jobId?: string): boolean {
  return [...registry.values()].some(value => !value.finished && (!sessionId || value.sessionId === sessionId)
    && (!jobId || value.reference.id === jobId));
}

export function backgroundViews(sessionId: string): { purpose: string; details: ExecutionDetails; error?: string }[] {
  return [...registry.values()].filter(value => value.visible && value.sessionId === sessionId)
    .map(value => ({ purpose: value.purpose, error: value.error, details: snapshot(value) }));
}

export async function backgroundStatus(reference: JobReference, sessionId: string): Promise<ExecutionDetails | undefined> {
  await inspectJob(reference, sessionId);
  const handle = find(reference, sessionId);
  return handle ? snapshot(handle) : undefined;
}

export async function stopBackground(reference: JobReference, sessionId: string): Promise<ExecutionDetails> {
  await inspectJob(reference, sessionId);
  const handle = find(reference, sessionId);
  if (!handle) throw new Error("No live controller in this Pi process; inspect the retained lease, never kill a saved PID");
  if (!handle.finished) update(handle, "state", "stopping");
  handle.controller.abort();
  await handle.completion;
  if (handle.error) throw new Error(handle.error);
  return snapshot(handle);
}

export async function stopSessionBackground(sessionId: string): Promise<void> {
  const owned = [...registry.values()].filter(value => value.sessionId === sessionId);
  discardJobEvents(sessionId);
  for (const handle of owned) { handle.reporting = false; handle.updates = []; }
  for (const handle of owned) if (!handle.finished) handle.controller.abort();
  await Promise.all(owned.map(handle => handle.completion));
  for (const handle of owned) registry.delete(handle.reference.id);
}

export function forgetBackground(id: string): void {
  const handle = registry.get(id);
  if (handle && !handle.finished) throw new Error("Stop the job before forgetting it");
  if (handle) discardJobEvents(handle.sessionId, id);
  registry.delete(id);
}

async function launch(reference: JobReference, sessionId: string, entry: string, args: string[], mode: ExecutionDetails["mode"], options: RunOptions & { inline?: string; test?: boolean }, visible: boolean, service: boolean): Promise<JobHandle> {
  await inspectJob(reference, sessionId);
  const previous = find(reference, sessionId);
  if (previous && !previous.finished) throw new Error("This job already has running work");
  options.signal?.throwIfAborted();
  const spawned = Promise.withResolvers<void>();
  const handle: JobHandle = {
    reference, sessionId, purpose: options.purpose, startedAt: Date.now(), controller: new AbortController(),
    completion: Promise.resolve(), spawned: spawned.promise, didSpawn: false, finished: false, visible, service,
    eventRun: randomUUID(), eventSequence: 0, reporting: false, updates: [], omittedUpdates: 0,
    publish: options.onProgress, publishSource: options.onSource,
    details: { kind: "script-execution", mode, cwd: options.cwd, status: "preparing", elapsedMs: 0, output: "", commands: [], commandsTruncated: false,
      ...(visible ? { background: { job: reference.id, readiness: "not_checked" as const, service } } : {}),
      retention: { state: "retained", reason: "Running job evidence remains until completion/stop and explicit release" } },
  };
  registry.set(reference.id, handle);
  update(handle, "state", "preparing");
  const { signal: _signal, onProgress: _progress, onEvent: _event, onSource: _source, onSpawn: _spawn, ...runOptions } = options;
  handle.completion = (async () => {
    try {
      const output = await executeJob(reference, sessionId, entry, args, {
        ...runOptions, signal: handle.controller.signal, untilStopped: service, background: visible,
        onSpawn: () => { handle.didSpawn = true; handle.details.status = "running"; update(handle, "state", "running"); spawned.resolve(); },
        onSource: source => {
          handle.details = { ...handle.details, source };
          const publish = handle.publishSource;
          handle.publishSource = undefined;
          publish?.(source);
        },
        onProgress: update => {
          handle.details = { ...handle.details, status: "running", elapsedMs: update.elapsedMs, output: update.outputTail ?? "",
            commands: update.commands ?? [], commandsTruncated: update.commandsTruncated ?? false,
            progress: update.scriptReport ? `Script report: ${update.scriptReport}` : undefined };
          handle.publish?.(update);
        },
        onEvent: event => {
          if (event.kind === "command") {
            const { id, command, status, exitCode } = event.command;
            update(handle, "command", handle.details.status, { command: { id, command, status, exitCode } });
          } else if (event.message !== handle.lastMilestone) {
            handle.lastMilestone = event.message;
            update(handle, "progress", handle.details.status, { message: event.message });
          }
        },
      });
      handle.details = { ...handle.details, status: output.status, elapsedMs: output.elapsedMs, output: output.output,
        commands: output.commands, commandsTruncated: output.commandsTruncated, record: output, progress: undefined };
    } catch (error) {
      handle.error = `Job execution failed: ${error instanceof Error ? error.name : "unknown error"}; files retained`;
      handle.details = { ...handle.details, status: "failed", progress: handle.error };
    } finally {
      handle.finished = true;
      handle.publish = undefined;
      handle.publishSource = undefined;
      const record = handle.details.record;
      update(handle, "state", handle.details.status, { output: handle.details.output.slice(-2048),
        exitCode: record?.exitCode, terminationConfirmed: record?.terminationConfirmed, message: handle.error });
    }
  })();
  return handle;
}

/** Escape and native manual compaction cancel the wait, not the underlying execution. */
export async function runForeground(reference: JobReference, sessionId: string, entry: string, args: string[], mode: ExecutionDetails["mode"], options: RunOptions & { inline?: string; test?: boolean }): Promise<ExecutionDetails> {
  const handle = await launch(reference, sessionId, entry, args, mode, options, false, false);
  const interrupted = Promise.withResolvers<void>();
  const cancelWait = () => interrupted.resolve();
  options.signal?.addEventListener("abort", cancelWait, { once: true });
  if (options.signal?.aborted) cancelWait();
  try {
    await Promise.race([handle.completion, interrupted.promise]);
    if (!handle.finished) {
      handle.visible = true;
      handle.details = { ...handle.details, background: { job: reference.id, readiness: "not_checked", service: false },
        retention: { state: "retained", reason: "Waiting interrupted; process continues in the fixed jobs panel" } };
      update(handle, "handoff", "background", { message: "Foreground waiting ended; the owned process continues" });
      reportEvents(handle);
    } else if (handle.error) throw new Error(handle.error);
    return snapshot(handle);
  } finally {
    handle.publish = undefined;
    handle.publishSource = undefined;
    options.signal?.removeEventListener("abort", cancelWait);
    if (handle.finished) registry.delete(reference.id);
  }
}

function readinessUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.port === "0") {
    throw new Error("Readiness requires a credential-free loopback HTTP URL with a nonzero port");
  }
  return url;
}

export async function startBackground(reference: JobReference, sessionId: string, entry: string, args: string[], mode: ExecutionDetails["mode"], options: RunOptions & { inline?: string; test?: boolean }, background: BackgroundOptions): Promise<ExecutionDetails> {
  if (background.service ? background.runtimeSeconds !== undefined : background.runtimeSeconds === undefined) throw new Error("Background execution requires runtimeSeconds, or service:true without a runtime deadline");
  if (background.runtimeSeconds !== undefined && (!Number.isFinite(background.runtimeSeconds) || background.runtimeSeconds <= 0 || background.runtimeSeconds > 7 * 86400)) throw new Error("Background runtimeSeconds must be positive and at most seven days");
  if (!Number.isFinite(background.startupSeconds) || background.startupSeconds <= 0 || background.startupSeconds > 120) throw new Error("Background startup deadline must be positive and at most 120 seconds");
  const readyUrl = readinessUrl(background.readyUrl);
  const handle = await launch(reference, sessionId, entry, args, mode, { ...options, timeoutSeconds: background.runtimeSeconds ?? background.startupSeconds }, true, background.service === true);
  handle.details.background = { job: reference.id, readiness: readyUrl ? "waiting" : "not_checked", service: handle.service };
  if (readyUrl) update(handle, "readiness", "waiting");
  const abortStartup = () => handle.controller.abort();
  options.signal?.addEventListener("abort", abortStartup, { once: true });
  if (options.signal?.aborted) abortStartup();
  const timer = setTimeout(abortStartup, background.startupSeconds * 1000);
  try {
    const aborted = new Promise<void>(accept => handle.controller.signal.addEventListener("abort", () => accept(), { once: true }));
    await Promise.race([handle.spawned, handle.completion, aborted]);
    const deadline = handle.startedAt + background.startupSeconds * 1000;
    if (handle.didSpawn && !readyUrl) await delay(100);
    while (readyUrl && !handle.finished && !handle.controller.signal.aborted && Date.now() < deadline) {
      try {
        const response = await fetch(readyUrl, { signal: AbortSignal.any([handle.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))]), redirect: "error" });
        await response.body?.cancel();
        if (response.ok) { handle.details.background = { job: reference.id, readiness: "ready", service: handle.service }; update(handle, "readiness", "ready"); break; }
      } catch { /* Retry only the explicit loopback readiness check within its startup deadline. */ }
      await delay(50);
    }
    if (handle.controller.signal.aborted || !handle.didSpawn || (readyUrl && handle.details.background?.readiness !== "ready")) throw new Error("Background startup failed, was cancelled, or exceeded its deadline; evidence retained");
    if (handle.finished && handle.details.status !== "succeeded") throw new Error("Background process exited during startup; evidence retained");
    await writeFile(join(reference.root, "background.json"), JSON.stringify({ ownerPid: process.pid, sessionId, purpose: options.purpose, startedAt: handle.startedAt, service: handle.service, runtimeSeconds: background.runtimeSeconds, readiness: handle.details.background?.readiness }), { mode: 0o600 });
    if (!handle.finished) {
      update(handle, "handoff", "background", { message: "Background startup returned; lifecycle events will follow" });
      reportEvents(handle);
    }
    return snapshot(handle);
  } catch (error) {
    handle.controller.abort();
    await handle.completion;
    handle.details.background = { job: reference.id, readiness: "failed", service: handle.service };
    update(handle, "readiness", "failed", { message: "Background startup did not complete" });
    throw error;
  } finally {
    handle.publish = undefined;
    handle.publishSource = undefined;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortStartup);
  }
}

export function backgroundSummary(purpose: string, details: ExecutionDetails): string {
  return displayText(`Background job: ${details.background?.job ?? "unknown"}\n${purpose}: ${details.status} · elapsed ${(details.elapsedMs / 1000).toFixed(1)}s\nReadiness: ${details.background?.readiness ?? "not_checked"}\nCwd: ${details.cwd}\n${details.output ? `Recent output:\n${details.output.slice(-4096)}` : "No output yet."}`);
}
