import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { backgroundViews, backgroundSummary } from "./background.ts";
import { displayText } from "./process.ts";
import type { RetentionView } from "./types.ts";

export const BACKGROUND_WIDGET = "temp-scripts-background";
export const RETENTION_WIDGET = "temp-scripts-retention";

const PANEL_ROWS = 12;

export function backgroundPanelLines(sessionId: string, width: number, theme: Theme, expanded = false): string[] {
  const views = backgroundViews(sessionId);
  if (!views.length) return [];
  const isActive = (value: typeof views[number]) => value.details.status === "running" || value.details.status === "preparing";
  const active = views.filter(isActive);
  const ordered = [...active, ...views.filter(value => !isActive(value))];
  const recent = expanded ? undefined : displayText(active[0]?.details.output ?? "").trimEnd().split("\n").at(-1);
  const rowBudget = PANEL_ROWS - 1 - (recent ? 1 : 0);
  const shown = expanded ? ordered : ordered.slice(0, views.length > rowBudget ? rowBudget - 1 : rowBudget);
  const headingColor = active.length ? "accent" : "dim";
  const lines = [theme.fg(headingColor, `${active.length ? "●" : "○"} Background jobs (${active.length}/${views.length} active)`)];
  for (const [index, { purpose, details }] of shown.entries()) {
    const running = details.status === "running" || details.status === "preparing";
    const color = running ? "warning" : details.status === "succeeded" ? "success" : details.status === "cancelled" ? "muted" : "error";
    const branch = index === shown.length - 1 && shown.length === views.length ? "└─" : "├─";
    const glyph = running ? "◐" : details.status === "succeeded" ? "✓" : details.status === "cancelled" ? "○" : "✗";
    const name = theme.fg(running ? "accent" : "muted", displayText(purpose));
    const readiness = details.background?.readiness ?? "not_checked";
    const state = `${details.status} · ${(details.elapsedMs / 1000).toFixed(0)}s${readiness === "not_checked" ? "" : ` · ${readiness}`}`;
    lines.push(`${theme.fg("dim", branch)} ${theme.fg(color, glyph)} ${running ? name : theme.strikethrough(name)} ${theme.fg("muted", `(${state})`)}`);
    if (expanded) {
      lines.push(theme.fg("dim", `   ${details.background?.job ?? "unknown"} · readiness: ${details.background?.readiness ?? "not_checked"}`));
      const tail = displayText(details.output).trimEnd();
      if (tail) lines.push(...tail.split("\n").slice(-6).map(line => `   ${theme.fg("muted", line)}`));
    } else if (index === 0 && recent) {
      lines.push(theme.fg("muted", `   ${recent}`));
    }
  }
  if (views.length > shown.length) lines.push(theme.fg("dim", `└─ +${views.length - shown.length} more · /script-jobs expand`));
  return [...lines.map(line => truncateToWidth(line, width, "…")), ""];
}

export function retentionPanelLines(views: readonly RetentionView[], width: number, theme: Theme, expanded = false): string[] {
  if (!views.length) return [];
  const important = (value: RetentionView) => ["preparing", "running", "unresolved", "cleanup_failed"].includes(value.state);
  const ordered = [...views.filter(important), ...views.filter(value => !important(value))];
  const active = views.some(value => value.state === "preparing" || value.state === "running");
  const shown = expanded ? ordered : ordered.slice(0, views.length > PANEL_ROWS - 1 ? PANEL_ROWS - 2 : PANEL_ROWS - 1);
  const lines = [theme.fg(active ? "accent" : "dim", `${active ? "●" : "○"} Job retention (${views.length} stored)`)];
  for (const [index, view] of shown.entries()) {
    const running = view.state === "preparing" || view.state === "running";
    const warning = view.state === "cleanup_failed" || view.state === "unresolved";
    const glyph = running ? "◐" : warning ? "✗" : view.state === "pinned" ? "◆" : "○";
    const branch = index === shown.length - 1 && shown.length === views.length ? "└─" : "├─";
    lines.push(`${theme.fg("dim", branch)} ${theme.fg(running || warning ? "warning" : "dim", glyph)} ${theme.fg(running ? "accent" : "text", displayText(view.purpose))} ${theme.fg("muted", `(${view.state})`)}`);
    if (expanded) lines.push(theme.fg("dim", `   ${view.id} · ${displayText(view.reason)}`));
  }
  if (views.length > shown.length) lines.push(theme.fg("dim", `└─ +${views.length - shown.length} more · /script-jobs expand`));
  return [...lines.map(line => truncateToWidth(line, width, "…")), ""];
}

export function registerJobPanels(pi: ExtensionAPI) {
  const retained = new Map<string, RetentionView>();
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let expanded = false;
  const views = (): RetentionView[] => {
    const backgrounds = new Map(backgroundViews(context?.sessionManager.getSessionId() ?? "").map(value => [value.details.background?.job, value]));
    return [...retained.values()].map(view => {
      const background = backgrounds.get(view.id);
      if (!background || view.state === "pinned" || view.state === "unresolved" || view.state === "cleanup_failed") return view;
      const active = background.details.status === "running" || background.details.status === "preparing";
      return { ...view, state: active ? "running" : "retained", reason: active ? "Background execution owns these files" : `Execution ${background.details.status}; files remain until explicit release` };
    });
  };
  const draw = () => requestRender?.();
  const clear = () => {
    clearInterval(timer);
    timer = undefined;
    requestRender = undefined;
    context?.ui.setWidget(BACKGROUND_WIDGET, undefined);
    context?.ui.setWidget(RETENTION_WIDGET, undefined);
    context = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    clear();
    context = ctx;
    if (!ctx.hasUI) return;
    // Reserve empty slots before later extensions. Redraw in place to preserve their order above Powerline.
    ctx.ui.setWidget(BACKGROUND_WIDGET, tui => {
      requestRender = () => tui.requestRender();
      return { render: width => backgroundPanelLines(ctx.sessionManager.getSessionId(), width, ctx.ui.theme, expanded || ctx.ui.getToolsExpanded()), invalidate() {} };
    }, { placement: "aboveEditor" });
    ctx.ui.setWidget(RETENTION_WIDGET, tui => {
      requestRender = () => tui.requestRender();
      return { render: width => retentionPanelLines(views(), width, ctx.ui.theme, expanded || ctx.ui.getToolsExpanded()), invalidate() {} };
    }, { placement: "aboveEditor" });
    timer = setInterval(draw, 1000);
  });
  pi.on("tool_execution_end", draw);
  pi.on("session_compact", draw);
  pi.on("session_shutdown", clear);
  pi.registerCommand("script-jobs", {
    description: "Inspect the fixed job panels, expand/collapse them, or report a job ID",
    async handler(args, ctx) {
      const command = args.trim();
      if (command === "expand" || command === "collapse") { expanded = command === "expand"; draw(); return; }
      const backgrounds = backgroundViews(ctx.sessionManager.getSessionId());
      const chosen = command ? backgrounds.filter(value => value.details.background?.job === command) : backgrounds;
      const stored = command ? views().filter(value => value.id === command) : views();
      if (!chosen.length && !stored.length) { ctx.ui.notify("No matching managed jobs in this session", "info"); return; }
      if (command) ctx.ui.notify(chosen.length ? chosen.map(value => backgroundSummary(value.purpose, value.details)).join("\n\n")
        : stored.map(value => `${value.purpose}\nJob: ${value.id}\nRetention: ${value.state} — ${value.reason}`).join("\n\n"), "info");
      draw();
    },
  });
  return {
    set(view: RetentionView) { retained.set(view.id, view); draw(); },
    remove(id: string) { retained.delete(id); draw(); },
    reset() { retained.clear(); draw(); },
  };
}
