import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const IDLE_INTERVAL_MS = 30 * 60 * 1000;

export function populateSplitHistory(manager: SessionManager, model: Model<Api>, marker: string) {
  const historyMarker = `EARLIER_${marker}`;
  const prefixMarker = `CURRENT_${marker}`;
  const usage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  manager.appendMessage({ role: "user", content: `Synthetic earlier task: retain verification marker ${historyMarker}.`, timestamp: 1 });
  manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    content: [{ type: "text", text: "The earlier task is complete." }], usage,
  });
  manager.appendMessage({ role: "user", content: `Synthetic current task: retain verification marker ${prefixMarker}.`, timestamp: 3 });
  manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 4,
    content: [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "fixture.txt" } }], usage,
  });
  manager.appendMessage({
    role: "toolResult", toolCallId: "fixture-read", toolName: "read", isError: false, timestamp: 5,
    content: [{ type: "text", text: "Synthetic fixture output. ".repeat(100) }],
  });
  const firstKeptEntryId = manager.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 6,
    content: [{ type: "text", text: "Recent retained test context. ".repeat(100) }], usage,
  });
  return { historyMarker, prefixMarker, firstKeptEntryId };
}

// Only extension factories capture this clock. Real provider timers stay unchanged.
export function createExtensionClock() {
  const nativeNow = Date.now;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let now = nativeNow();
  const timers = new Map<NodeJS.Timeout, { due: number; fire(): void }>();
  const setTimer: typeof setTimeout = Object.assign(
    <Args extends unknown[]>(callback: (...args: Args) => void, delay = 0, ...args: Args) => {
      const fire = () => {
        timers.delete(handle);
        callback(...args);
      };
      const handle = nativeSetTimeout(fire, delay);
      timers.set(handle, { due: now + delay, fire });
      return handle;
    },
    { __promisify__: nativeSetTimeout.__promisify__ },
  );
  const clearTimer: typeof clearTimeout = (handle) => {
    if (typeof handle === "object" && handle !== null) timers.delete(handle);
    nativeClearTimeout(handle);
  };
  return {
    async load<T>(operation: () => Promise<T>): Promise<T> {
      Date.now = () => now;
      globalThis.setTimeout = setTimer;
      globalThis.clearTimeout = clearTimer;
      try {
        return await operation();
      } finally {
        Date.now = nativeNow;
        globalThis.setTimeout = nativeSetTimeout;
        globalThis.clearTimeout = nativeClearTimeout;
      }
    },
    advance(milliseconds: number) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!next) break;
        const [handle, timer] = next;
        nativeClearTimeout(handle);
        now = timer.due;
        timer.fire();
      }
      now = target;
    },
    dispose() {
      for (const handle of timers.keys()) nativeClearTimeout(handle);
      timers.clear();
    },
  };
}
