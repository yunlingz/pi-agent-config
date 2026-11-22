import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Surfaces from "./surfaces.ts";
import { testTUI } from "../scripts/test-fixtures.ts";

assert(process.env.PI_TEST_PACKAGE_DIR, "Set PI_TEST_PACKAGE_DIR to the installed Pi package directory.");
const packageDirectory = resolve(process.env.PI_TEST_PACKAGE_DIR);
const require = createRequire(join(packageDirectory, "package.json"));
const { createJiti }: typeof import("jiti") = await import(pathToFileURL(require.resolve("jiti")).href);
const root = await mkdtemp(join(tmpdir(), "pi-surface-tests-"));
after(async () => { await rm(root, { recursive: true, force: true }); });
const jiti = createJiti(import.meta.url, { fsCache: join(root, "jiti"), alias: {
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const { colorSurfaceOutput, installSurfaceDefaults } = await jiti.import<typeof Surfaces>(new URL("./surfaces.ts", import.meta.url).pathname);
const themeApi: typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") =
  await import(pathToFileURL(join(packageDirectory, "dist/modes/interactive/theme/theme.js")).href);
const theme = themeApi.loadThemeFromPath(new URL("./ci-dark.json", import.meta.url).pathname, "truecolor");
const defaults = "\x1b[38;2;246;248;250m\x1b[48;2;36;41;46m";

test("default colors replace resets without recoloring explicit syntax or panels", () => {
  assert.equal(colorSurfaceOutput("\x1b[0mplain\x1b[38;2;115;227;255mcode\x1b[39mtext", theme),
    `\x1b[0m${defaults}plain\x1b[38;2;115;227;255mcode${theme.getFgAnsi("text")}text`);
  assert.equal(colorSurfaceOutput("\x1b[48;2;27;36;31mcard\x1b[49m", theme), "\x1b[48;2;27;36;31mcard\x1b[48;2;36;41;46m");
  assert.equal(colorSurfaceOutput("\x1b[1;0;3mtext", theme), `\x1b[1m\x1b[0m${defaults}\x1b[3mtext`);
});

test("extended RGB channels equal to reset codes stay intact", () => {
  const input = "\x1b[38;2;0;39;49mcolor\x1b[48;5;0mbackground";
  assert.equal(colorSurfaceOutput(input, theme), input);
});

test("links, image payloads, and cursor controls stay unchanged", () => {
  const input = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b_Ga=T;SGVsbG8=\x1b\\\x1b[?25h";
  assert.equal(colorSurfaceOutput(input, theme), input);
});

test("Powerline prompt and separator colors use ci-dark roles", () => {
  assert.equal(colorSurfaceOutput("\x1b[38;2;200;200;200m>\x1b[38;5;244m|", theme), `${theme.getFgAnsi("text")}>${theme.getFgAnsi("dim")}|`);
});

test("other themes pass through without color substitution", () => {
  const other = themeApi.getThemeByName("dark");
  assert(other);
  const input = "\x1b[0m\x1b[39m\x1b[49m\x1b[38;5;244mtext";
  assert.equal(colorSurfaceOutput(input, other), input);
});

test("installed writer preserves split CSI sequences, images, and existing transport", () => {
  const writes: string[] = [];
  const tui = testTUI({ render: () => [], invalidate() {} });
  const original = (data: string) => { writes.push(data); };
  tui.terminal.write = original;
  const restore = installSurfaceDefaults(tui, theme);
  assert.equal(writes.join(""), `\x1b[0m${defaults}`);
  writes.length = 0;
  tui.terminal.write("\x1b[38;2;0;39;");
  tui.terminal.write("49mcode\x1b[");
  tui.terminal.write("0mplain\x1b_Ga=T;");
  tui.terminal.write("SGVsbG8=\x1b\\");
  assert.equal(writes.join(""), `\x1b[38;2;0;39;49mcode\x1b[0m${defaults}plain\x1b_Ga=T;SGVsbG8=\x1b\\`);
  restore();
  assert.equal(tui.terminal.write, original);
  assert.equal(writes.at(-1), "\x1b[0m");
});
