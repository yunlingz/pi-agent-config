export const STATUS_KEY = "cache-rate";

function addAssistantUsage(totals, message) {
  if (message?.role !== "assistant" || ["error", "aborted"].includes(message.stopReason)) {
    return;
  }
  const usage = message.usage;
  if (!usage || !["input", "cacheRead", "cacheWrite"].every((key) =>
    Number.isFinite(usage[key]) && usage[key] >= 0)) {
    return;
  }
  totals.input += usage.input;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
}

export function computeCacheUsage(branch, endingMessage) {
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

function formatTokens(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

export function formatCacheStatus(usage) {
  // Match the native segment: stay hidden until the session has a cached read.
  if (usage.cacheRead === 0) {
    return undefined;
  }
  return `cache in: ${formatTokens(usage.cacheRead)} (${usage.percent.toFixed(1)}%)`;
}

function publish(ctx, endingMessage) {
  if (ctx.mode !== "tui") {
    return;
  }
  const usage = computeCacheUsage(ctx.sessionManager.getBranch(), endingMessage);
  ctx.ui.setStatus(STATUS_KEY, formatCacheStatus(usage));
}

export function registerCacheRate(pi) {
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      publish(ctx, event.message);
    }
  });
  for (const event of ["turn_end", "agent_settled", "session_tree", "session_compact"]) {
    pi.on(event, (_event, ctx) => publish(ctx));
  }
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
