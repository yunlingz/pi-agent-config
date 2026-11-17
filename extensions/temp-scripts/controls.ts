import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "temp-scripts";
export const PREFERENCE_ENTRY = "temp-scripts-preference";
export const TOOL_NAMES = ["script_inline", "script_js", "script_job"];

export function restoredPreference(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PREFERENCE_ENTRY) continue;
    const value: unknown = entry.data;
    if (value !== null && typeof value === "object" && "enabled" in value && typeof value.enabled === "boolean") return value.enabled;
  }
  return true;
}

export function registerControls(pi: ExtensionAPI, switchEnabled: (next: boolean) => void, isBusy: () => boolean): void {
  let enabled = true;
  const publish = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, enabled ? "scripts: on" : "scripts: off");
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    const next = restoredPreference(ctx.sessionManager.getBranch());
    switchEnabled(next);
    enabled = next;
    publish(ctx);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.registerCommand("temp-scripts", {
    description: "Toggle managed scripts and shell gates, or use on, off, or status",
    async handler(args, ctx) {
      const command = args.trim().toLowerCase();
      if (command === "status") {
        ctx.ui.notify(enabled ? "Managed scripts are on; agent shell tools are blocked" : "Managed scripts are off; retained files are unchanged", "info");
        return;
      }
      if (!["", "on", "off"].includes(command)) { ctx.ui.notify("Usage: /temp-scripts [on|off|status]", "warning"); return; }
      if (!ctx.isIdle() || isBusy()) { ctx.ui.notify("Wait for active work before changing managed scripts", "warning"); return; }
      const next = command === "" ? !enabled : command === "on";
      if (next !== enabled) {
        switchEnabled(next);
        enabled = next;
        pi.appendEntry(PREFERENCE_ENTRY, { enabled });
      }
      publish(ctx);
      ctx.ui.notify(enabled ? "Managed scripts are on; agent shell tools are blocked" : "Managed scripts are off; retained files are unchanged", "info");
    },
  });
}
