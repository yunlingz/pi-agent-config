import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { AutoCompactController, QUIT_COMMAND, routeQuitSubmission } from "./controller.mjs";

export default function (pi: ExtensionAPI) {
  const controller = new AutoCompactController();
  let unsubscribeInput: (() => void) | undefined;

  pi.registerCommand(QUIT_COMMAND, {
    description: "Compact the session, then quit when Pi's work is finished",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify(`Usage: /${QUIT_COMMAND}`, "warning");
        return;
      }
      controller.requestQuit(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    controller.start(ctx);
    if (ctx.mode === "tui") {
      unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        controller.activity();
        const isSubmit = !controller.isPromptOpen
          && getKeybindings().matches(data, "tui.input.submit");
        routeQuitSubmission(ctx, isSubmit);
        return undefined;
      });
    }
  });

  pi.on("input", () => controller.activity());
  pi.on("message_end", () => controller.activity());
  pi.on("before_agent_start", () => controller.beforeWork());
  pi.on("agent_settled", () => controller.workFinished());
  pi.on("tool_execution_start", (event) => controller.toolStarted(event.toolCallId));
  pi.on("tool_execution_end", (event) => controller.toolEnded(event.toolCallId));
  pi.on("session_before_compact", () => controller.beforeWork());
  pi.on("session_compact", () => controller.workFinished());
  pi.on("session_compact_failed", () => controller.workFinished());
  pi.on("session_tree", () => controller.activity());
  pi.on("ui_prompt_start", () => controller.promptStarted());
  pi.on("ui_prompt_end", () => controller.promptEnded());
  pi.on("user_bash", (event) => controller.shellStarted(event.command));

  pi.on("session_shutdown", () => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    controller.stop();
  });
}
