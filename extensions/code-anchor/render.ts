import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

const PREVIEW_LINES = 10;

/** Limits terminal rows, including wrapped source and wide characters, without changing tool results. */
class FoldedText extends Text {
  private readonly formatHint: (hidden: number) => string;

  constructor(text: string, formatHint: (hidden: number) => string) {
    super(text, 0, 0);
    this.formatHint = formatHint;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length <= PREVIEW_LINES) return lines;
    return [
      ...lines.slice(0, PREVIEW_LINES),
      truncateToWidth(this.formatHint(lines.length - PREVIEW_LINES), width),
    ];
  }
}

export const renderCompactResult: NonNullable<ToolDefinition<TSchema, unknown, unknown>["renderResult"]> = (result, options, theme, context) => {
  const output = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const styled = theme.fg(context.isError ? "error" : "toolOutput", output);
  if (options.expanded) return new Text(styled, 0, 0);
  return new FoldedText(styled, hidden => theme.fg("muted", `${hidden} more lines · ${context.keyHint("app.tools.expand", "to expand")}`));
};

function renderCall(name: string, scope: string, theme: Theme): TruncatedText {
  return new TruncatedText(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", scope)}`, 0, 0);
}

export const hashlineRenderers = {
  renderCall(args: { input?: string }, theme: Theme) {
    const paths = [...new Set([...(args.input ?? "").matchAll(/^\[([^\]\n]+)#[0-9A-Fa-f]{4}\]/gmu)].flatMap(match => match[1] ? [match[1]] : []))];
    const scope = paths.length > 1 ? `${paths[0]} (+${paths.length - 1} files)` : paths[0] ?? "hashline changes";
    return renderCall("edit", scope, theme);
  },
  renderResult: renderCompactResult,
};

export const astSearchRenderers = {
  renderCall(args: { pat?: string; path?: string }, theme: Theme) {
    return renderCall("ast_grep", `${args.pat ?? ""} in ${args.path ?? "."}`, theme);
  },
  renderResult: renderCompactResult,
};

export const astEditRenderers = {
  renderCall(args: { paths?: string[] }, theme: Theme) {
    return renderCall("ast_edit", `preview in ${args.paths?.join("; ") ?? "."}`, theme);
  },
  renderResult: renderCompactResult,
};
