export const REGISTRY = "https://packagefeedproxy.microsoft.io/npm/";
export const JOB_PREFIX = "pi-managed-script-";
export const ENTRY_TYPE = "temp-script-job";
export const REMOVED_ENTRY_TYPE = "temp-script-job-removed";

export interface CommandEvent {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | RunStatus;
  exitCode?: number | null;
  truncated?: boolean;
}

export interface SourceView {
  text: string;
  path?: string;
  truncated: boolean;
}

export interface RetentionResult {
  state: "removed" | "retained" | "cleanup_failed";
  reason: string;
}

export interface ExecutionDetails {
  kind: "script-execution";
  mode: "inline" | "workspace";
  background?: { job: string; readiness: "not_checked" | "waiting" | "ready" | "failed"; service: boolean };
  source?: SourceView;
  commands: CommandEvent[];
  commandsTruncated: boolean;
  cwd: string;
  status: "preparing" | "running" | RunStatus;
  elapsedMs: number;
  output: string;
  progress?: string;
  retention?: RetentionResult;
  record?: RunResult;
}

export interface JobReference {
  id: string;
  root: string;
  token: string;
}

export interface JobManifest extends JobReference {
  format: 1;
  sessionId: string;
  purpose: string;
  createdAt: number;
  state: "open" | "pinned" | "released";
  dependencies: Record<string, string>;
}

export type RunStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "output_limit" | "termination_unconfirmed";

export interface ProcessResult {
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  output: string;
  outputBytes: number;
  truncated: boolean;
  terminationConfirmed: boolean;
  launchError?: string;
  commands: CommandEvent[];
  commandsTruncated: boolean;
}

export interface RunResult extends ProcessResult {
  job: string;
  run: string;
  cwd: string;
  sourceHash: string;
  stdoutPath: string;
  stderrPath: string;
  artifacts: string;
}

export interface Progress {
  phase: string;
  elapsedMs: number;
  outputBytes: number;
  lastOutputMs: number | null;
  scriptReport?: string;
  outputTail?: string;
  commands?: CommandEvent[];
  commandsTruncated?: boolean;
}

export interface RunOptions {
  purpose: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  onSource?: (source: SourceView) => void;
  env?: NodeJS.ProcessEnv;
  untilStopped?: boolean;
  onSpawn?: () => void;
}
