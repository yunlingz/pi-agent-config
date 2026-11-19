import type { JobEvent } from "./types.ts";

export interface JobEventBatch {
  events: JobEvent[];
  omitted: number;
}

interface Channel {
  pending: JobEvent[];
  omitted: number;
  listener?: (batch: JobEventBatch) => void;
  timer?: ReturnType<typeof setTimeout>;
  paused: boolean;
  lastSent: number;
}

// Reload replaces the subscriber, not the process-owned queue. No Pi context is kept here.
const key = Symbol.for("pi.temp-scripts.events.v1");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Channel> };
const channels = host[key] ??= new Map<string, Channel>();
const MAX_EVENTS = 64;
const BATCH_INTERVAL_MS = 1000;

function channel(sessionId: string): Channel {
  let value = channels.get(sessionId);
  if (!value) {
    value = { pending: [], omitted: 0, paused: false, lastSent: 0 };
    channels.set(sessionId, value);
  }
  return value;
}

function schedule(value: Channel): void {
  if (value.timer || value.paused || !value.listener || !value.pending.length) return;
  // One event-driven timeout batches bursts. It never checks process state or polls files.
  value.timer = setTimeout(() => {
    value.timer = undefined;
    if (value.paused || !value.listener) return;
    const batch = { events: value.pending, omitted: value.omitted };
    value.pending = [];
    value.omitted = 0;
    value.lastSent = Date.now();
    value.listener(batch);
  }, Math.max(100, value.lastSent + BATCH_INTERVAL_MS - Date.now()));
}

export function publishJobEvent(sessionId: string, event: JobEvent, omitted = 0): void {
  const value = channel(sessionId);
  value.omitted += omitted;
  // Keep the newest explicit milestone during a burst, without losing state transitions.
  if (event.kind === "progress") {
    const previous = value.pending.findIndex(item => item.run === event.run && item.kind === "progress");
    if (previous >= 0) { value.pending.splice(previous, 1); value.omitted++; }
  }
  value.pending.push(event);
  if (value.pending.length > MAX_EVENTS) {
    const progress = value.pending.findIndex(item => item.kind === "progress");
    value.pending.splice(progress < 0 ? 0 : progress, 1);
    value.omitted++;
  }
  schedule(value);
}

export function subscribeJobEvents(sessionId: string, listener: (batch: JobEventBatch) => void) {
  const value = channel(sessionId);
  clearTimeout(value.timer);
  value.timer = undefined;
  value.listener = listener;
  value.paused = false;
  schedule(value);
  return {
    pause() { value.paused = true; clearTimeout(value.timer); value.timer = undefined; },
    resume() { value.paused = false; schedule(value); },
    dispose() {
      if (value.listener !== listener) return;
      clearTimeout(value.timer);
      value.timer = undefined;
      value.listener = undefined;
    },
  };
}

export function discardJobEvents(sessionId: string, job?: string): void {
  const value = channels.get(sessionId);
  if (!value) return;
  if (job) value.pending = value.pending.filter(event => event.job !== job);
  else {
    clearTimeout(value.timer);
    channels.delete(sessionId);
  }
}
