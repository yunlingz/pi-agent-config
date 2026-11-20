import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clean } from "./process.ts";
import { panelJobs, type JobView, type Query } from "./types.ts";

export const PANEL = "node-scripts-jobs";
export const mode = (job: Pick<JobView, "timeoutSeconds">) => job.timeoutSeconds === undefined ? "async · unlimited" : `sync · ${job.timeoutSeconds}s`;
const singleLine = (text: string) => clean(text).replace(/[\r\n\t]/gu, " ");
const column = (text: string, width: number) => {
  const shown = truncateToWidth(singleLine(text), width, "…");
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
};
function appearance(job: Pick<JobView, "status" | "active">) {
  if (job.status === "unconfirmed") return { glyph: "!", color: "error" as const };
  if (job.active) return { glyph: "◐", color: "warning" as const };
  if (job.status === "finished") return { glyph: "✓", color: "success" as const };
  if (job.status === "failed" || job.status === "timeout") return { glyph: "✗", color: "error" as const };
  return { glyph: job.status === "deprecated" ? "⊘" : "○", color: "dim" as const };
}

export function panelLines(jobs: readonly JobView[], width: number, theme: Theme, expanded = false): string[] {
  const selected = panelJobs(jobs, expanded);
  if (!selected.all.length) return [];
  const running = selected.all.filter(job => job.active).length;
  const created = selected.all.filter(job => job.status === "created").length;
  const uncertain = selected.all.filter(job => job.status === "unconfirmed").length;
  const ended = selected.all.filter(job => ["finished", "failed", "timeout"].includes(job.status)).length;
  const counts = [`${running} running`, `${created} created`, `${ended} ended`];
  if (uncertain) counts.push(`${uncertain} unconfirmed`);
  const headingColor = running || created ? "accent" : "dim";
  const lines = [theme.fg(headingColor, `${running || created ? "●" : "○"} Node jobs`) + theme.fg("muted", ` (${counts.join(" · ")})`)];
  for (const [index, job] of selected.jobs.entries()) {
    const style = appearance(job);
    const branch = index === selected.jobs.length - 1 && !selected.hidden ? "└─" : "├─";
    const prefix = theme.fg("dim", `${branch} `) + theme.fg(style.color, style.glyph) + theme.fg("dim", ` [${expanded ? job.id : job.id.slice(0, 4)}] `);
    const available = Math.max(0, width - visibleWidth(prefix));
    const nameWidth = Math.max(8, Math.min(42, Math.floor(available * (width >= 100 ? 0.4 : 0.55))));
    const name = theme.fg(job.active ? "accent" : job.status === "created" ? "text" : "muted", column(job.name, nameWidth));
    const status = theme.fg(job.status === "unconfirmed" ? "error" : "dim", column(job.status, 11));
    const timing = theme.fg("dim", column(job.timeoutSeconds === undefined ? "bg" : `sync ${job.timeoutSeconds}s`, 14));
    const output = job.lastOutputLine ? theme.fg("muted", ` — ${singleLine(job.lastOutputLine)}`) : "";
    lines.push(width >= 100 ? `${prefix}${name}  ${status}${timing}${output}`
      : width >= 60 ? `${prefix}${name}  ${status}${output}`
        : `${prefix}${singleLine(job.name)}`);
  }
  if (selected.hidden) lines.push(theme.fg("dim", `└─ +${selected.hidden} jobs${selected.hiddenRunning ? ` (${selected.hiddenRunning} running hidden)` : ""} · /node-scripts expand`));
  return lines.map(line => truncateToWidth(line, width, "…"));
}

export function jobText(job: JobView & Partial<Pick<Query, "sourceState" | "scriptSha256Current">>) {
  const fields: [string, string][] = [
    ["Job", job.id], ["Status", `${job.status} · ${mode(job)}`], ["Workspace", job.workspace], ["Script", job.scriptPath],
    ["SHA-256 at launch", job.scriptSha256AtStart ?? "not recorded"],
    ...(job.sourceState ? [["Current source", job.sourceState] as [string, string]] : []),
    ...(job.scriptSha256Current ? [["Current SHA-256", job.scriptSha256Current] as [string, string]] : []),
    ["Arguments", JSON.stringify(job.args)], ["Stdout log", job.stdoutPath], ["Stderr log", job.stderrPath],
  ];
  if (job.exitCode !== undefined) fields.push(["Exit", `${job.exitCode}; signal: ${job.signal ?? "none"}`]);
  if (job.terminationConfirmed !== undefined) fields.push(["Termination", job.terminationConfirmed ? "confirmed" : "unconfirmed"]);
  if (job.error) fields.push(["Warning", job.error]);
  return `${job.name}\n${fields.map(([key, value]) => `${column(key + ":", 19)} ${value}`).join("\n")}`;
}

export function queryText(job: Query) {
  return [jobText(job), ...(job.stdout ? [`Stdout:\n${job.stdout}`] : []), ...(job.stderr ? [`Stderr:\n${job.stderr}`] : []),
    ...(job.outputTruncated ? ["[Output truncated; full logs remain at the paths above.]"] : [])].join("\n\n");
}

type ResultDetails = Partial<Query> & { jobs?: Pick<JobView, "id" | "name" | "status">[]; total?: number; hasMore?: boolean; package?: string; version?: string; action?: string };
export function renderers(label: string, jobName?: (id: string) => string | undefined) {
  return {
    renderCall(args: unknown, theme: Theme) {
      const input = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
      const actions: Record<string, [string, string]> = {
        "Create Node job": ["node", "+"], "Run Node job": ["node", "→"], "Query Node job": ["node", "›"],
        "Deprecate Node job": ["node", "×"], "List Node jobs": ["node", "☰"],
      };
      const [title, action] = actions[label] ?? [label, ""];
      const name = input.name ?? input.scriptPath ?? (typeof input.jobId === "string" ? jobName?.(input.jobId) ?? `[${input.jobId.slice(0, 8)}]` : input.package ?? input.path ?? input.status ?? "");
      return { render: (width: number) => [truncateToWidth(theme.fg("toolTitle", theme.bold(title)) + theme.fg("muted", action ? ` ${action}` : "")
        + (name ? ` ${theme.fg("accent", singleLine(String(name)))}` : ""), width, "…")], invalidate() {} };
    },
    renderResult(result: { content: { type: string; text?: string }[]; details?: unknown; isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme) {
      const text = clean(result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"));
      if (options.expanded) return new Text(theme.fg(result.isError ? "error" : "toolOutput", text), 0, 0);
      // All details are produced by this extension; restore that contract at the renderer boundary.
      const details = result.details as ResultDetails | undefined;
      const lines: string[] = [];
      if (details?.id && details.status) {
        const style = appearance({ status: details.status, active: details.active ?? false });
        const exit = details.exitCode !== undefined ? ` · exit ${details.exitCode ?? details.signal ?? "unknown"}` : "";
        lines.push(theme.fg(style.color, `${style.glyph} ${details.status}`) + theme.fg("muted", ` · ${mode(details)}${exit}`));
        if (details.sourceState && details.sourceState !== "same" && details.sourceState !== "not_recorded") lines.push(theme.fg("warning", `Source ${details.sourceState}`));
        if (details.error) lines.push(theme.fg("error", singleLine(details.error)));
        const output = (details.stderr?.trim() || details.stdout?.trim() || details.lastOutputLine)?.split(/\r?\n/u).filter(Boolean).at(-1);
        if (output) lines.push(theme.fg("muted", singleLine(output)));
      } else if (details?.jobs) {
        lines.push(theme.fg("muted", `${details.jobs.length} of ${details.total ?? details.jobs.length} ${details.status ?? "matching"} jobs${details.hasMore ? " · more available" : ""}`));
      } else if (details?.package) {
        lines.push(theme.fg("success", `✓ ${details.action ?? label} ${details.package}${details.version ? `@${details.version}` : ""}`));
      } else {
        lines.push(theme.fg(result.isError ? "error" : "muted", singleLine(text.trim().split("\n").find(Boolean) ?? (options.isPartial ? "Working…" : "Done"))));
      }
      return { render: (width: number) => lines.slice(0, 4).map(line => truncateToWidth(line, width, "…")), invalidate() {} };
    },
  };
}
