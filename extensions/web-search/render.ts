import type * as Tui from "@earendil-works/pi-tui";
import type { getMarkdownTheme as markdownThemeFactory } from "@earendil-works/pi-coding-agent";
import type { SearchRenderers } from "./types.ts";
import { cleanText } from "./citations.ts";

interface RenderDependencies {
  Text: typeof Tui.Text;
  Markdown: typeof Tui.Markdown;
  Container: typeof Tui.Container;
  truncateToWidth: typeof Tui.truncateToWidth;
  visibleWidth: typeof Tui.visibleWidth;
  getMarkdownTheme: typeof markdownThemeFactory;
}

const PHASE_LABELS: Record<string, string> = {
  "Checking input budget": "Checking",
  "Searching the web": "Searching",
  "Preparing findings": "Preparing",
};

export function createSearchRenderers({ Text, Markdown, Container, truncateToWidth, visibleWidth, getMarkdownTheme }: RenderDependencies): SearchRenderers {
  return {
    renderCall(args, theme, context) {
      const title = {
        render(width: number) {
          return [truncateToWidth(theme.fg("toolTitle", theme.bold("web.run")), width, "")];
        },
        invalidate() {},
      };
      if (!context.expanded) return title;
      const container = new Container();
      container.addChild(title);
      if (typeof args.query === "string" && args.query.trim()) {
        container.addChild(new Text(theme.fg("muted", cleanText(args.query)), 0, 0));
      }
      return container;
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details;
      const elapsed = `${((details?.elapsedMs ?? renderContext?.durationMs ?? 0) / 1000).toFixed(1)}s`;
      const failed = renderContext?.isError || result.isError || ["error", "cancelled"].includes(details?.status ?? "");
      const sourceCount = details?.sources?.length ?? 0;
      const label = isPartial ? PHASE_LABELS[details?.phase ?? ""] ?? "Searching"
        : failed ? details?.status === "cancelled" ? "Cancelled" : "Failed"
          : details ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}` : "Done";
      const color = isPartial ? "warning" : failed ? "error" : "success";
      const summary = {
        render(width: number) {
          const candidates = [`${label} · ${elapsed}`, label];
          const text = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? truncateToWidth(label, width, "");
          return [theme.fg(color, text)];
        },
        invalidate() {},
      };
      if (!expanded) return summary;
      const container = new Container();
      container.addChild(summary);
      if (isPartial) {
        if (details?.activity) container.addChild(new Text(theme.fg("muted", cleanText(details.activity)), 0, 0));
        return container;
      }
      if (details?.model) {
        const input = details.inputTokens === undefined ? "input count unavailable" : `${details.inputTokens.toLocaleString("en-US")} input tokens`;
        container.addChild(new Text(theme.fg("dim", `${details.model} · reasoning ${details.thinkingLevel ?? "unknown"} · ${input}`), 0, 0));
      }
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      container.addChild(new Markdown(cleanText(text), 0, 0, getMarkdownTheme()));
      return container;
    },
  };
}
