import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { backgroundViews, backgroundSummary } from "./background.ts";
import { displayText } from "./process.ts";

export const BACKGROUND_WIDGET = "temp-scripts-background";

export function backgroundPanelLines(sessionId: string, width: number, theme: Theme, expanded = false): string[] {
  const views = backgroundViews(sessionId);
  if (!views.length) return [];
  const active = views.filter(value => value.details.status === "running" || value.details.status === "preparing");
  const ordered = [...active, ...views.filter(value => !active.includes(value))];
  const shown = expanded ? ordered : ordered.slice(0, 3);
  const lines = [theme.fg(active.length ? "accent" : "dim", `${active.length ? "◐" : "○"} Background jobs (${active.length}/${views.length} active)`), ""];
  for (const [index, {purpose,details}] of shown.entries()) {
    const running = details.status === "running" || details.status === "preparing";
    const color = running ? "accent" : details.status === "succeeded" ? "success" : details.status === "cancelled" ? "muted" : "error";
    const branch = index === shown.length - 1 ? "└─" : "├─";
    const glyph = running ? "◐" : details.status === "succeeded" ? "✓" : details.status === "cancelled" ? "○" : "✗";
    lines.push(`${theme.fg("dim",branch)} ${theme.fg(color,`${glyph} ${displayText(purpose)}`)} ${theme.fg("muted",`· ${details.status} · ${(details.elapsedMs / 1000).toFixed(0)}s`)}`);
    lines.push(theme.fg("dim", `   ${details.background?.job ?? "unknown"} · readiness: ${details.background?.readiness ?? "not_checked"}`));
    const tail = displayText(details.output).trimEnd().split("\n").slice(expanded ? -6 : -1);
    lines.push(...tail.map(line => `   ${theme.fg("muted", line || "No output yet")}`));
  }
  if (views.length > shown.length) lines.push(theme.fg("dim", `   +${views.length - shown.length} more · /script-jobs expand`));
  lines.push("", theme.fg("dim", "/script-jobs [expand|collapse|job-id] · script_job logs / stop"), "");
  return lines.map(line => truncateToWidth(line, width));
}

export function registerBackgroundPanel(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let expanded = false;
  const draw = () => {
    const ctx = context;
    if (!ctx?.hasUI) return;
    if (!backgroundViews(ctx.sessionManager.getSessionId()).length) { ctx.ui.setWidget(BACKGROUND_WIDGET,undefined); return; }
    ctx.ui.setWidget(BACKGROUND_WIDGET, (_tui,theme) => ({
      render: width => backgroundPanelLines(ctx.sessionManager.getSessionId(),width,theme,expanded),
      invalidate() {},
    }), {placement:"aboveEditor"});
  };
  const clear = () => {
    clearInterval(timer);
    timer=undefined;
    context?.ui.setWidget(BACKGROUND_WIDGET,undefined);
    context=undefined;
  };
  pi.on("session_start",(_event,ctx)=>{clear();context=ctx;draw();if(ctx.hasUI) timer=setInterval(draw,1000);});
  pi.on("tool_execution_end",draw);
  pi.on("session_compact",draw); // Redraw only; native compaction never changes job ownership or process state.
  pi.on("session_shutdown",clear);
  pi.registerCommand("script-jobs",{
    description:"Inspect the fixed background panel, expand/collapse it, or report a job ID",
    async handler(args,ctx){
      const command=args.trim();
      if(command==="expand" || command==="collapse"){expanded=command==="expand";draw();return;}
      const views=backgroundViews(ctx.sessionManager.getSessionId());
      const chosen=command?views.filter(value=>value.details.background?.job===command):views;
      if(!chosen.length){ctx.ui.notify("No matching background jobs in this session","info");return;}
      if(command) ctx.ui.notify(chosen.map(value=>backgroundSummary(value.purpose,value.details)).join("\n\n"),"info");
      draw();
    },
  });
}
