import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  registerControls, STATUS_KEY,
  type ControlsAPI, type ControlsCommandContext, type ControlsEvent, type ControlsHandler,
} from "./controls.ts";

function fixture(mode: ControlsCommandContext["mode"] = "tui") {
  const handlers = new Map<ControlsEvent, ControlsHandler>();
  let command: Parameters<ControlsAPI["registerCommand"]>[1] | undefined;
  const entries: SessionEntry[] = [];
  const transitions: boolean[] = [];
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  let idle = true;
  let failSwitch = false;
  const context: ControlsCommandContext = {
    mode, cwd: "/workspace",
    sessionManager: { getBranch: () => entries },
    isIdle: () => idle,
    ui: {
      setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify(message) { notifications.push(message); },
    },
  };
  const api: ControlsAPI = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, value) { assert.equal(name, "code-anchor"); command = value; },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data, id: String(entries.length), parentId: null, timestamp: new Date().toISOString() });
    },
  };
  const controls = registerControls(api, enabled => {
    if (failSwitch) throw new Error("fixture switch failed");
    transitions.push(enabled);
  });
  return {
    controls, entries, transitions, statuses, notifications,
    setIdle(value: boolean) { idle = value; },
    failNextSwitch() { failSwitch = true; },
    emit(type: ControlsEvent) { const handler = handlers.get(type); assert(handler); handler({ type }, context); },
    command(args: string) { assert(command); command.handler(args, context); },
  };
}

test("starts enabled and publishes an on status without changing stored preferences", () => {
  const state = fixture();
  assert.deepEqual(state.transitions, []);
  state.emit("session_start");
  assert.deepEqual(state.transitions, [true]);
  assert.equal(state.statuses.get(STATUS_KEY), "code-anchor: on");
  assert.equal(state.entries.length, 0);
});

test("toggles both ways and restores the active branch preference", () => {
  const state = fixture();
  state.emit("session_start");
  state.command("");
  assert.equal(state.controls.isEnabled(), false);
  assert.equal(state.statuses.get(STATUS_KEY), "code-anchor: off");
  state.emit("session_start");
  assert.equal(state.controls.isEnabled(), false);
  state.command("on");
  assert.equal(state.controls.isEnabled(), true);
  state.entries.pop();
  state.emit("session_tree");
  assert.equal(state.controls.isEnabled(), false);
  assert.deepEqual(state.transitions, [true, false, false, true, false]);
});

test("busy and invalid commands do not change tools or stored preferences", () => {
  const state = fixture();
  state.emit("session_start");
  state.setIdle(false);
  state.command("off");
  state.setIdle(true);
  state.command("invalid");
  state.command("status");
  assert.deepEqual(state.transitions, [true]);
  assert.equal(state.entries.length, 0);
  assert.equal(state.notifications.length, 3);
});

test("a failed tool switch does not save or report the new state", () => {
  const state = fixture();
  state.emit("session_start");
  state.failNextSwitch();
  assert.throws(() => state.command("off"), /fixture switch failed/u);
  assert.equal(state.controls.isEnabled(), true);
  assert.equal(state.entries.length, 0);
  assert.equal(state.statuses.get(STATUS_KEY), "code-anchor: on");
});

test("shutdown clears only CodeAnchor status", () => {
  const state = fixture();
  state.statuses.set("another-extension", "preserved");
  state.emit("session_start");
  state.emit("session_shutdown");
  assert.equal(state.statuses.has(STATUS_KEY), false);
  assert.equal(state.statuses.get("another-extension"), "preserved");
});

test("non-TUI modes keep the toggle without publishing footer state", () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const state = fixture(mode);
    state.emit("session_start");
    state.command("off");
    assert.equal(state.controls.isEnabled(), false);
    assert.equal(state.statuses.size, 0);
  }
});
