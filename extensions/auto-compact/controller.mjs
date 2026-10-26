export const IDLE_MS = 30 * 60 * 1000;
export const QUIT_COMMAND = "compact-quit";

const QUIT_POLL_MS = 1000;
const SHELL_POLL_MS = 60 * 1000;
const NATIVE_NOOP_ERRORS = new Set([
  "Already compacted",
  "Nothing to compact (session too small)",
]);

function isContextEntry(entry) {
  if (entry.type === "message") {
    return entry.message.role !== "system"
      && !(entry.message.role === "bashExecution" && entry.message.excludeFromContext);
  }
  return ["custom_message", "branch_summary", "context_edit"].includes(entry.type);
}

export function inspectHistory(branch) {
  let marker;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "compaction") {
      break;
    }
    if (marker === undefined && isContextEntry(entry)) {
      marker = entry.id;
    }
  }
  return { marker, needsCompaction: marker !== undefined };
}

// Rewrite only the editor text. Let Pi process the actual submit key normally,
// so a selection dialog or custom editor cannot accidentally trigger a quit.
export function routeQuitSubmission(ctx, isSubmit) {
  if (isSubmit && ctx.ui.getEditorText().trim() === "/quit") {
    ctx.ui.setEditorText(`/${QUIT_COMMAND}`);
  }
}

export class AutoCompactController {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.context = undefined;
    this.timer = undefined;
    this.compaction = undefined;
    this.quitting = false;
    this.promptDepth = 0;
    this.runningTools = new Set();
    this.pendingShell = undefined;
    this.noopMarker = undefined;
    this.activitySerial = 0;
    this.idleAttempted = false;
    this.lastActivityAt = 0;
  }

  start(ctx) {
    this.stop();
    if (ctx.mode !== "tui") {
      return;
    }
    this.context = ctx;
    this.lastActivityAt = this.now();
    this.activitySerial = 0;
    this.idleAttempted = false;
    this.noopMarker = undefined;
    this.schedule(IDLE_MS);
  }

  stop() {
    this.cancelTimer();
    this.generation += 1;
    this.context = undefined;
    this.compaction = undefined;
    this.quitting = false;
    this.promptDepth = 0;
    this.runningTools.clear();
    this.pendingShell = undefined;
  }

  get isPromptOpen() {
    return this.promptDepth > 0;
  }

  activity() {
    if (!this.context) {
      return;
    }
    this.lastActivityAt = this.now();
    this.activitySerial += 1;
    this.idleAttempted = false;
    this.noopMarker = undefined;
    this.schedule(this.quitting ? 0 : IDLE_MS);
  }

  beforeWork() {
    this.cancelTimer();
  }

  workFinished() {
    // Native compaction events fire before its completion callback. The callback
    // owns scheduling for our own attempt; other compactions count as activity.
    if (!this.compaction) {
      this.activity();
    }
  }

  toolStarted(toolCallId) {
    this.runningTools.add(toolCallId);
    this.beforeWork();
  }

  toolEnded(toolCallId) {
    this.runningTools.delete(toolCallId);
    this.activity();
  }

  promptStarted() {
    this.promptDepth += 1;
    this.cancelTimer();
  }

  promptEnded() {
    this.promptDepth = Math.max(0, this.promptDepth - 1);
    if (!this.isPromptOpen) {
      this.activity();
    }
  }

  shellStarted(command) {
    if (!this.context) {
      return;
    }
    this.pendingShell = {
      command,
      startedAt: this.now(),
      afterId: this.context.sessionManager.getLeafId(),
    };
    this.activity();
  }

  requestQuit(ctx) {
    if (!this.context || ctx.mode !== "tui") {
      ctx.ui.notify("Auto-compact quit is available in interactive TUI sessions only.", "warning");
      return;
    }
    if (this.quitting) {
      return;
    }
    this.quitting = true;
    if (this.compaction || !ctx.isIdle() || ctx.hasPendingMessages()
      || this.isPromptOpen || this.runningTools.size > 0 || this.pendingShell) {
      ctx.ui.notify("Waiting for Pi's current work before compacting and quitting.", "info");
    }
    this.schedule(0);
  }

  cancelTimer() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  schedule(delay) {
    this.cancelTimer();
    if (!this.context || this.compaction || this.isPromptOpen) {
      return;
    }
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.context && this.generation === generation) {
        this.check();
      }
    }, delay);
    this.timer.unref();
  }

  refreshShellState(branch) {
    if (!this.pendingShell) {
      return false;
    }
    const pending = this.pendingShell;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.id === pending.afterId) {
        break;
      }
      if (entry.type === "message" && entry.message.role === "bashExecution"
        && entry.message.command === pending.command
        && entry.message.timestamp >= pending.startedAt) {
        this.lastActivityAt = Math.max(this.lastActivityAt, entry.message.timestamp);
        this.pendingShell = undefined;
        return false;
      }
    }
    return true;
  }

  check() {
    const ctx = this.context;
    if (!ctx || this.compaction || this.isPromptOpen) {
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const shellPending = this.refreshShellState(branch);
    if (!ctx.isIdle() || ctx.hasPendingMessages() || this.runningTools.size > 0 || shellPending) {
      if (this.quitting) {
        this.schedule(QUIT_POLL_MS);
      } else if (shellPending) {
        // Pi 1.3 does not expose shell completion as an extension event. Observe
        // its recorded result without intercepting or replacing shell operations.
        this.schedule(SHELL_POLL_MS);
      }
      return;
    }

    if (!this.quitting) {
      const remaining = IDLE_MS - (this.now() - this.lastActivityAt);
      if (remaining > 0) {
        this.schedule(remaining);
        return;
      }
      if (this.idleAttempted) {
        return;
      }
      this.idleAttempted = true;
    }

    const history = inspectHistory(branch);
    if (!history.needsCompaction || history.marker === this.noopMarker) {
      if (this.quitting) {
        this.quitting = false;
        ctx.shutdown();
      }
      return;
    }
    this.beginCompaction(history.marker);
  }

  beginCompaction(marker) {
    const ctx = this.context;
    const attempt = {
      generation: this.generation,
      marker,
      activitySerial: this.activitySerial,
      reason: this.quitting ? "quit" : "idle",
    };
    this.compaction = attempt;
    this.cancelTimer();
    ctx.ui.notify(attempt.reason === "quit"
      ? "Compacting the session before exit."
      : "Compacting the session after 30 minutes of inactivity.", "info");

    const finish = (error) => {
      if (this.compaction !== attempt || this.generation !== attempt.generation) {
        return;
      }
      this.compaction = undefined;
      // Pi 1.3 reports normal no-ops as plain Error objects rather than codes.
      const noop = error && NATIVE_NOOP_ERRORS.has(error.message);
      if (error && !noop) {
        const wasQuitting = this.quitting;
        this.quitting = false;
        this.idleAttempted = true;
        this.cancelTimer();
        ctx.ui.notify(wasQuitting
          ? "Compaction failed or was cancelled; Pi remains open. Retry /quit or use /compact."
          : "Idle compaction failed or was cancelled. Use /compact to retry.", "warning");
        return;
      }
      if (noop) {
        this.noopMarker = attempt.marker;
      }
      if (this.quitting) {
        // Recheck after Pi flushes input queued during native compaction. Any
        // newly completed conversation must be compacted before shutdown too.
        this.schedule(0);
      } else if (this.activitySerial !== attempt.activitySerial) {
        this.lastActivityAt = this.now();
        this.idleAttempted = false;
        this.schedule(IDLE_MS);
      }
    };

    try {
      ctx.compact({
        customInstructions: "Write the compaction summary in English.",
        onComplete: () => finish(),
        onError: (error) => finish(error),
      });
    } catch (error) {
      finish(error);
    }
  }
}
