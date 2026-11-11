import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { VerificationAudit, VerificationPayload } from "./verification-fixtures.ts";
import { SEARCH_GUIDELINES } from "./web-search.ts";

export function createObserver(auditPath: string): (pi: ExtensionAPI) => void {
  function record(event: VerificationAudit): void {
    appendFileSync(auditPath, JSON.stringify(event) + "\n");
  }

  return (pi) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && /\/responses(?:\/input_tokens)?$/u.test(new URL(request.url).pathname)) {
        // The Responses adapter serializes this payload. Live verification checks the recorded fields.
        const payload = await request.clone().json() as VerificationPayload;
        if (payload.tools?.some((tool) => tool.type === "web_search")) {
          record({
            type: "search", model: payload.model, reasoning: payload.reasoning,
            tools: payload.tools, toolChoice: payload.tool_choice,
            configurationUpdates: payload.input.filter((item) => item.type === "configuration_update"),
            count: request.url.endsWith("/input_tokens"),
          });
        }
      }
      return originalFetch(request);
    };
    pi.on("session_shutdown", () => { globalThis.fetch = originalFetch; });
    pi.on("before_provider_request", (event) => {
      // This observer runs only with the supported OpenAI Responses models.
      const payload = event.payload as VerificationPayload;
      const efforts = payload.input.filter((item) => item.type === "configuration_update").map((item) => item.reasoning?.effort);
      record({
        type: "main", model: payload.model, effort: efforts.at(-1) ?? payload.reasoning?.effort,
        toolTypes: payload.tools?.map((tool) => tool.type), names: payload.tools?.map((tool) => tool.name),
        toolChoice: payload.tool_choice,
        hasSearchGuidance: SEARCH_GUIDELINES.every((guideline) => JSON.stringify(payload).includes(guideline)),
      });
      return { ...payload, max_output_tokens: 8192 };
    });
  };
}
