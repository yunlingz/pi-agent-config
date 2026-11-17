import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "code-anchor";
const PREFERENCE_ENTRY = "code-anchor-preference";

export interface ControlsContext extends Pick<ExtensionContext, "mode" | "cwd"> {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
  ui: Pick<ExtensionContext["ui"], "setStatus" | "notify">;
}

export interface ControlsCommandContext extends ControlsContext {
  isIdle(): boolean;
}

export type ControlsEvent = "session_start" | "session_tree" | "session_shutdown";
export type ControlsHandler = (event: { type: ControlsEvent }, context: ControlsContext) => void;
export interface ControlsAPI {
  on(name: ControlsEvent, handler: ControlsHandler): unknown;
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: ControlsCommandContext): void;
  }): void;
  appendEntry(customType: string, data: { enabled: boolean }): void;
}

function restoredPreference(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PREFERENCE_ENTRY) continue;
    const data: unknown = entry.data;
    if (data !== null && typeof data === "object" && "enabled" in data && typeof data.enabled === "boolean") {
      return data.enabled;
    }
  }
  return true;
}

export function registerControls(
  pi: ControlsAPI,
  switchTools: (enabled: boolean, context: ControlsContext) => void,
): { isEnabled(): boolean } {
  let enabled = true;
  const publish = (context: ControlsContext): void => {
    if (context.mode === "tui") context.ui.setStatus(STATUS_KEY, enabled ? "code-anchor: on" : "code-anchor: off");
  };
  const restore: ControlsHandler = (_event, context) => {
    const next = restoredPreference(context.sessionManager.getBranch());
    switchTools(next, context);
    enabled = next;
    publish(context);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", (_event, context) => {
    if (context.mode === "tui") context.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.registerCommand("code-anchor", {
    description: "Toggle CodeAnchor, or use on, off, or status",
    handler(args, context) {
      const command = args.trim().toLowerCase();
      if (command === "status") {
        context.ui.notify(enabled ? "CodeAnchor is on" : "CodeAnchor is off", "info");
        return;
      }
      if (!["", "on", "off"].includes(command)) {
        context.ui.notify("Usage: /code-anchor [on|off|status]", "warning");
        return;
      }
      if (!context.isIdle()) {
        context.ui.notify("Wait for the current operation before changing CodeAnchor", "warning");
        return;
      }
      const next = command === "" ? !enabled : command === "on";
      if (next !== enabled) {
        switchTools(next, context);
        enabled = next;
        pi.appendEntry(PREFERENCE_ENTRY, { enabled });
      }
      publish(context);
      context.ui.notify(enabled ? "CodeAnchor is on" : "CodeAnchor is off", "info");
    },
  });
  return { isEnabled: () => enabled };
}
