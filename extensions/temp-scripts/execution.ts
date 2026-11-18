import { displayText } from "./process.ts";
import { progressText } from "./progress.ts";
import type { ExecutionDetails, Progress, RetentionResult, RunResult, SourceView } from "./types.ts";

export function executionView(mode: ExecutionDetails["mode"], cwd: string, publish: (text: string, details: ExecutionDetails) => void, source?: SourceView) {
  let details: ExecutionDetails = { kind: "script-execution", mode, cwd, source, status: "preparing", elapsedMs: 0, output: "", commands: [], commandsTruncated: false };
  const snapshot = (): ExecutionDetails => ({ ...details, commands: details.commands.map(event => ({ ...event, args: [...event.args] })) });
  const emit = () => publish(details.progress ?? "Preparing execution", snapshot());
  return {
    start: emit,
    onSource(value: SourceView) { details = { ...details, source: value }; emit(); },
    onProgress(value: Progress) {
      details = { ...details, status: "running", elapsedMs: value.elapsedMs, output: value.outputTail ?? "",
        commands: value.commands ?? [], commandsTruncated: value.commandsTruncated ?? false,
        progress: progressText("Execution", { ...value, outputTail: undefined }) };
      publish(progressText("Execution", value), snapshot());
    },
    finish(record: RunResult, retention: RetentionResult): ExecutionDetails {
      details = { ...details, cwd: record.cwd, status: record.status, elapsedMs: record.elapsedMs, output: record.output,
        record, retention, commands: record.commands, commandsTruncated: record.commandsTruncated, progress: undefined };
      return snapshot();
    },
  };
}

export function executionText(details: ExecutionDetails): string {
  const record = details.record;
  const status = `Execution: ${details.status}${record ? ` · exit ${record.exitCode}` : ""} · ${(details.elapsedMs / 1000).toFixed(2)}s`;
  const retention = details.retention ? `Retention: ${details.retention.state} — ${details.retention.reason}` : "";
  const paths = record && details.retention?.state !== "removed" ? `Job: ${record.job}\nRun: ${record.run}\nArtifacts: ${record.artifacts}` : "";
  return displayText([status, `Cwd: ${details.cwd}`, retention, paths, record?.truncated ? "Output tail (truncated):" : "Output:", details.output].filter(Boolean).join("\n"));
}
