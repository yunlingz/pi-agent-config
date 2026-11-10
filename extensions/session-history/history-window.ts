export interface DisplayEntry {
  type: string;
  id?: string;
  message?: { role: string };
  display?: boolean;
}

interface HistoryManager<Entry extends DisplayEntry> {
  getBranch(): Entry[];
  buildContextEntries(): Entry[];
}

export const DEFAULT_INITIAL_ENTRIES = 50;
export const DEFAULT_LOAD_ENTRIES = 50;
export const DEFAULT_PRELOAD_SCREENS = 2;

const DISPLAY_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
]);

export function isDisplayEntry(entry: DisplayEntry | null | undefined) {
  if (entry?.type === "message") {
    return DISPLAY_MESSAGE_ROLES.has(entry.message?.role ?? "");
  }
  if (entry?.type === "custom_message") {
    return entry.display === true;
  }
  return entry?.type === "compaction" || entry?.type === "branch_summary";
}

export function collectHiddenEntries<Entry extends DisplayEntry>(sessionManager: HistoryManager<Entry>) {
  const visibleIds = new Set(
    sessionManager.buildContextEntries().map((entry) => entry.id),
  );

  return sessionManager
    .getBranch()
    .filter((entry) => isDisplayEntry(entry) && !visibleIds.has(entry.id));
}

function alignStart(entries: readonly DisplayEntry[], requestedStart: number) {
  let start = Math.max(0, Math.min(requestedStart, entries.length));
  if (start === 0 || start === entries.length) {
    return start;
  }

  while (
    start > 0
    && entries[start]?.type === "message"
    && entries[start].message?.role === "toolResult"
  ) {
    start -= 1;
  }

  return start;
}

export class HistoryWindow<Entry extends DisplayEntry = DisplayEntry> {
  initialEntries: number;
  loadEntries: number;
  entries: Entry[];
  start: number;

  constructor({
    initialEntries = DEFAULT_INITIAL_ENTRIES,
    loadEntries = DEFAULT_LOAD_ENTRIES,
  } = {}) {
    this.initialEntries = initialEntries;
    this.loadEntries = loadEntries;
    this.entries = [];
    this.start = 0;
  }

  refresh(entries: Entry[], earliestEntryId?: string) {
    this.entries = entries;

    const restoredStart = earliestEntryId
      ? entries.findIndex((entry) => entry.id === earliestEntryId)
      : -1;
    const requestedStart = restoredStart >= 0
      ? restoredStart
      : Math.max(0, entries.length - this.initialEntries);
    this.start = alignStart(entries, requestedStart);

    return this.snapshot();
  }

  loadMore() {
    if (!this.hasMore) {
      return this.snapshot();
    }

    this.start = alignStart(
      this.entries,
      Math.max(0, this.start - this.loadEntries),
    );
    return this.snapshot();
  }

  loadAll() {
    this.start = 0;
    return this.snapshot();
  }

  snapshot() {
    const selected = this.entries.slice(this.start);
    return {
      selected,
      remaining: this.start,
      hasMore: this.start > 0,
      earliestEntryId: selected[0]?.id,
      total: this.entries.length,
    };
  }

  get hasMore() {
    return this.start > 0;
  }
}
