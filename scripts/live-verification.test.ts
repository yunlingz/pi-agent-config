import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseLiveArguments } from "./live-verification.ts";

test("live verification defaults to Pi configuration without a fixed provider or model", () => {
  assert.deepEqual(parseLiveArguments(["installed-pi"]), {
    packageDirectory: resolve("installed-pi"), modelOverride: undefined,
  });
});

test("live verification accepts an exact provider/model override, including model slashes", () => {
  assert.equal(parseLiveArguments(["installed-pi", "provider/family/model"]).modelOverride, "provider/family/model");
});

test("live verification rejects partial, malformed, and extra model arguments", () => {
  for (const args of [[], ["pi", "model"], ["pi", "/model"], ["pi", "provider/"],
    ["pi", "provider/ model"], ["pi", "provider/model", "extra"]]) {
    assert.throws(() => parseLiveArguments(args));
  }
});
