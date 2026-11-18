import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { commandText } from "./commands.ts";
import { displayText } from "./process.ts";
import type { ExecutionDetails, SourceView } from "./types.ts";

interface RenderContext {
  cwd: string;
  expanded: boolean;
  keyHint(id: string, label: string): string;
}

class Preview extends Text {
  private readonly rows: number;
  private readonly tail: boolean;
  private readonly hint: string;

  constructor(text: string, rows: number, tail: boolean, hint: string) {
    super(text, 0, 0);
    this.rows = rows;
    this.tail = tail;
    this.hint = hint;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length <= this.rows) return lines;
    const notice = truncateToWidth(this.hint, width);
    return this.tail ? [notice, ...lines.slice(-this.rows)] : [...lines.slice(0, this.rows), notice];
  }
}

function sourceComponent(source: SourceView, expanded: boolean, theme: Theme, hint: string) {
  const text = `${theme.fg("muted", "Source · JavaScript")}\n${highlightCode(displayText(source.text), "javascript").join("\n")}`;
  const notice = source.truncated ? `\n${theme.fg("warning", `Source preview truncated; full executed source: ${source.path ?? "see submitted code"}`)}` : "";
  return expanded ? new Text(text + notice, 0, 0) : new Preview(text + notice, 6, false, hint);
}

function executionResult(value: { content: { type: string; text?: string }[]; details?: ExecutionDetails }, view: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) {
  const details = value.details;
  if (!details || details.kind !== "script-execution") return new Text(value.content.map(block => block.text ?? "").join("\n"), 0, 0);
  const container = new Container();
  const hint = theme.fg("dim", context.keyHint("app.tools.expand", "to expand source, commands, output, and details"));
  container.addChild(new Spacer(1));
  if (details.mode === "workspace" && details.source) {
    container.addChild(sourceComponent(details.source, view.expanded, theme, hint));
    container.addChild(new Spacer(1));
  }
  const active = details.status === "running" || details.status === "preparing";
  const glyph = active ? "◐" : details.status === "succeeded" ? "✓" : details.status === "cancelled" ? "○" : "✗";
  const color = active ? "accent" : details.status === "succeeded" ? "success" : details.status === "cancelled" ? "muted" : "error";
  const state = view.isPartial ? details.progress ?? "Preparing execution" : `${details.status} · ${details.record ? `exit ${details.record.exitCode} · ` : ""}elapsed ${(details.elapsedMs / 1000).toFixed(2)}s`;
  container.addChild(new Text(theme.fg(color, `${glyph} ${state}`), 0, 0));
  if (details.background) container.addChild(new Text(theme.fg("muted", `Background · ${details.background.job}\nReadiness: ${details.background.readiness} · fixed jobs panel`), 0, 0));
  if (details.commands.length) {
    container.addChild(new Spacer(1));
    const commands = (view.expanded ? details.commands : details.commands.slice(-2)).map(commandText).join("\n");
    const heading = theme.fg("muted", `Commands (${details.commands.length}${details.commandsTruncated ? "+; truncated" : ""}):\n`);
    container.addChild(view.expanded ? new Text(heading + displayText(commands), 0, 0) : new Preview(heading + displayText(commands), 5, true, hint));
  }
  if (details.output) {
    container.addChild(new Spacer(1));
    const text = `${theme.fg("muted", "Output")}\n${displayText(details.output)}`;
    container.addChild(view.expanded ? new Text(text, 0, 0) : new Preview(text, 7, true, hint));
  }
  if (details.retention) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg(details.retention.state === "cleanup_failed" ? "warning" : "dim", `Retention: ${details.retention.state} — ${details.retention.reason}`), 0, 0));
  }
  if (view.expanded && details.record) {
    const record = details.record;
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `Details\nJob: ${record.job}\nRun records: ${record.run}${details.retention?.state === "removed" ? " (removed)" : ""}\nSource hash: ${record.sourceHash}\nCwd: ${record.cwd}\nArtifacts: ${record.artifacts}`), 0, 0));
  }
  return container;
}

export const inlineRenderers = {
  renderCall(args: { purpose?: string; timeoutSeconds?: number; cwd?: string; code?: string; background?: object | false }, theme: Theme, context: RenderContext) {
    const container = new Container();
    container.addChild(new Text(theme.fg("toolTitle", theme.bold(`Inline JS${args.background ? " · background" : ""}`)) + theme.fg("accent", ` · ${displayText(args.purpose ?? "")}`), 0, 0));
    container.addChild(new Text(theme.fg("muted", `cwd: ${displayText(args.cwd ?? context.cwd)} · ${args.background ? "startup" : "deadline"} ${args.timeoutSeconds ?? "…"}s`), 0, 0));
    if (args.code) {
      container.addChild(new Spacer(1));
      container.addChild(sourceComponent({ text: args.code, truncated: false }, context.expanded, theme, context.keyHint("app.tools.expand", "to inspect complete inline source")));
    }
    return container;
  },
  renderResult: executionResult,
};

export const workspaceRenderers = {
  renderCall(args: { purpose?: string; entry?: string; args?: string[]; cwd?: string; timeoutSeconds?: number; background?: object | false }, theme: Theme, context: RenderContext) {
    return new Text(`${theme.fg("toolTitle", theme.bold(`Workspace JS${args.background ? " · background" : ""}`))}${theme.fg("accent", ` · ${displayText(args.purpose ?? "")}`)}\n${theme.fg("muted", `entry: ${displayText(args.entry ?? "…")} ${JSON.stringify(args.args ?? [])}\ncwd: ${displayText(args.cwd ?? context.cwd)} · ${args.background ? "startup" : "deadline"} ${args.timeoutSeconds ?? "…"}s`)}`, 0, 0);
  },
  renderResult: executionResult,
};

export const jobRenderers = {
  renderCall(args: { action?: string; job?: string; jobs?: string[] }, theme: Theme) {
    return new Text(theme.fg("toolTitle", theme.bold("Script job")) + theme.fg("accent", ` · ${args.action ?? "…"}`) + theme.fg("dim", args.jobs ? ` · ${args.jobs.length} jobs` : args.job ? ` · ${args.job}` : ""), 0, 0);
  },
  renderResult(value: { content: { type: string; text?: string }[]; details?: ExecutionDetails }, view: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) {
    if (value.details?.kind === "script-execution") return executionResult(value, view, theme, context);
    const text = `\n${displayText(value.content.map(block => block.text ?? "").join("\n"))}`;
    return view.expanded ? new Text(text, 0, 0) : new Preview(text, 8, false, theme.fg("dim", context.keyHint("app.tools.expand", "to inspect job details")));
  },
};
