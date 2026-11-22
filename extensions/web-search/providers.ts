import type { Api, Model } from "@earendil-works/pi-ai";
import type { SearchSettings } from "./config.ts";
import type { SearchResult } from "./types.ts";
import { runSearch, type SearchOptions } from "./search-request.ts";

export interface SearchProvider {
  name: string;
  description: string;
  supports(model: Model<Api> | undefined): boolean;
  execute(options: SearchOptions): Promise<SearchResult>;
}

export function responsesWebSearch({ modelAllowList }: SearchSettings["providers"]["responsesWebSearch"]): SearchProvider {
  const models = new Set(modelAllowList);
  return {
    name: "responsesWebSearch",
    description: [
      "Search the web through an independent request using the current model with low reasoning effort.",
      "The complete search input is limited to 64,000 gateway-counted tokens; oversized input is rejected without truncation.",
    ].join(" "),
    supports: (model) => model !== undefined && model.api === "openai-responses" && models.has(`${model.provider}/${model.id}`),
    execute: runSearch,
  };
}

export function selectSearchProvider(settings: SearchSettings): SearchProvider {
  if (settings.enableProvider !== "responsesWebSearch") throw new Error("/enableProvider selects an unimplemented search provider.");
  return responsesWebSearch(settings.providers.responsesWebSearch);
}
