import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { clean } from "./process.ts";
import { panelJobs, type JobView } from "./types.ts";

export const PANEL = "node-scripts-jobs";
export const mode = (job: Pick<JobView, "timeoutSeconds">) => job.timeoutSeconds === undefined ? "async · unlimited" : `sync · ${job.timeoutSeconds}s`;

export function panelLines(jobs: readonly JobView[], width: number, theme: Theme, expanded = false): string[] {
  const selected = panelJobs(jobs, expanded);
  if (!selected.all.length) return [];
  const count = (predicate: (job: JobView) => boolean) => selected.all.filter(predicate).length;
  const counts = [
    `${count(job => job.active && job.timeoutSeconds !== undefined)} sync`,
    `${count(job => job.active && job.timeoutSeconds === undefined)} background`,
    `${count(job => job.status === "created")} created`,
    `${count(job => ["finished", "failed", "timeout"].includes(job.status))} terminal`,
  ];
  const uncertain = count(job => job.status === "unconfirmed");
  if (uncertain) counts.push(`${uncertain} unconfirmed`);
  const lines = [theme.fg("accent", `Jobs · ${counts.join(" · ")}`)];
  for (const job of selected.jobs) {
    const glyph = job.active ? "◐" : job.status === "finished" ? "✓" : job.status === "failed" || job.status === "unconfirmed" ? "✗" : "○";
    const name = truncateToWidth(clean(job.name).replace(/[\r\n\t]/gu, " "), Math.max(8, Math.min(24, Math.floor(width / 4))), "…");
    const output = clean(job.lastOutputLine ?? "no output").replace(/[\r\n\t]/gu, " ");
    lines.push(`${glyph} [${expanded ? job.id : job.id.slice(0, 4)}] ${job.status} · ${mode(job)} · ${name} — ${output}`);
  }
  if (selected.hidden) lines.push(`+${selected.hidden} jobs${selected.hiddenRunning ? ` (${selected.hiddenRunning} running hidden)` : ""} · /node-scripts expand`);
  return lines.map(line => truncateToWidth(line, width, "…"));
}

export function jobText(job: JobView) {
  return `${job.name}\nJob: ${job.id}\nStatus: ${job.status} · ${mode(job)}\nWorkspace: ${job.workspace}\nScript: ${job.scriptPath}\nArguments: ${JSON.stringify(job.args)}\nStdout: ${job.stdoutPath}\nStderr: ${job.stderrPath}`
    + (job.exitCode !== undefined ? `\nExit: ${job.exitCode}; signal: ${job.signal ?? "none"}` : "")
    + (job.terminationConfirmed !== undefined ? `\nTermination confirmed: ${job.terminationConfirmed}` : "")
    + (job.error ? `\nWarning: ${job.error}` : "");
}

export function renderers(label: string) {
  return {
    renderCall(args: unknown, theme: Theme) {
      const input = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
      const name = input.name ?? input.scriptPath ?? input.jobId ?? input.package ?? input.path ?? "";
      return new Text(theme.fg("toolTitle", theme.bold(`${label}${name ? ` · ${clean(String(name))}` : ""}`)), 0, 0);
    },
    renderResult(result: { content: { type: string; text?: string }[]; isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme) {
      const text = clean(result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"));
      const lines = text.split("\n");
      const shown = options.expanded ? lines : lines.length > 18 ? [...lines.slice(0, 7), "… expand for details …", ...lines.slice(-10)] : lines;
      return new Text(theme.fg(result.isError ? "error" : "toolOutput", shown.join("\n")), 0, 0);
    },
  };
}
