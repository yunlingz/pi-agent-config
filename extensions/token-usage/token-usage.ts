import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionEvent, MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

export type TokenTotals = Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "output">;

export interface TokenUsageContext extends Pick<ExtensionContext, "mode"> {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries">;
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

type RefreshEvent = Pick<Extract<ExtensionEvent, {
  type: "session_start" | "turn_end" | "agent_settled" | "session_tree" | "session_compact" | "session_compact_failed" | "session_shutdown";
}>, "type">;

export type TokenUsageEvent = RefreshEvent | MessageEndEvent;
export type TokenUsageHandler = (event: TokenUsageEvent, ctx: TokenUsageContext) => void;

interface TokenUsageAPI {
  on(name: TokenUsageEvent["type"], handler: TokenUsageHandler): void;
}

export const STATUS_KEY = "token-usage";
const tokenFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function messageUsage(message: MessageEndEvent["message"]): Usage | undefined {
  return message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
}

export function computeTokenUsage(entries: readonly SessionEntry[], endingMessage?: MessageEndEvent["message"]): TokenTotals {
  const totals: TokenTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const add = (usage: Usage | undefined) => {
    if (!usage) return;
    totals.input += usage.input;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.output += usage.output;
  };

  // Start after the saved boundary to exclude old history and the compaction operation's own usage.
  const start = entries.findLastIndex((entry) => entry.type === "compaction") + 1;
  for (const entry of entries.slice(start)) {
    if (entry.type === "message") {
      add(messageUsage(entry.message));
    } else if (entry.type === "usage" || entry.type === "branch_summary") {
      add(entry.usage);
    }
  }
  // Pi emits message_end before adding the final message to the session ledger.
  if (endingMessage) add(messageUsage(endingMessage));
  return totals;
}

export function formatTokenStatus(totals: TokenTotals): string {
  const totalInput = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheRate = totalInput > 0 ? `${(totals.cacheRead / totalInput * 100).toFixed(1)}%` : "--";
  return [
    `in ${tokenFormat.format(totals.input)}`,
    `cr ${tokenFormat.format(totals.cacheRead)}`,
    `cw ${tokenFormat.format(totals.cacheWrite)}`,
    `out ${tokenFormat.format(totals.output)}`,
    `cache ${cacheRate}`,
  ].join(" · ");
}

function publish(ctx: TokenUsageContext, endingMessage?: MessageEndEvent["message"]): void {
  if (ctx.mode !== "tui") return;
  const totals = computeTokenUsage(ctx.sessionManager.getEntries(), endingMessage);
  ctx.ui.setStatus(STATUS_KEY, formatTokenStatus(totals));
}

export function registerTokenUsage(pi: TokenUsageAPI): void {
  for (const type of ["session_start", "turn_end", "agent_settled", "session_tree", "session_compact", "session_compact_failed"] as const) {
    pi.on(type, (_event, ctx) => publish(ctx));
  }
  pi.on("message_end", (event, ctx) => {
    if (event.type === "message_end" && messageUsage(event.message)) publish(ctx, event.message);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
