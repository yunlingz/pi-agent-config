import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionClock, IDLE_INTERVAL_MS } from "./compaction-fixtures.ts";

test("the extension clock preserves process globals and fires at the exact idle boundary", async () => {
  const clock = createExtensionClock();
  const nativeNow = Date.now;
  const nativeSetTimeout = setTimeout;
  let fired = 0;
  try {
    await clock.load(async () => {
      const extensionNow = Date.now;
      const start = extensionNow();
      setTimeout(() => { fired += 1; assert.equal(extensionNow(), start + IDLE_INTERVAL_MS); }, IDLE_INTERVAL_MS).unref();
    });
    assert.equal(Date.now, nativeNow);
    assert.equal(setTimeout, nativeSetTimeout);
    clock.advance(IDLE_INTERVAL_MS - 1);
    assert.equal(fired, 0);
    clock.advance(1);
    assert.equal(fired, 1);
    clock.advance(IDLE_INTERVAL_MS);
    assert.equal(fired, 1);
  } finally {
    clock.dispose();
  }
});

test("the extension clock restores globals after load failure and honors cancellation", async () => {
  const clock = createExtensionClock();
  const nativeNow = Date.now;
  const nativeSetTimeout = setTimeout;
  try {
    await assert.rejects(clock.load(async () => {
      const handle = setTimeout(() => assert.fail("Cancelled timer fired"), IDLE_INTERVAL_MS);
      clearTimeout(handle);
      throw new Error("fixture failure");
    }), /fixture failure/u);
    assert.equal(Date.now, nativeNow);
    assert.equal(setTimeout, nativeSetTimeout);
    clock.advance(IDLE_INTERVAL_MS);
  } finally {
    clock.dispose();
  }
});
