import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Progress } from "./types.ts";

export function progressText(purpose: string, value: Progress): string {
  const quiet = value.lastOutputMs === null ? "no output yet" : `last output ${Math.floor(value.lastOutputMs / 1000)}s ago`;
  return `[${new Date().toISOString()}] ${purpose}\n${value.phase} · elapsed ${(value.elapsedMs / 1000).toFixed(1)}s · ${value.outputBytes} output bytes · ${quiet}`
    + (value.scriptReport ? `\nScript report: ${value.scriptReport}` : "")
    + (value.outputTail ? `\nOutput tail:\n${value.outputTail}` : "");
}

export function registerProgress(pi: ExtensionAPI, isEnabled: () => boolean): { clear(): void } {
  const active = new Map<string, { name: string; started: number; updated: number }>();
  let phase = "preparing request";
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: ExtensionContext | undefined;
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    active.clear();
    if (context?.hasUI) context.ui.setWidget("temp-scripts-progress", undefined);
  };
  pi.on("before_agent_start", (_event, ctx) => {
    if (!isEnabled()) return;
    clear();
    context = ctx;
    phase = "preparing request";
    timer = setInterval(() => {
      const ordinary = [...active.values()].filter(item => !item.name.startsWith("script_"));
      if (active.size > 0 && ordinary.length === 0) return; // Managed tools already stream their own status.
      const lines = ordinary.length ? ordinary.map(item => `${item.name}: ${Math.floor((Date.now() - item.started) / 1000)}s; last update ${Math.floor((Date.now() - item.updated) / 1000)}s ago`) : [phase];
      const text = `Observed session progress: ${lines.slice(0, 4).join("; ")}`;
      if (ctx.hasUI) ctx.ui.setWidget("temp-scripts-progress", [text]);
      else process.stderr.write(`[${new Date().toISOString()}] ${text}\n`);
    }, 20_000);
  });
  pi.on("before_provider_request", () => { phase = "waiting for provider response"; });
  pi.on("message_update", () => { phase = "receiving model output"; });
  pi.on("ui_prompt_start", () => { phase = "waiting for user input"; });
  pi.on("ui_prompt_end", () => { phase = "resuming session work"; });
  pi.on("tool_execution_start", event => { active.set(event.toolCallId, { name: event.toolName, started: Date.now(), updated: Date.now() }); });
  pi.on("tool_execution_update", event => { const item = active.get(event.toolCallId); if (item) item.updated = Date.now(); });
  pi.on("tool_execution_end", event => { active.delete(event.toolCallId); phase = "processing tool results"; });
  pi.on("agent_settled", clear);
  pi.on("session_shutdown", clear);
  return { clear };
}
