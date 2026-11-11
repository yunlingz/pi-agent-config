import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { CompactionEntry, MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  computeTokenUsage,
  formatTokenStatus,
  registerTokenUsage,
  STATUS_KEY,
  type TokenUsageContext,
  type TokenUsageEvent,
  type TokenUsageHandler,
  type TokenTotals,
} from "./token-usage.ts";

function usage(fields: Partial<TokenTotals> = {}): Usage {
  const counts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...fields };
  return {
    ...counts,
    totalTokens: counts.input + counts.cacheRead + counts.cacheWrite + counts.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(fields: Partial<TokenTotals>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    content: [],
    timestamp: 0,
    stopReason,
    usage: usage(fields),
  };
}

function base(id: string) {
  return { id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

function entry(message: MessageEndEvent["message"], id = "message"): SessionEntry {
  return { ...base(id), type: "message", message };
}

function compaction(id: string, fields: Partial<TokenTotals> = {}): CompactionEntry {
  return {
    ...base(id),
    type: "compaction",
    summary: "Fixture summary",
    firstKeptEntryId: "before",
    tokensBefore: 1000,
    usage: usage(fields),
  };
}

function harness(mode: TokenUsageContext["mode"] = "tui") {
  const handlers = new Map<TokenUsageEvent["type"], TokenUsageHandler>();
  const state: {
    entries: SessionEntry[];
    updates: { key: string; value: string | undefined }[];
    reads: number;
  } = { entries: [], updates: [], reads: 0 };
  registerTokenUsage({ on(name, handler) { handlers.set(name, handler); } });
  const ctx = {
    mode,
    sessionManager: {
      getEntries() {
        state.reads += 1;
        return state.entries;
      },
    },
    ui: { setStatus(key, value) { state.updates.push({ key, value }); } },
  } satisfies TokenUsageContext;
  return {
    state,
    emit(event: TokenUsageEvent) {
      const handler = handlers.get(event.type);
      assert.ok(handler, `Missing handler for ${event.type}`);
      handler(event, ctx);
    },
    value() { return state.updates.at(-1)?.value; },
  };
}

const emptyStatus = "in 0 · cr 0 · cw 0 · out 0 · cache --";

test("four raw fields remain separate before the first compaction", () => {
  assert.deepEqual(computeTokenUsage([
    entry(assistant({ input: 100, cacheRead: 900, cacheWrite: 20, output: 10 })),
    entry(assistant({ input: 20, cacheRead: 980, cacheWrite: 5, output: 5 })),
  ]), { input: 120, cacheRead: 1880, cacheWrite: 25, output: 15 });
});

test("empty sessions show zeros and an undefined cache rate", () => {
  assert.equal(formatTokenStatus(computeTokenUsage([])), emptyStatus);
});

test("compact labels retain middle-dot separators", () => {
  assert.equal(formatTokenStatus({ input: 100, cacheRead: 800, cacheWrite: 100, output: 200 }),
    "in 100 · cr 800 · cw 100 · out 200 · cache 80.0%");
});

test("cache writes belong in the denominator and output does not", () => {
  const counts = { input: 3, cacheRead: 9200, cacheWrite: 797, output: 1 };
  assert.equal(formatTokenStatus(counts), "in 3 · cr 9.2K · cw 797 · out 1 · cache 92.0%");
  assert.match(formatTokenStatus({ ...counts, output: 1_000_000 }), /cache 92\.0%$/);
});

test("cache rates use raw totals, not rounded labels or averaged request rates", () => {
  const records = [
    entry(assistant({ cacheRead: 100 })),
    entry(assistant({ cacheWrite: 900 })),
  ];
  assert.match(formatTokenStatus(computeTokenUsage(records)), /cache 10\.0%$/);
  assert.equal(formatTokenStatus({ input: 120, cacheRead: 1880, cacheWrite: 25, output: 15 }),
    "in 120 · cr 1.9K · cw 25 · out 15 · cache 92.8%");
});

test("zero hits, fully cached input, and output-only usage have distinct rates", () => {
  assert.match(formatTokenStatus({ input: 10, cacheRead: 0, cacheWrite: 5, output: 1 }), /cache 0\.0%$/);
  assert.match(formatTokenStatus({ input: 0, cacheRead: 100, cacheWrite: 0, output: 1 }), /cache 100\.0%$/);
  assert.match(formatTokenStatus({ input: 0, cacheRead: 0, cacheWrite: 0, output: 10 }), /cache --$/);
});

test("large counts use compact display without changing stored totals", () => {
  const totals = { input: 1234, cacheRead: 255_000_000, cacheWrite: 0, output: 12_345 };
  assert.equal(formatTokenStatus(totals), "in 1.2K · cr 255M · cw 0 · out 12.3K · cache 100.0%");
  assert.equal(totals.input, 1234);
});

test("a saved compaction excludes earlier history and its own summary usage", () => {
  const records: SessionEntry[] = [
    entry(assistant({ input: 100, cacheRead: 900, output: 10 }), "before"),
    compaction("compact", { input: 20, cacheRead: 80, output: 5 }),
    entry(assistant({ input: 30, cacheRead: 70, cacheWrite: 2, output: 6 }), "after"),
  ];
  assert.deepEqual(computeTokenUsage(records), { input: 30, cacheRead: 70, cacheWrite: 2, output: 6 });
  assert.equal(records.length, 3, "The reporting reset must not delete session entries");
});

test("only the latest compaction defines the reporting window", () => {
  const records: SessionEntry[] = [
    entry(assistant({ input: 1_000_000 }), "old"),
    compaction("first"),
    entry(assistant({ cacheRead: 1_000_000 }), "middle"),
    compaction("second", { cacheWrite: 1_000_000 }),
  ];
  assert.equal(formatTokenStatus(computeTokenUsage(records)), emptyStatus);
  records.push(entry(assistant({ input: 10, cacheRead: 90, output: 2 }), "new"));
  assert.equal(formatTokenStatus(computeTokenUsage(records)), "in 10 · cr 90 · cw 0 · out 2 · cache 90.0%");
});

test("post-compaction usage includes other branches, standalone usage, and branch summaries", () => {
  const records: SessionEntry[] = [
    entry(assistant({ input: 9999 }), "old"),
    compaction("compact"),
    entry(assistant({ input: 1, output: 2 }), "branch-a"),
    entry(assistant({ input: 3, output: 4 }), "branch-b"),
    {
      ...base("usage"), type: "usage", kind: "fixture", provider: "fixture", model: "fixture",
      usage: usage({ cacheRead: 5, cacheWrite: 6 }),
    },
    {
      ...base("summary"), type: "branch_summary", fromId: "branch-a", summary: "Fixture summary",
      usage: usage({ input: 7, output: 8 }),
    },
  ];
  assert.deepEqual(computeTokenUsage(records), { input: 11, cacheRead: 5, cacheWrite: 6, output: 14 });
});

test("nested tool usage contributes once; unrelated metadata and tool text do not", () => {
  const tool: ToolResultMessage = {
    role: "toolResult", toolCallId: "call", toolName: "fixture", content: [], timestamp: 0, isError: false,
    usage: usage({ input: 3, cacheRead: 5, cacheWrite: 7, output: 11 }),
  };
  assert.deepEqual(computeTokenUsage([
    entry({ role: "user", content: "Fixture", timestamp: 0 }),
    entry(tool),
    entry({ ...tool, usage: undefined }),
    { ...base("metadata"), type: "custom", customType: "fixture", data: { input: 999 } },
    { ...base("summary"), type: "branch_summary", fromId: "call", summary: "No recorded usage" },
  ]), { input: 3, cacheRead: 5, cacheWrite: 7, output: 11 });
});

test("failed and aborted requests retain reported usage within the current window", () => {
  assert.deepEqual(computeTokenUsage([
    entry(assistant({ input: 1, output: 2 }, "error")),
    entry(assistant({ input: 3, output: 4 }, "aborted")),
  ]), { input: 4, cacheRead: 0, cacheWrite: 0, output: 6 });
});

test("reasoning tokens are already part of output and are not added again", () => {
  const message = assistant({ output: 10 });
  message.usage.reasoning = 7;
  assert.equal(computeTokenUsage([entry(message)]).output, 10);
});

test("registration performs no reads or status updates", () => {
  const { state } = harness();
  assert.equal(state.reads, 0);
  assert.deepEqual(state.updates, []);
});

test("message_end includes the response before persistence without later double counting", () => {
  const fixture = harness();
  fixture.state.entries = [entry(assistant({ input: 9999 })), compaction("compact")];
  const ending = assistant({ input: 100, cacheRead: 800, cacheWrite: 100, output: 200 });
  fixture.emit({ type: "message_end", message: ending });
  const expected = "in 100 · cr 800 · cw 100 · out 200 · cache 80.0%";
  assert.equal(fixture.value(), expected);
  fixture.state.entries.push(entry(ending));
  fixture.emit({ type: "turn_end" });
  assert.equal(fixture.value(), expected);
});

test("tool-result message_end includes recorded nested usage before persistence", () => {
  const fixture = harness();
  fixture.emit({ type: "message_end", message: {
    role: "toolResult", toolCallId: "call", toolName: "fixture", content: [], timestamp: 0, isError: false,
    usage: usage({ input: 3, output: 5 }),
  } });
  assert.equal(fixture.value(), "in 3 · cr 0 · cw 0 · out 5 · cache 0.0%");
});

for (const type of ["session_start", "turn_end", "agent_settled", "session_tree", "session_compact"] as const) {
  test(`${type} rebuilds only the post-compaction reporting window`, () => {
    const fixture = harness();
    fixture.state.entries = [
      entry(assistant({ input: 9999 })),
      compaction("compact"),
      entry(assistant({ input: 4, cacheWrite: 6, output: 8 })),
    ];
    fixture.emit({ type });
    assert.equal(fixture.value(), "in 4 · cr 0 · cw 6 · out 8 · cache 0.0%");
    fixture.state.entries = [];
    fixture.emit({ type });
    assert.equal(fixture.value(), emptyStatus);
  });
}

test("failed or cancelled compaction notifications do not reset without a saved compaction entry", () => {
  const fixture = harness();
  fixture.state.entries = [entry(assistant({ input: 100, cacheRead: 900, output: 10 }))];
  fixture.emit({ type: "session_start" });
  const before = fixture.value();
  fixture.emit({ type: "session_compact_failed" });
  assert.equal(fixture.value(), before);
});

test("shutdown clears only this status key", () => {
  const fixture = harness();
  fixture.emit({ type: "session_shutdown" });
  assert.deepEqual(fixture.state.updates, [{ key: STATUS_KEY, value: undefined }]);
});

test("non-TUI sessions do not read history or update status", () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const fixture = harness(mode);
    for (const type of ["session_start", "turn_end", "agent_settled", "session_tree", "session_compact", "session_compact_failed", "session_shutdown"] as const) {
      fixture.emit({ type });
    }
    fixture.emit({ type: "message_end", message: assistant({ input: 5 }) });
    assert.equal(fixture.state.reads, 0);
    assert.deepEqual(fixture.state.updates, []);
  }
});
