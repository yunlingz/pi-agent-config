import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSurfaceDefaults } from "../../themes/surfaces.ts";

export default function (pi: ExtensionAPI): void {
  let restore: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("ci-dark-surfaces", (tui, theme) => {
      restore?.();
      restore = installSurfaceDefaults(tui, theme);
      let colors = theme.colors;
      return {
        render: () => [],
        invalidate() {
          if (theme.colors === colors) return;
          colors = theme.colors;
          tui.requestRender(true);
        },
        dispose: () => restore?.(),
      };
    });
  });
  pi.on("session_shutdown", () => { restore?.(); restore = undefined; });
}
