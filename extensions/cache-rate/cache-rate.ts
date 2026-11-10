import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface CacheMessage {
  role: string;
  stopReason?: string;
  usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

export interface CacheEntry {
  type: string;
  message?: CacheMessage;
  id?: string;
  data?: unknown;
}

export interface CacheContext extends Pick<ExtensionContext, "mode"> {
  sessionManager: { getBranch(): readonly CacheEntry[] };
  ui: Pick<ExtensionUIContext, "setStatus">;
}

export type CacheEvent =
  | { type: "message_end"; message: CacheMessage }
  | { type: "session_start" | "turn_end" | "agent_settled" | "session_tree" | "session_compact" | "session_shutdown" };

export type CacheHandler = (event: CacheEvent, ctx: CacheContext) => void;

interface CacheRateAPI {
  on(event: CacheEvent["type"], handler: CacheHandler): void;
}

interface CacheTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export const STATUS_KEY = "cache-rate";

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addAssistantUsage(totals: CacheTotals, message: CacheMessage | undefined) {
  if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") {
    return;
  }
  const usage = message.usage;
  if (!usage) {
    return;
  }
  const { input, cacheRead, cacheWrite } = usage;
  if (!isTokenCount(input) || !isTokenCount(cacheRead) || !isTokenCount(cacheWrite)) {
    return;
  }
  totals.input += input;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
}

export function computeCacheUsage(branch: readonly CacheEntry[], endingMessage?: CacheMessage) {
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of branch) {
    if (entry.type === "message") {
      addAssistantUsage(totals, entry.message);
    }
  }
  // Pi 1.3 dispatches message_end before appending its message to the branch.
  if (endingMessage) {
    addAssistantUsage(totals, endingMessage);
  }
  const totalInput = totals.input + totals.cacheRead + totals.cacheWrite;
  return { ...totals, totalInput, percent: totalInput > 0 ? totals.cacheRead / totalInput * 100 : 0 };
}

function formatTokens(tokens: number) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

export function formatCacheStatus(usage: ReturnType<typeof computeCacheUsage>) {
  // Match the native segment: stay hidden until the session has a cached read.
  if (usage.cacheRead === 0) {
    return undefined;
  }
  return `cache in: ${formatTokens(usage.cacheRead)} (${usage.percent.toFixed(1)}%)`;
}

function publish(ctx: CacheContext, endingMessage?: CacheMessage) {
  if (ctx.mode !== "tui") {
    return;
  }
  const usage = computeCacheUsage(ctx.sessionManager.getBranch(), endingMessage);
  ctx.ui.setStatus(STATUS_KEY, formatCacheStatus(usage));
}

export function registerCacheRate(pi: CacheRateAPI) {
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      publish(ctx, event.message);
    }
  });
  for (const event of ["turn_end", "agent_settled", "session_tree", "session_compact"] as const) {
    pi.on(event, (_event, ctx) => publish(ctx));
  }
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
