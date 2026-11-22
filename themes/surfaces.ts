import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type TUI } from "@earendil-works/pi-tui";

/** Fill default-colored regions without replacing explicit syntax or panel colors. */
export function colorSurfaceOutput(data: string, theme: Theme): string {
  if (theme.name !== "ci_dark") return data;
  const foreground = theme.getFgAnsi("text");
  // ci_dark uses the canvas color for text on its yellow search highlight.
  const background = backgroundAnsi(theme.colors.searchMatchText, theme.getColorMode());
  const defaults = foreground + background;
  const output = data.replace(/\x1b\[([0-9;]*)m/gu, (sequence, parameters: string) => {
    // Powerline's editor prompt and separators bypass its theme override file.
    if (parameters === "38;2;200;200;200") return foreground;
    if (parameters === "38;5;244") return theme.getFgAnsi("dim");
    const values = parameters === "" ? [0] : parameters.split(";").map(Number);
    const parts: string[] = [];
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (value === 0) parts.push("\x1b[0m", defaults);
      else if (value === 39) parts.push(foreground);
      else if (value === 49) parts.push(background);
      else if (value === 38 || value === 48 || value === 58) {
        const last = index + (values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0);
        parts.push(`\x1b[${values.slice(index, last + 1).join(";")}m`);
        index = last;
      } else parts.push(`\x1b[${value}m`);
    }
    return parts.join("") || sequence;
  });
  return output;
}

/** The widget factory provides the active TUI; shutdown restores its original transport. */
export function installSurfaceDefaults(tui: TUI, theme: Theme): () => void {
  const terminal = tui.terminal;
  const originalWrite = terminal.write;
  let pending = "";
  let colors = theme.colors;
  const write = (data: string) => {
    if (theme.colors !== colors) {
      originalWrite.call(terminal, colorSurfaceOutput("\x1b[0m", theme));
      colors = theme.colors;
    }
    const combined = pending + data;
    // The host's bounded writer can split a CSI color sequence between chunks.
    const partial = /\x1b(?:\[[0-9;]*)?$/u.exec(combined);
    pending = partial?.[0] ?? "";
    originalWrite.call(terminal, colorSurfaceOutput(combined.slice(0, combined.length - pending.length), theme));
  };
  terminal.write = write;
  if (theme.name === "ci_dark") originalWrite.call(terminal, colorSurfaceOutput("\x1b[0m", theme));
  tui.requestRender(true);
  return () => {
    if (terminal.write !== write) return;
    terminal.write = originalWrite;
    originalWrite.call(terminal, pending + "\x1b[0m");
  };
}
