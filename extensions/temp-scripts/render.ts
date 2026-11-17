import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { displayText } from "./process.ts";

/** Keep status and the newest visual output rows visible at narrow terminal widths. */
class LiveTail extends Text {
  private readonly hint: string;

  constructor(text: string, hint: string) { super(text, 0, 0); this.hint = hint; }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length <= 12) return lines;
    return [...lines.slice(0, 3), truncateToWidth(this.hint, width), ...lines.slice(-8)];
  }
}

export const scriptRenderers = {
  renderCall(args: { purpose?: string; timeoutSeconds?: number }, theme: Theme) {
    const deadline = args.timeoutSeconds ? ` · deadline ${args.timeoutSeconds}s` : "";
    return new Text(theme.fg("toolTitle", `Managed script${args.purpose ? ` · ${displayText(args.purpose)}` : ""}${deadline}`), 0, 0);
  },
  renderResult(value: { content: { type: string; text?: string }[] }, view: { expanded: boolean; isPartial: boolean }, theme: Theme) {
    const text = value.content.map(block => block.text ?? "").join("\n");
    const styled = theme.fg(view.isPartial ? "toolOutput" : "muted", text);
    return view.expanded ? new Text(styled, 0, 0) : new LiveTail(styled, theme.fg("dim", "Earlier output hidden · expand to inspect"));
  },
};
