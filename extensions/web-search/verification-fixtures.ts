import type { CitationAnnotation } from "./types.ts";

/** Fields read from OpenAI Responses requests by the verification transports. */
export interface VerificationPayload {
  model: string;
  input: { type?: string; reasoning?: { effort?: string } }[];
  reasoning?: { effort?: string };
  tools?: { type: string; name?: string }[];
  tool_choice?: unknown;
  truncation?: string;
  max_output_tokens?: number;
}

export type VerificationAudit = {
  type: "search";
  model: string;
  reasoning: VerificationPayload["reasoning"];
  configurationUpdates: VerificationPayload["input"];
  count: boolean;
} | {
  type: "main";
  model: string;
  effort: string | undefined;
  toolTypes: string[] | undefined;
  names: (string | undefined)[] | undefined;
  toolChoice: unknown;
  hasSearchGuidance: boolean;
};

export interface FixtureMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: [{ type: "output_text"; text: string; annotations: CitationAnnotation[] }];
}

interface FixtureSearch {
  type: "web_search_call";
  id: string;
  status: "completed";
  action: { type: "search"; query: string };
}

export interface FixtureToolCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}

export type FixtureOutput = FixtureMessage | FixtureSearch | FixtureToolCall;
type AddedOutput = FixtureToolCall
  | (Omit<FixtureSearch, "status"> & { status: "in_progress" })
  | (Omit<FixtureMessage, "content"> & { content: [] });

export type FixtureEvent =
  | { type: "response.created"; response: { id: string } }
  | { type: "response.output_item.added"; output_index: number; item: AddedOutput }
  | { type: "response.output_item.done"; output_index: number; item: FixtureOutput }
  | { type: "response.web_search_call.searching" | "response.web_search_call.completed"; output_index: number; item_id: string }
  | { type: "response.output_text.delta"; output_index: number; content_index: number; item_id: string; delta: string }
  | { type: "response.function_call_arguments.delta"; output_index: number; delta: string }
  | { type: "response.completed"; response: {
    id: string;
    model: string;
    status: "completed";
    output: FixtureOutput[];
    usage: { input_tokens: number; output_tokens: number; total_tokens: number; output_tokens_details: { reasoning_tokens: number } };
  } };
