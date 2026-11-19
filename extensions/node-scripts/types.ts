export type Status = "created" | "started" | "finished" | "failed" | "timeout" | "deprecated";

export interface Job {
  format: 1;
  id: string;
  name: string;
  scriptPath: string;
  args: string[];
  timeoutSeconds?: number;
  status: Status;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastOutputAt?: number;
  lastOutputLine?: string;
  exitCode?: number | null;
  signal?: string | null;
  terminationConfirmed?: boolean;
  previousStatus?: Status;
  error?: string;
}

export interface JobView extends Omit<Job, "status"> {
  status: Status | "unconfirmed";
  active: boolean;
  workspace: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface Query extends JobView {
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function jobActivity(job: JobView) {
  if (job.lastOutputAt !== undefined) return { at: job.lastOutputAt, source: "output" as const };
  if (job.startedAt !== undefined) return { at: job.startedAt, source: "started" as const };
  return { at: job.createdAt, source: "created" as const };
}

/** One recency definition for exact-status lists and the combined panel. */
export function compareRecent(a: JobView, b: JobView): number {
  return jobActivity(b).at - jobActivity(a).at
    || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)
    || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function listJobs(jobs: readonly JobView[], status: JobView["status"], recentN: number) {
  const matching = jobs.filter(job => job.status === status).sort(compareRecent);
  return { total: matching.length, hasMore: matching.length > recentN, jobs: matching.slice(0, recentN) };
}

export function panelJobs(jobs: readonly JobView[], expanded = false) {
  const matching = jobs.filter(job => job.status !== "deprecated")
    .sort((a, b) => Number(b.active) - Number(a.active) || compareRecent(a, b));
  const shown = expanded ? matching : matching.slice(0, 8);
  return {
    all: matching,
    jobs: shown,
    hidden: matching.length - shown.length,
    hiddenRunning: matching.slice(shown.length).filter(job => job.active).length,
  };
}
