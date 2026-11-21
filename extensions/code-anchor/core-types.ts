export interface NativeRead {
  path: string;
  text: string;
  tag: string;
  totalLines: number;
  firstLine: number;
  lastLine: number;
  truncated: boolean;
}

export interface NativeReadTarget { path: string; selector: string | null }

export interface NativeEdit {
  text: string;
  isError?: boolean;
  files: {
    path: string;
    absolute: string;
    operation: string;
    moveTo: string | null;
    diff: string;
    firstChangedLine: number | null;
    oldText: string | null;
    newText: string | null;
    parseRegressed: boolean;
  }[];
}

export interface SearchMatch {
  path: string;
  text: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  captures: Record<string, string>;
}

export interface NativeSearch {
  text: string;
  matches: SearchMatch[];
  totalMatches: number;
  filesSearched: number;
  filesWithMatches: number;
  limitReached: boolean;
  warnings: string[];
}

export interface NativePlan {
  files: { tag: string | null; path: string; display: string; before: string; after: string; replacements: number; diff: string }[];
  filesSearched: number;
  totalReplacements: number;
  warnings: string[];
  limitReached: boolean;
}

export type NativeRequest =
  | { action: "read_target"; path: string }
  | { action: "read"; path: string; display: string; offset?: number; limit?: number }
  | { action: "inspect" | "apply"; input: string; cwd: string; home: string; lockedPaths?: string[] }
  | { action: "search"; paths: string[]; cwd: string; pattern: string; language?: string; skip: number }
  | { action: "preview"; paths: string[]; cwd: string; operations: { pattern: string; replacement: string }[] }
  | { action: "pending_paths" }
  | { action: "resolve"; apply: boolean }
  | { action: "reset" };

export interface WorkerRequest { id: number; request: NativeRequest }
export type WorkerMessage = WorkerRequest | { cancel: number };
export type WorkerResponse = { id: number; ok: true; value: string } | { id: number; ok: false; error: string; fatal?: boolean };
