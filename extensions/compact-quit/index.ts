import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let running = false;

  pi.registerCommand("compact-quit", {
    description: "Compact the session with Pi, then exit",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /compact-quit", "warning");
        return;
      }
      if (running) return;
      running = true;
      try {
        await ctx.waitForIdle();
        ctx.ui.notify("Compacting the session before exit.", "info");
        await new Promise<void>((resolve, reject) => {
          ctx.compact({ onComplete: () => resolve(), onError: reject });
        });
      } catch (error) {
        // Pi reports these normal no-ops as errors rather than result codes.
        if (!(error instanceof Error && (error.message === "Already compacted"
          || error.message === "Nothing to compact (session too small)"))) {
          ctx.ui.notify("Compaction failed or was cancelled; Pi remains open. Use /compact-quit to retry.", "warning");
          return;
        }
      } finally {
        running = false;
      }
      ctx.shutdown();
    },
  });
}
