import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageArgument = process.argv[2];
assert.ok(packageArgument, "Usage: node themes/verify.mjs <installed-pi-package-directory>");
const packageDirectory = resolve(packageArgument);
const agentDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const themePath = join(agentDirectory, "themes", "ci_dark.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const packageInfo = readJson(join(packageDirectory, "package.json"));
assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
const require = createRequire(pathToFileURL(join(packageDirectory, "package.json")));
let themeApi;
let succeeded = false;
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] Checking ci_dark with installed Pi ${packageInfo.version}\n`);
}, 20_000);

function contrast(first, second) {
  const luminance = ({ r, g, b }) => {
    const channels = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

try {
  const { Check } = await import(pathToFileURL(require.resolve("typebox/value")).href);
  const schema = readJson(join(packageDirectory, "schemas", "theme.schema.json"));
  const document = readJson(themePath);
  assert.ok(Check(schema, document), "ci_dark must match the installed theme schema");
  assert.equal(document.name, "ci_dark");
  assert.equal(document.appearance, "dark");

  const moduleDirectory = join(packageDirectory, "dist", "modes", "interactive", "theme");
  themeApi = await import(pathToFileURL(join(moduleDirectory, "theme.js")).href);
  const { validateThemeJson } = await import(pathToFileURL(join(moduleDirectory, "theme-schema.js")).href);
  const { THEME_TOKENS } = await import(pathToFileURL(join(moduleDirectory, "theme-tokens.js")).href);
  const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
  themeApi.setThemeJsonValidator(validateThemeJson);
  validateThemeJson(themePath, document);
  assert.deepEqual(Object.keys(document.colors).sort(), Object.keys(THEME_TOKENS).sort());

  const pairs = [
    ["text", "background"],
    ["muted", "background"],
    ["thinkingText", "background"],
    ["userMessageText", "userMessageBg"],
    ["customMessageText", "customMessageBg"],
    ["customMessageLabel", "customMessageBg"],
    ["text", "selectedBg"],
    ["accent", "selectedBg"],
    ["muted", "toolPendingBg"],
    ["searchMatchText", "searchMatchBg"],
  ];
  for (const background of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
    pairs.push(["toolTitle", background], ["toolOutput", background]);
  }
  for (const token of Object.keys(THEME_TOKENS)) {
    if (token.startsWith("syntax") || token.startsWith("toolDiff")) {
      pairs.push([token, "background"]);
    }
  }
  const neutralTokens = [
    "userMessageBg", "customMessageBg", "toolPendingBg",
    "muted", "thinkingText", "syntaxComment", "dim", "border", "borderMuted", "thinkingOff", "thinkingMinimal",
  ];
  const { ToolExecutionComponent } = await import(pathToFileURL(
    join(packageDirectory, "dist", "modes", "interactive", "components", "tool-execution.js"),
  ).href);

  for (const mode of ["truecolor", "256color"]) {
    const loaded = themeApi.loadThemeFromPath(themePath, mode);
    const effective = {};
    for (const [token, descriptor] of Object.entries(THEME_TOKENS)) {
      const ansi = descriptor.slot === "background" ? loaded.getBgAnsi(token) : loaded.getFgAnsi(token);
      if (mode === "truecolor") {
        assert.match(ansi, /^\x1b\[(?:38|48);2;\d+;\d+;\d+m$/);
        effective[token] = tui.colorToRgb(loaded.colors[token]);
      } else {
        const match = ansi.match(/^\x1b\[(?:38|48);5;(\d+)m$/);
        assert.ok(match, `${token} must use indexed output in 256-color mode`);
        effective[token] = tui.colorToRgb(tui.indexedColor(Number(match[1])));
      }
    }
    // The terminal owns its canvas; assess unboxed text against ci_dark's recommended background.
    effective.background = tui.colorToRgb(tui.parseColor(document.vars.background));
    const card = effective.toolSuccessBg;
    const canvas = effective.background;
    assert.ok(card.r < canvas.r && card.g < canvas.g && card.b < canvas.b,
      `${mode}: completed tool cards must be darker than the canvas`);
    assert.ok(contrast(card, canvas) >= 1.08,
      `${mode}: completed tool cards must visibly separate from the canvas`);
    const toolStates = [
      { token: "toolPendingBg", partial: true, error: false },
      { token: "toolSuccessBg", partial: false, error: false },
      { token: "toolErrorBg", partial: false, error: true },
    ];
    const stateColors = toolStates.map(({ token }) => JSON.stringify(effective[token]));
    assert.equal(new Set(stateColors).size, 3, `${mode}: running, success, and error cards must remain distinct`);
    if (mode === "truecolor") {
      assert.ok(card.g > card.r && card.g > card.b, "Successful tool cards must retain a subtle green tint");
      const failure = effective.toolErrorBg;
      assert.ok(failure.r > failure.g && failure.r > failure.b, "Failed tool cards must retain a red tint");
    }
    themeApi.setThemeInstance(loaded);
    const component = new ToolExecutionComponent("preview", "preview-call", {},
      { showImages: false }, undefined, { requestRender() {} }, agentDirectory);
    for (const state of toolStates) {
      component.updateResult({ content: [{ type: "text", text: "State preview" }], isError: state.error }, state.partial);
      const rendered = component.render(80).join("\n");
      assert.ok(rendered.includes(loaded.getBgAnsi(state.token)), `${mode}: native tool renderer must apply ${state.token}`);
    }
    const ratios = pairs.map(([foreground, background]) => {
      const ratio = contrast(effective[foreground], effective[background]);
      assert.ok(ratio >= 4.5, `${mode}: ${foreground} on ${background} is only ${ratio.toFixed(2)}:1`);
      return ratio;
    });
    assert.ok(contrast(effective.dim, effective.background) >= 3, `${mode}: dim metadata must remain readable`);
    assert.ok(contrast(effective.dim, effective.selectedBg) >= 3, `${mode}: selected tree metadata must remain readable`);
    if (mode === "256color") {
      for (const token of neutralTokens) {
        const { r, g, b } = effective[token];
        assert.ok(r === g && g === b, `${token} must stay neutral, not acquire a colored cast in 256-color mode`);
      }
    }
    console.log(`PASS: ${mode}; ${Object.keys(effective).length - 1} roles; ${pairs.length} contrast checks; minimum ${Math.min(...ratios).toFixed(2)}:1; native tool-state transitions`);
  }

  const footer = readJson(join(agentDirectory, "extensions", "powerline-footer", "theme.json"));
  assert.deepEqual(Object.keys(footer), ["colors"]);
  for (const token of Object.values(footer.colors)) {
    assert.equal(THEME_TOKENS[token]?.slot, "foreground", "Footer colors must follow Pi foreground roles");
  }
  console.log(`PASS: Powerline colors follow semantic theme roles; installed Pi ${packageInfo.version}`);
  succeeded = true;
} finally {
  themeApi?.stopThemeWatcher();
  clearInterval(heartbeat);
  process.stderr.write(`${succeeded ? "SUCCESS" : "FAILED"}: ci_dark theme verification\n`);
}
