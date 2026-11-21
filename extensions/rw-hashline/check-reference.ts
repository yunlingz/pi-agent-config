import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// This maintained manifest is local configuration, not an external response.
const reference = JSON.parse(await readFile(new URL("./reference.json", import.meta.url), "utf8")) as {
  package: string; version: string; integrity: string;
};
const result = spawnSync("npm", ["view", reference.package, "version", "dist.integrity", "--json",
  "--registry=https://registry.npmjs.org/", "--fetch-timeout=20000", "--fetch-retries=0", "--ignore-scripts", "--loglevel=error"], {
  encoding: "utf8", timeout: 25_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
assert.equal(result.status, 0, "Cannot check the code reference. Registry diagnostics are withheld.");
const metadata: unknown = JSON.parse(result.stdout);
assert(metadata && typeof metadata === "object" && "version" in metadata && typeof metadata.version === "string"
  && "dist.integrity" in metadata && typeof metadata["dist.integrity"] === "string", "Invalid npm reference metadata.");
if (metadata.version === reference.version) {
  assert.equal(metadata["dist.integrity"], reference.integrity, "The recorded package version has different integrity metadata. Review before trusting it.");
  console.log(`UNCHANGED: ${reference.package}@${reference.version}; published integrity matches the code reference.`);
} else {
  console.log(`REVIEW: recorded ${reference.package}@${reference.version}; npm reports ${metadata.version}.`);
  console.log("Inspect relevant source and tests before adopting changes. OMP is reference code, not an upstream dependency.");
}
