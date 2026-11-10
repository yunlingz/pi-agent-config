import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TObject, TOptional, TString } from "typebox";

export interface SearchArgs {
  query: string;
  context?: string;
}

export type SearchParameters = TObject<{
  query: TString;
  context: TOptional<TString>;
}>;

export interface Source {
  title: string;
  url: string;
}

export interface CitationAnnotation {
  type?: string;
  url?: unknown;
  title?: unknown;
  start_index?: number;
  end_index?: number;
}

export interface SearchDetails {
  status: "running" | "done" | "error" | "cancelled";
  phase?: string;
  activity?: string;
  model?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  inputLimit?: number;
  outputLimit?: number;
  elapsedMs: number;
  searchCount?: number;
  sources: Source[];
  error?: string;
}

export type SearchResult = AgentToolResult<SearchDetails>;
export type SearchTool = ToolDefinition<SearchParameters, SearchDetails>;
export type SearchRenderers = Pick<SearchTool, "renderCall" | "renderResult">;
