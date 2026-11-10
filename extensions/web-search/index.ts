import { Type } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createSearchRenderers } from "./render.ts";
import { registerWebSearch } from "./web-search.ts";

export default function (pi: ExtensionAPI) {
  registerWebSearch(pi, {
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "A focused question or research task that requires web evidence." }),
      context: Type.Optional(Type.String({ description: "Only background needed for this query. Exclude secrets, private data, and unrelated history." })),
    }),
    ...createSearchRenderers({ Container, Markdown, Text, truncateToWidth, visibleWidth, getMarkdownTheme }),
  });
}
