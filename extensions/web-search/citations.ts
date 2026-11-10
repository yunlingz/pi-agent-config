import { stripVTControlCharacters } from "node:util";
import type { CitationAnnotation, Source } from "./types.ts";

export function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

export function citationSource(annotation: CitationAnnotation | null | undefined): Source | undefined {
  if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") return undefined;
  if (/[\u0000-\u0020\u007f]/u.test(annotation.url)) return undefined;
  let url;
  try {
    url = new URL(annotation.url);
  } catch {
    return undefined;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
  const title = typeof annotation.title === "string" && annotation.title.trim()
    ? cleanText(annotation.title).replace(/\s+/gu, " ").trim()
    : url.hostname;
  return { title: title || url.hostname, url: url.href };
}

export function sourceLink(source: Source): string {
  const label = source.title.replace(/[\\`*_\[\]<>]/gu, "\\$&");
  const target = source.url.replace(/[<>\\]/gu, (character) => encodeURIComponent(character));
  return `[${label}](<${target}>)`;
}

export function renderCitations(text: string, annotations?: readonly (CitationAnnotation | null)[]): string {
  if (!Array.isArray(annotations)) return cleanText(text);
  const insertions = new Map<number, Set<string>>();
  const markers = new Set<string>();
  const fallbackLinks = new Set<string>();
  for (const annotation of annotations) {
    const source = citationSource(annotation);
    if (!source) continue;
    const link = sourceLink(source);
    const start = annotation?.start_index;
    const end = annotation?.end_index;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
      fallbackLinks.add(link);
      continue;
    }
    const links = insertions.get(end) ?? new Set();
    links.add(link);
    insertions.set(end, links);
    for (const marker of text.slice(start, end).match(/\uE200[^\uE201]*\uE201/gu) ?? []) markers.add(marker);
  }
  let rendered = text;
  for (const [position, links] of [...insertions].sort(([left], [right]) => right - left)) {
    rendered = `${rendered.slice(0, position)} ${[...links].join(" ")}${rendered.slice(position)}`;
  }
  for (const marker of markers) rendered = rendered.replaceAll(marker, "");
  if (fallbackLinks.size > 0) rendered += `\n\nSources: ${[...fallbackLinks].join(" ")}`;
  return cleanText(rendered);
}
