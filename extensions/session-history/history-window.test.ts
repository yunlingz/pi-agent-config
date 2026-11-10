import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryWindow,
  collectHiddenEntries,
  isDisplayEntry,
  type DisplayEntry,
} from "./history-window.ts";

function message(id: string, role: string) {
  return { type: "message", id, message: { role } };
}

function manager(branch: DisplayEntry[], context: DisplayEntry[]) {
  return {
    getBranch: () => branch,
    buildContextEntries: () => context,
  };
}

test("only transcript entries are eligible for restored history", () => {
  assert.equal(isDisplayEntry(message("u", "user")), true);
  assert.equal(isDisplayEntry(message("a", "assistant")), true);
  assert.equal(isDisplayEntry(message("t", "toolResult")), true);
  assert.equal(isDisplayEntry(message("s", "system")), false);
  assert.equal(isDisplayEntry({ type: "custom_message", display: true }), true);
  assert.equal(isDisplayEntry({ type: "custom_message", display: false }), false);
  assert.equal(isDisplayEntry({ type: "compaction" }), true);
  assert.equal(isDisplayEntry({ type: "branch_summary" }), true);
  assert.equal(isDisplayEntry({ type: "custom" }), false);
});

test("hidden collection excludes entries in Pi's compacted view", () => {
  const oldUser = message("old-user", "user");
  const oldAssistant = message("old-assistant", "assistant");
  const summary = { type: "compaction", id: "summary" };
  const currentUser = message("current-user", "user");
  const hidden = collectHiddenEntries(manager(
    [oldUser, oldAssistant, summary, currentUser],
    [summary, currentUser],
  ));

  assert.deepEqual(hidden.map((entry) => entry.id), ["old-user", "old-assistant"]);
});

test("the initial window is bounded and does not start inside tool results", () => {
  const entries = [
    message("u1", "user"),
    message("a1", "assistant"),
    message("t1", "toolResult"),
    message("t2", "toolResult"),
    message("u2", "user"),
    message("a2", "assistant"),
  ];
  const window = new HistoryWindow({ initialEntries: 4, loadEntries: 2 });
  const snapshot = window.refresh(entries);

  assert.equal(snapshot.earliestEntryId, "a1");
  assert.deepEqual(snapshot.selected.map((entry) => entry.id), ["a1", "t1", "t2", "u2", "a2"]);
  assert.equal(snapshot.remaining, 1);
});

test("automatic loading prepends one bounded chunk", () => {
  const entries = Array.from({ length: 10 }, (_, index) => message(`u${index}`, "user"));
  const window = new HistoryWindow({ initialEntries: 4, loadEntries: 3 });
  window.refresh(entries);

  assert.equal(window.snapshot().earliestEntryId, "u6");
  assert.equal(window.loadMore().earliestEntryId, "u3");
  assert.equal(window.loadMore().earliestEntryId, "u0");
  assert.equal(window.hasMore, false);
});

test("refresh keeps the earliest loaded entry when compaction adds history", () => {
  const first = Array.from({ length: 8 }, (_, index) => message(`u${index}`, "user"));
  const window = new HistoryWindow({ initialEntries: 3, loadEntries: 2 });
  window.refresh(first);
  const earliest = window.loadMore().earliestEntryId;

  const afterCompaction = [
    ...first,
    message("u8", "user"),
    message("a8", "assistant"),
  ];
  const refreshed = window.refresh(afterCompaction, earliest);

  assert.equal(refreshed.earliestEntryId, earliest);
  const lastEntry = refreshed.selected.at(-1);
  assert.ok(lastEntry);
  assert.equal(lastEntry.id, "a8");
});

test("load all reaches the beginning of saved history", () => {
  const entries = Array.from({ length: 20 }, (_, index) => message(`u${index}`, "user"));
  const window = new HistoryWindow({ initialEntries: 2, loadEntries: 1 });
  window.refresh(entries);

  const snapshot = window.loadAll();
  assert.equal(snapshot.remaining, 0);
  assert.equal(snapshot.earliestEntryId, "u0");
  assert.equal(snapshot.selected.length, 20);
});
