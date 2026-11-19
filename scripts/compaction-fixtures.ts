import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export function populateSplitHistory(manager: SessionManager, model: Model<Api>, marker: string) {
  const historyMarker = `EARLIER_${marker}`;
  const prefixMarker = `CURRENT_${marker}`;
  const usage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  manager.appendMessage({ role: "user", content: `Synthetic earlier task: retain verification marker ${historyMarker}.`, timestamp: 1 });
  manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    content: [{ type: "text", text: "The earlier task is complete." }], usage,
  });
  manager.appendMessage({ role: "user", content: `Synthetic current task: retain verification marker ${prefixMarker}.`, timestamp: 3 });
  manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 4,
    content: [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "fixture.txt" } }], usage,
  });
  manager.appendMessage({
    role: "toolResult", toolCallId: "fixture-read", toolName: "read", isError: false, timestamp: 5,
    content: [{ type: "text", text: "Synthetic fixture output. ".repeat(100) }],
  });
  const firstKeptEntryId = manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 6,
    content: [{ type: "text", text: "Recent retained test context. ".repeat(100) }], usage,
  });
  return { historyMarker, prefixMarker, firstKeptEntryId };
}
