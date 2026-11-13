import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  compact,
  getAgentDir,
  getLatestCompactionEntry,
  SettingsManager,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type Preparation = Parameters<typeof compact>[0];
type NativeStream = NonNullable<Parameters<typeof compact>[7]>;

interface ParallelDetails {
  parallelSummaries: true;
  readFiles: string[];
  modifiedFiles: string[];
}

function hasTwoSummaries(preparation: Preparation) {
  return preparation.isSplitTurn
    && preparation.messagesToSummarize.length > 0
    && preparation.turnPrefixMessages.length > 0;
}

export async function compactInParallel(...args: Parameters<typeof compact>) {
  const [preparation, model, apiKey, headers, instructions, parentSignal, thinkingLevel,
    streamFn, env, retry, callbacks, sessionId] = args;
  if (!hasTwoSummaries(preparation)) {
    return compact(...args);
  }

  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const stream: NativeStream = streamFn ?? streamSimple;
  let prefixStream: AssistantMessageEventStream;
  let historyContext: Parameters<NativeStream>[1] | undefined;

  // The prefix-only native path builds the private prefix prompt without copying it.
  const prefixTask = compact(
    { ...preparation, messagesToSummarize: [] },
    model, apiKey, headers, instructions, signal, thinkingLevel,
    async (requestModel, context, options) => {
      prefixStream = await stream(requestModel, context, options);
      return prefixStream;
    },
    env, retry, callbacks, sessionId,
  );

  // The full native path owns the merge, usage totals, and file metadata.
  const combinedTask = compact(
    preparation, model, apiKey, headers, instructions, signal, thinkingLevel,
    async (requestModel, context, options) => {
      historyContext ??= context;
      if (context === historyContext) {
        return stream(requestModel, context, options);
      }
      // Await final success so prefix retries never expose an earlier failed stream.
      await prefixTask;
      return prefixStream;
    },
    env, retry, callbacks, sessionId,
  );

  try {
    const [result] = await Promise.all([combinedTask, prefixTask]);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([combinedTask, prefixTask]);
    throw error;
  }
}

function restoreFileTracking(event: SessionBeforeCompactEvent) {
  const previous = getLatestCompactionEntry(event.branchEntries);
  const details = previous?.details;
  if (!previous?.fromHook || typeof details !== "object" || details === null
    || !("parallelSummaries" in details) || details.parallelSummaries !== true) {
    return;
  }
  // This marker identifies metadata produced by this extension's native result.
  const files = details as ParallelDetails;
  for (const file of files.readFiles) {
    event.preparation.fileOps.read.add(file);
  }
  for (const file of files.modifiedFiles) {
    event.preparation.fileOps.edited.add(file);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    // Pi excludes extension-generated metadata from its own cumulative file tracking.
    restoreFileTracking(event);
    const model = ctx.model;
    if (!hasTwoSummaries(event.preparation) || !model || model.api === "pi-virtual") {
      return;
    }

    const retry = SettingsManager.create(ctx.cwd, getAgentDir()).getRetrySettings();
    try {
      const result = await compactInParallel(
        event.preparation, model, undefined, undefined, event.customInstructions,
        event.signal, ctx.thinkingLevel,
        (requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
        undefined, retry,
      );
      // compact() produces these file arrays; the public result leaves details opaque.
      const files = result.details as Omit<ParallelDetails, "parallelSummaries">;
      return {
        compaction: {
          ...result,
          details: { ...files, parallelSummaries: true } satisfies ParallelDetails,
        },
      };
    } catch (error) {
      ctx.ui.notify(`Parallel compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });
}
