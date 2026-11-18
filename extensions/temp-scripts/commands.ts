import type { CommandEvent } from "./types.ts";

const STATUSES = ["running", "succeeded", "failed", "cancelled", "timed_out", "output_limit", "termination_unconfirmed"];

/** IPC is an external boundary even though the supported runtime owns the normal producer. */
export function commandEvent(value: unknown): CommandEvent | undefined {
  if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
    || !("command" in value) || typeof value.command !== "string" || !("cwd" in value) || typeof value.cwd !== "string"
    || !("args" in value) || !Array.isArray(value.args) || !value.args.every((arg: unknown) => typeof arg === "string")
    || !("status" in value) || !STATUSES.includes(String(value.status))
    || ("exitCode" in value && value.exitCode !== null && !Number.isInteger(value.exitCode))
    || ("truncated" in value && typeof value.truncated !== "boolean")
    || ("failureAccepted" in value && typeof value.failureAccepted !== "boolean")) return undefined;
  if (value.id.length > 100 || value.args.length > 256 || JSON.stringify(value).length > 16 * 1024) return undefined;
  // The checked IPC contract carries no host objects or executable behavior.
  return value as CommandEvent;
}

export class CommandLog {
  private entries: CommandEvent[] = [];
  truncated = false;

  append(value: unknown): void {
    const event = commandEvent(value);
    if (!event) { this.truncated = true; return; }
    const previous = this.entries.findIndex(entry => entry.id === event.id);
    const next = [...this.entries];
    if (previous < 0) next.push(event);
    else next[previous] = event;
    if (next.length > 64 || JSON.stringify(next).length > 32 * 1024) { this.truncated = true; return; }
    this.entries = next;
  }

  snapshot(): CommandEvent[] {
    return this.entries.map(entry => ({ ...entry, args: [...entry.args] }));
  }
}

/** JSON argument notation shows the actual array; it is not a shell command to copy and execute. */
export function commandText(event: CommandEvent): string {
  const status = event.failureAccepted ? `${event.status} (accepted exit ${event.exitCode})` : event.status;
  return `${status}: ${event.command} ${JSON.stringify(event.args)}\ncwd: ${event.cwd}`;
}
