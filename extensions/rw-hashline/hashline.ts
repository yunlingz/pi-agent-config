import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const TAG_LENGTH = 12;
export interface Snapshot {
  path: string;
  digest: string;
  ranges: [number, number][];
}
export interface Hunk {
  kind: "replace" | "cut" | "before" | "after";
  start: number | "$";
  end: number;
  rows: string[];
}
export interface Section { path: string; tag: string; hunks: Hunk[] }

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function header(path: string, hash: string): string {
  return `[${JSON.stringify(path)}#${hash.slice(0, TAG_LENGTH).toUpperCase()}]`;
}
export function resolvePath(path: string, cwd: string): string {
  const mentioned = path.startsWith("@") ? path.slice(1) : path;
  const expanded = /^~[/\\]/u.test(mentioned) ? resolve(homedir(), mentioned.slice(2)) : mentioned;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** The reference supplies PUT/CUT syntax. This parser does not recover or rewrite payloads. */
export function parsePatch(input: string): Section[] {
  const sections: Section[] = [];
  let section: Section | undefined;
  let hunk: Hunk | undefined;
  for (const [index, original] of input.split("\n").entries()) {
    const line = original.endsWith("\r") ? original.slice(0, -1) : original;
    const fail = (message: string): never => { throw new Error(`Edit row ${index + 1}: ${message}`); };
    if (line.startsWith("+")) {
      if (!hunk || hunk.kind === "cut") return fail("Payload rows require a PUT header.");
      hunk.rows.push(line.slice(1));
      continue;
    }
    if (!line.trim()) continue;
    const file = /^\[(.+)#([0-9a-f]{12})\]$/iu.exec(line);
    if (file) {
      const authored = file[1];
      const tag = file[2];
      if (!authored || !tag) return fail("Invalid file header.");
      // Quoted paths use JSON escapes, including brackets, quotes, and newlines.
      const path: unknown = authored.startsWith('"') ? JSON.parse(authored) : authored;
      if (typeof path !== "string" || !path) return fail("The header requires a nonempty file path.");
      section = { path, tag: tag.toUpperCase(), hunks: [] };
      sections.push(section);
      hunk = undefined;
      continue;
    }
    if (!section) return fail("Copy the file header from hashline_read before the operations.");
    const operation = /^(PUT|CUT)\s+([<>]?)(\$|[1-9]\d*)(?:\.=([1-9]\d*))?(:?)$/u.exec(line);
    if (!operation) return fail("Use PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, or CUT N.=M.");
    const [, verb, gap, first, last, colon] = operation;
    if (first === "$" && (verb !== "PUT" || gap !== ">" || last)) return fail("Only PUT >$: accepts $.");
    if (verb === "CUT" && (gap || colon)) return fail("CUT requires a range and no colon or payload.");
    if (verb === "PUT" && colon !== ":") return fail("PUT requires a colon and +payload rows.");
    if (gap && last) return fail("An insertion uses one line number, not a range.");
    const start = first === "$" ? "$" : Number(first);
    const end = Number(last ?? first);
    if (start !== "$" && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)) {
      fail("The range must use ordered, safe, positive line numbers.");
    }
    hunk = { kind: verb === "CUT" ? "cut" : gap === "<" ? "before" : gap === ">" ? "after" : "replace", start, end, rows: [] };
    section.hunks.push(hunk);
  }
  if (!sections.length) throw new Error("No hashline file sections were supplied.");
  for (const file of sections) {
    if (!file.hunks.length) throw new Error(`No edits were supplied for ${file.path}.`);
    if (file.hunks.some(operation => operation.kind !== "cut" && !operation.rows.length)) {
      throw new Error("PUT requires +payload rows. Use CUT to delete content.");
    }
  }
  return sections;
}

/** Byte spans keep untouched content, mixed newlines, and invalid UTF-8 unchanged. */
export function applySection(bytes: Buffer, section: Section, snapshot: Snapshot): Buffer {
  const hash = digest(bytes);
  if (hash !== snapshot.digest || section.tag !== hash.slice(0, TAG_LENGTH).toUpperCase()) {
    throw new Error(`${section.path} changed since the snapshot. Use hashline_read before retrying.`);
  }
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const starts = [bom];
  for (let position = bom; position < bytes.length; position++) if (bytes[position] === 10) starts.push(position + 1);
  const endingAt = (index: number): string => {
    const end = starts[index + 1] ?? bytes.length;
    if (end > 0 && bytes[end - 1] === 10) return end > 1 && bytes[end - 2] === 13 ? "\r\n" : "\n";
    if (index > 0) return endingAt(index - 1);
    return "\n";
  };
  const seen = (first: number, last: number): boolean => {
    for (let line = first; line <= last; line++) {
      if (!snapshot.ranges.some(([start, end]) => line >= start && line <= end)) return false;
    }
    return true;
  };
  const replacements = section.hunks.map(operation => {
    const line = operation.start === "$" ? starts.length : operation.start;
    const last = operation.kind === "replace" || operation.kind === "cut" ? operation.end : line;
    if (line > starts.length || last > starts.length) throw new Error(`${section.path}: the edit exceeds the file's line count.`);
    if (!seen(line, last)) throw new Error(`${section.path}: read lines ${line}-${last} with hashline_read before editing them.`);
    const start = starts[line - 1];
    if (start === undefined) throw new Error("Invalid line position.");
    const end = starts[last] ?? bytes.length;
    const ending = endingAt(line - 1);
    if (operation.kind === "cut") {
      // Native read exposes the final empty row. Cutting it removes only the final newline.
      const phantom = line === starts.length && start === bytes.length && line > 1;
      return { start: phantom ? start - (bytes[start - 2] === 13 ? 2 : 1) : start, end, content: Buffer.alloc(0) };
    }
    if (operation.kind === "replace") {
      const terminated = end > start && bytes[end - 1] === 10;
      return { start, end, content: Buffer.from(operation.rows.join(ending) + (terminated ? ending : "")) };
    }
    const position = operation.kind === "before" ? start : starts[line] ?? bytes.length;
    const atTail = position === bytes.length;
    const terminated = bytes.length > bom && bytes.at(-1) === 10;
    const prefix = atTail && position > bom && !terminated ? ending : "";
    const suffix = !atTail || terminated ? ending : "";
    return { start: position, end: position, content: Buffer.from(prefix + operation.rows.join(ending) + suffix) };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const parts: Buffer[] = [];
  let position = 0;
  for (const replacement of replacements) {
    if (replacement.start < position) throw new Error(`${section.path}: edit ranges overlap. Merge them into one operation.`);
    parts.push(bytes.subarray(position, replacement.start), replacement.content);
    position = replacement.end;
  }
  parts.push(bytes.subarray(position));
  const result = Buffer.concat(parts);
  if (result.equals(bytes)) throw new Error(`${section.path}: the edit produced identical content. No file was changed.`);
  return result;
}
