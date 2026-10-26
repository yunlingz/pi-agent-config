import assert from "node:assert/strict";
import test from "node:test";
import {
  AutoCompactController,
  IDLE_MS,
  QUIT_COMMAND,
  inspectHistory,
  routeQuitSubmission,
} from "./controller.mjs";

class FakeClock {
  time = 0;
  timers = new Map();

  now = () => this.time;

  setTimer = (callback, delay) => {
    const handle = { unref() {} };
    this.timers.set(handle, { callback, due: this.time + delay });
    return handle;
  };

  clearTimer = (handle) => {
    this.timers.delete(handle);
  };

  advance(duration) {
    const target = this.time + duration;
    let iterations = 0;
    while (true) {
      let next;
      for (const [handle, timer] of this.timers) {
        if (timer.due <= target && (!next || timer.due < next.timer.due)) {
          next = { handle, timer };
        }
      }
      if (!next) {
        break;
      }
      assert.ok(iterations++ < 100_000, "Fake timer loop did not settle");
      this.timers.delete(next.handle);
      this.time = next.timer.due;
      next.timer.callback();
    }
    this.time = target;
  }
}

function message(id, role, fields = {}) {
  return { type: "message", id, message: { role, timestamp: 0, ...fields } };
}

function harness({ mode = "tui", history = [message("u1", "user"), message("a1", "assistant")] } = {}) {
  const clock = new FakeClock();
  const controller = new AutoCompactController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const state = {
    history,
    idle: true,
    pending: false,
    calls: [],
    notifications: [],
    shutdowns: 0,
    editor: "",
  };
  const ctx = {
    mode,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: {
      getBranch: () => state.history,
      getLeafId: () => state.history.at(-1)?.id ?? null,
    },
    ui: {
      notify: (text, kind) => state.notifications.push({ text, kind }),
      getEditorText: () => state.editor,
      setEditorText: (text) => { state.editor = text; },
    },
    compact: (options) => {
      state.calls.push(options);
      state.idle = false;
      controller.beforeWork();
    },
    shutdown: () => {
      state.shutdowns += 1;
      controller.stop();
    },
  };
  controller.start(ctx);

  function complete({ newMessages = [], remainsBusy = false } = {}) {
    state.history.push({ type: "compaction", id: `c${state.calls.length}` });
    state.history.push(...newMessages);
    state.idle = !remainsBusy;
    controller.workFinished();
    state.calls.at(-1).onComplete({ summary: "Test summary" });
    clock.advance(0);
  }

  function fail(messageText) {
    state.idle = true;
    controller.workFinished();
    state.calls.at(-1).onError(new Error(messageText));
    clock.advance(0);
  }

  return { clock, controller, state, ctx, complete, fail };
}

test("the idle interval is exactly 30 minutes", () => {
  assert.equal(IDLE_MS, 1_800_000);
});

test("constructing the controller starts no resources", () => {
  const clock = new FakeClock();
  new AutoCompactController({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(clock.timers.size, 0);
});

test("non-interactive modes never start idle timers or compact on shutdown", () => {
  for (const mode of ["json", "print", "rpc"]) {
    const h = harness({ mode });
    h.clock.advance(24 * 60 * 60 * 1000);
    h.controller.stop();
    assert.equal(h.clock.timers.size, 0);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.shutdowns, 0);
  }
});

test("idle compaction starts at 30 minutes, once per unchanged idle spell", () => {
  const h = harness();
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0].customInstructions, "Write the compaction summary in English.");
  h.complete();
  h.clock.advance(24 * 60 * 60 * 1000);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.shutdowns, 0);
});

test("typing or other interaction restarts the full idle countdown", () => {
  const h = harness();
  h.clock.advance(20 * 60 * 1000);
  h.controller.activity();
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 1);
});

test("running agent work and retries do not count as inactivity", () => {
  const h = harness();
  h.state.idle = false;
  h.controller.beforeWork();
  h.clock.advance(2 * IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.state.idle = true;
  h.controller.workFinished();
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 1);
});

test("the final idle check refuses busy sessions even without a start notification", () => {
  const h = harness();
  h.state.idle = false;
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 0);
});

test("queued messages prevent compaction", () => {
  const h = harness();
  h.state.pending = true;
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.state.pending = false;
  h.controller.workFinished();
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 1);
});

test("parallel tools must all finish before the idle countdown can expire", () => {
  const h = harness();
  h.controller.toolStarted("tool-a");
  h.controller.toolStarted("tool-b");
  h.clock.advance(2 * IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.controller.toolEnded("tool-a");
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.controller.toolEnded("tool-b");
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 1);
});

test("nested blocking prompts pause idle compaction until every prompt closes", () => {
  const h = harness();
  h.controller.promptStarted();
  h.controller.promptStarted();
  h.clock.advance(2 * IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.controller.promptEnded();
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.controller.promptEnded();
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 1);
});

test("external compaction pauses the timer and completion rearms it", () => {
  const h = harness();
  h.state.idle = false;
  h.controller.beforeWork();
  h.clock.advance(2 * IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.state.idle = true;
  h.controller.workFinished();
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 1);
});

test("quit waits for successful compaction before shutdown", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.shutdowns, 0);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
  assert.equal(h.clock.timers.size, 0);
});

test("quit waits for running work instead of aborting it", () => {
  const h = harness();
  h.state.idle = false;
  h.controller.requestQuit(h.ctx);
  h.clock.advance(5 * 60 * 1000);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.shutdowns, 0);
  h.state.idle = true;
  h.controller.workFinished();
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 1);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
});

test("quit during idle compaction shares the existing attempt", () => {
  const h = harness();
  h.clock.advance(IDLE_MS);
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.shutdowns, 0);
  h.complete();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.shutdowns, 1);
});

test("repeated quit requests cannot start parallel compactions", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 1);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
});

test("input queued during pre-quit compaction is finished and compacted before exit", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  h.complete({ newMessages: [message("u2", "user")], remainsBusy: true });
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.shutdowns, 0);
  h.state.history.push(message("a2", "assistant"));
  h.state.idle = true;
  h.controller.workFinished();
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.shutdowns, 0);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
});

test("pre-quit failure keeps Pi open and permits an explicit retry", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  h.fail("test provider failure: sensitive-details");
  assert.equal(h.state.shutdowns, 0);
  assert.equal(h.controller.quitting, false);
  assert.ok(h.state.notifications.some(({ text }) => text.includes("Pi remains open")));
  assert.ok(h.state.notifications.every(({ text }) => !text.includes("sensitive-details")));
  h.clock.advance(4 * IDLE_MS);
  assert.equal(h.state.calls.length, 1);
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  assert.equal(h.state.calls.length, 2);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
});

test("cancelling compaction also cancels the pending quit", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  h.fail("Compaction cancelled");
  assert.equal(h.state.shutdowns, 0);
  assert.equal(h.controller.quitting, false);
});

test("idle failure is not retried until new activity", () => {
  const h = harness();
  h.clock.advance(IDLE_MS);
  h.fail("test failure");
  h.clock.advance(4 * IDLE_MS);
  assert.equal(h.state.calls.length, 1);
  h.controller.activity();
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 2);
});

for (const reason of ["Already compacted", "Nothing to compact (session too small)"]) {
  test(`native no-op permits quit: ${reason}`, () => {
    const h = harness();
    h.controller.requestQuit(h.ctx);
    h.clock.advance(0);
    h.fail(reason);
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.shutdowns, 1);
  });
}

test("empty and already-compacted sessions exit without a model request", () => {
  const histories = [
    [],
    [message("s1", "system"), { type: "custom", id: "meta1" }],
    [message("u1", "user"), { type: "compaction", id: "c1" }, { type: "custom", id: "meta1" }],
  ];
  for (const history of histories) {
    const h = harness({ history });
    h.controller.requestQuit(h.ctx);
    h.clock.advance(0);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.shutdowns, 1);
  }
});

test("synchronous compaction errors cannot accidentally exit Pi", () => {
  const h = harness();
  h.ctx.compact = () => { throw new Error("test synchronous failure"); };
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  assert.equal(h.state.shutdowns, 0);
  assert.equal(h.controller.quitting, false);
});

test("shutdown cleanup clears timers and ignores late compaction callbacks", () => {
  const h = harness();
  h.controller.requestQuit(h.ctx);
  h.clock.advance(0);
  const callback = h.state.calls[0].onComplete;
  h.controller.stop();
  h.ctx.ui.notify = () => { throw new Error("stale context used"); };
  assert.doesNotThrow(() => callback({ summary: "late result" }));
  h.clock.advance(24 * 60 * 60 * 1000);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.state.shutdowns, 0);
});

test("restarting for a new session discards the old idle deadline", () => {
  const h = harness();
  h.clock.advance(IDLE_MS - 1);
  h.controller.start(h.ctx);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 1);
});

test("activity during idle compaction rearms from the completion of that work", () => {
  const h = harness();
  h.clock.advance(IDLE_MS);
  h.controller.activity();
  h.complete();
  h.state.history.push(message("u2", "user"));
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 1);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 2);
});

test("manual shell work is busy until a result is recorded, then gets a full idle interval", () => {
  const h = harness();
  h.controller.shellStarted("example command");
  h.clock.advance(IDLE_MS);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(10_000);
  h.state.history.push(message("bash1", "bashExecution", {
    command: "example command",
    timestamp: h.clock.now(),
  }));
  h.clock.advance(IDLE_MS - 1);
  assert.equal(h.state.calls.length, 0);
  h.clock.advance(1);
  assert.equal(h.state.calls.length, 1);
});

test("quit waits for manual shell completion too", () => {
  const h = harness();
  h.controller.shellStarted("example command");
  h.controller.requestQuit(h.ctx);
  h.clock.advance(60_000);
  assert.equal(h.state.calls.length, 0);
  h.state.history.push(message("bash1", "bashExecution", {
    command: "example command",
    timestamp: h.clock.now(),
  }));
  h.clock.advance(1000);
  assert.equal(h.state.calls.length, 1);
  h.complete();
  assert.equal(h.state.shutdowns, 1);
});

test("an unrecorded shell result conservatively prevents idle compaction", () => {
  const h = harness();
  h.controller.shellStarted("example command");
  h.clock.advance(5 * IDLE_MS);
  assert.equal(h.state.calls.length, 0);
});

test("history inspection ignores metadata, system messages, and excluded shell output", () => {
  assert.equal(inspectHistory([
    message("u1", "user"),
    { type: "compaction", id: "c1" },
    { type: "custom", id: "meta1" },
    message("s1", "system"),
    message("bash1", "bashExecution", { excludeFromContext: true }),
  ]).needsCompaction, false);
  assert.deepEqual(inspectHistory([
    { type: "compaction", id: "c1" },
    { type: "custom_message", id: "custom1" },
    { type: "context_edit", id: "edit1" },
  ]), { marker: "edit1", needsCompaction: true });
});

test("only a submitted /quit is routed, without consuming the input event", () => {
  const h = harness();
  h.state.editor = " /quit  ";
  assert.equal(routeQuitSubmission(h.ctx, false), undefined);
  assert.equal(h.state.editor, " /quit  ");
  assert.equal(routeQuitSubmission(h.ctx, true), undefined);
  assert.equal(h.state.editor, `/${QUIT_COMMAND}`);
  for (const text of ["/quitter", "/compact", "/quit\nnot a command", "ordinary text"]) {
    h.state.editor = text;
    routeQuitSubmission(h.ctx, true);
    assert.equal(h.state.editor, text);
  }
});
