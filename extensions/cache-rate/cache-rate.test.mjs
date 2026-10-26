import assert from "node:assert/strict";
import test from "node:test";
import { computeCacheUsage, formatCacheStatus, registerCacheRate, STATUS_KEY } from "./cache-rate.mjs";

function assistant(usage = {}, stopReason = "toolUse") {
  return { role: "assistant", stopReason, usage: { input: 0, cacheRead: 0, cacheWrite: 0, ...usage } };
}
function entry(message) {
  return { type: "message", message };
}
function status(branch) {
  return formatCacheStatus(computeCacheUsage(branch));
}
function harness(mode = "tui") {
  const handlers = new Map();
  const state = { branch: [], updates: [], reads: 0 };
  registerCacheRate({ on: (name, handler) => handlers.set(name, handler) });
  const ctx = {
    mode,
    sessionManager: { getBranch() { state.reads += 1; return state.branch; } },
    ui: { setStatus: (key, value) => state.updates.push({ key, value }) },
  };
  return { state, emit: (name, event = {}) => handlers.get(name)(event, ctx) };
}

test("cache writes belong in the denominator", () => {
  const message = assistant({ input: 3, cacheRead: 9200, cacheWrite: 797 });
  assert.equal((9200 / (9200 + 3) * 100).toFixed(0), "100", "Reproduce the vendor formula's misleading result");
  const usage = computeCacheUsage([entry(message)]);
  assert.equal(usage.totalInput, 10_000);
  assert.equal(usage.percent, 92);
  assert.equal(formatCacheStatus(usage), "cache in: 9.2k (92.0%)");
});

test("ordinary cached and uncached input still calculate correctly", () => {
  assert.equal(status([entry(assistant({ input: 100, cacheRead: 900 }))]), "cache in: 900 (90.0%)");
});

test("fully cached input is legitimately 100 percent", () => {
  assert.equal(status([entry(assistant({ cacheRead: 1000 }))]), "cache in: 1.0k (100.0%)");
});

test("empty and creation-only sessions remain hidden", () => {
  for (const branch of [[], [entry(assistant())], [entry(assistant({ cacheWrite: 1000 }))]]) {
    const usage = computeCacheUsage(branch);
    assert.equal(usage.percent, 0);
    assert.equal(formatCacheStatus(usage), undefined);
  }
});

test("aggregate rates are token-weighted, not request-weighted", () => {
  const branch = [entry(assistant({ cacheRead: 100 })), entry(assistant({ cacheWrite: 900 }))];
  assert.equal(computeCacheUsage(branch).percent, 10);
});

test("all three input buckets aggregate across the branch", () => {
  const usage = computeCacheUsage([
    entry(assistant({ input: 100, cacheRead: 700, cacheWrite: 200 })),
    entry(assistant({ input: 200, cacheRead: 600, cacheWrite: 200 }, "stop")),
  ]);
  assert.deepEqual(usage, { input: 300, cacheRead: 1300, cacheWrite: 400, totalInput: 2000, percent: 65 });
});

test("failed and aborted responses are excluded", () => {
  const branch = [
    entry(assistant({ input: 100, cacheRead: 900 })),
    entry(assistant({ cacheWrite: 100_000 }, "error")),
    entry(assistant({ cacheRead: 100_000 }, "aborted")),
  ];
  assert.equal(computeCacheUsage(branch).percent, 90);
});

test("metadata, compaction entries, user messages, and tool results do not add model usage", () => {
  const usage = { input: 100, cacheRead: 900, cacheWrite: 0 };
  assert.equal(status([
    { type: "compaction", id: "summary" },
    { type: "custom", data: { usage } },
    entry({ role: "user", usage }),
    entry({ role: "toolResult", usage }),
    entry(assistant(usage)),
  ]), "cache in: 900 (90.0%)");
});

test("history before compaction remains part of session-wide usage", () => {
  const branch = [entry(assistant({ cacheWrite: 1000 })), { type: "compaction" }, entry(assistant({ cacheRead: 1000 }))];
  assert.equal(computeCacheUsage(branch).percent, 50);
});

test("malformed external counters cannot produce NaN or negative rates", () => {
  for (const key of ["input", "cacheRead", "cacheWrite"]) {
    for (const value of [undefined, null, "100", -1, NaN, Infinity]) {
      assert.equal(status([entry(assistant({ input: 100, cacheRead: 900, [key]: value }))]), undefined);
    }
  }
});

test("cached-token formatting matches the native footer's scale", () => {
  for (const [tokens, label] of [[999, "999"], [1000, "1.0k"], [10_000, "10k"], [1_000_000, "1.0M"], [111_000_000, "111M"]]) {
    assert.equal(status([entry(assistant({ cacheRead: tokens }))]), `cache in: ${label} (100.0%)`);
  }
});

test("one decimal reduces rounding ambiguity without falsifying near-perfect rates", () => {
  assert.equal(status([entry(assistant({ input: 4, cacheRead: 996 }))]), "cache in: 996 (99.6%)");
  assert.equal(status([entry(assistant({ input: 1, cacheRead: 9999 }))]), "cache in: 10.0k (100.0%)");
});

test("registration performs no session reads or UI updates", () => {
  const { state } = harness();
  assert.equal(state.reads, 0);
  assert.deepEqual(state.updates, []);
});

test("session start publishes the current branch", () => {
  const { state, emit } = harness();
  state.branch = [entry(assistant({ input: 100, cacheRead: 900 }))];
  emit("session_start");
  assert.deepEqual(state.updates.at(-1), { key: STATUS_KEY, value: "cache in: 900 (90.0%)" });
});

test("message_end includes the response before persistence; turn_end does not double count it", () => {
  const { state, emit } = harness();
  state.branch = [entry(assistant({ input: 100, cacheRead: 900 }))];
  const ending = assistant({ cacheRead: 1000 });
  emit("message_end", { message: ending });
  assert.equal(state.updates.at(-1).value, "cache in: 1.9k (95.0%)");
  state.branch.push(entry(ending));
  emit("turn_end");
  assert.equal(state.updates.at(-1).value, "cache in: 1.9k (95.0%)");
});

test("non-assistant message_end events do not trigger a history scan", () => {
  const { state, emit } = harness();
  emit("message_end", { message: { role: "toolResult" } });
  assert.equal(state.reads, 0);
});

for (const event of ["agent_settled", "session_tree", "session_compact"]) {
  test(`${event} refreshes from the authoritative current branch`, () => {
    const { state, emit } = harness();
    state.branch = [entry(assistant({ input: 200, cacheRead: 800 }))];
    emit(event);
    assert.equal(state.updates.at(-1).value, "cache in: 800 (80.0%)");
    state.branch = [];
    emit(event);
    assert.equal(state.updates.at(-1).value, undefined);
  });
}

test("a new or resumed empty session clears the old status", () => {
  const { state, emit } = harness();
  state.branch = [entry(assistant({ cacheRead: 1000 }))];
  emit("session_start");
  state.branch = [];
  emit("session_start");
  assert.equal(state.updates.at(-1).value, undefined);
});

test("shutdown removes only this extension's status", () => {
  const { state, emit } = harness();
  emit("session_shutdown");
  assert.deepEqual(state.updates, [{ key: STATUS_KEY, value: undefined }]);
});

test("print, JSON, and RPC sessions do not read history or publish UI status", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const { state, emit } = harness(mode);
    for (const event of ["session_start", "turn_end", "agent_settled", "session_tree", "session_compact", "session_shutdown"]) emit(event);
    emit("message_end", { message: assistant({ cacheRead: 1000 }) });
    assert.equal(state.reads, 0);
    assert.deepEqual(state.updates, []);
  }
});
