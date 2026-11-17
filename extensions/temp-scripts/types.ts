export const REGISTRY = "https://packagefeedproxy.microsoft.io/npm/";
export const JOB_PREFIX = "pi-managed-script-";
export const ENTRY_TYPE = "temp-script-job";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  releasedAt?: number;
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
}

export interface RunOptions {
  purpose: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  env?: NodeJS.ProcessEnv;
}
