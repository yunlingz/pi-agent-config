# Auto-compact before quit and while idle

A local, dependency-free Pi extension for interactive TUI sessions. It decides **when** to invoke Pi's native compactor, not **how** to summarize. The selected model, reasoning level, native output/retention budgets and persisted settings are never overridden.

## Activate

Run `/reload`, or start a fresh session with `pi --no-mcp`. Pi discovers this directory's `index.ts` automatically; no package installation or extra settings entry is required.

## Behavior

- **`/quit`:** wait for running Pi work and queued input, invoke native compaction, then request orderly shutdown. Repeated quit requests share an ongoing compaction. Busy/queue state is checked again before exit.
- **Idle:** invoke native compaction after 30 minutes with no terminal input, running agent/tool work, retries, queued messages or blocking extension prompts. Finishing work restarts the full interval.
- **Native policy:** keep the current model and reasoning level, output limits, native cut/retention rules and English summary format. Do not silently downgrade `max`, enlarge reserves, change model metadata or add policy-driven retries. Empty/small/already-compacted sessions can be native no-ops.
- **Failure/cancellation:** keep Pi open if pre-quit compaction fails. Do not accept incomplete summary text. Idle failures wait for new activity or an explicit command; native `/compact` is unchanged.
- **Cleanup:** stop timers and remove input listeners on shutdown, reload and session replacement. Timers do not keep a process alive. Print, JSON and RPC sessions do not start idle compaction.

Pi 1.3.0 handles built-in `/quit` before extension commands. The plugin observes the configured submit key through `onTerminalInput` and rewrites only `/quit` to its `/compact-quit` command. It does not consume the key or replace the editor. `/compact-quit` is also available directly in TUI sessions.

## Native output-limit failures

`Summarization failed: generation hit the token cap and the summary is incomplete` originates in Pi's native compactor, not its idle timer. With the default reserve of 16384, native history summaries get at most 13107 output tokens and split summaries 8192, capped further by the selected model's `maxTokens`. Reasoning and visible summary text share the output allowance. A large input/context window does not enlarge these budgets automatically.

The trigger-only plugin leaves that policy to Pi. Adaptive output budgeting or chunked native-summary recovery belongs in the compactor/provider layer while respecting the selected model and reasoning level. Original session history stays stored, and failed/incomplete output must not become a checkpoint. No installed Pi files are patched by this extension.

## Limits

- Ctrl+D, double Ctrl+C, signals, and closing or killing the terminal bypass `/quit`; they are not guaranteed to compact.
- Idle activity means activity visible to Pi. Detached OS jobs and terminal-application UI interactions are not monitored.
- Manual `!`/`!!` shell commands remain busy until Pi records their result. If no result is recorded, use `/reload` after confirming the command stopped.
- Native small-session no-ops may display Pi's ordinary message. The plugin does not reduce retention budgets to force a summary.
- Provider/network/output-limit failures can still occur. A correctly declared context window is not a guarantee of successful generation or lossless summarization.

## Checks

From the global agent repository:

```text
node --test extensions/auto-compact/controller.test.mjs
node extensions/auto-compact/verify-integration.mjs Q:/.tools/.npm-global/node_modules/@earendil-works/pi-coding-agent
node extensions/auto-compact/verify-summary-integration.mjs Q:/.tools/.npm-global/node_modules/@earendil-works/pi-coding-agent
```

The simulated-clock tests cover the 30-minute schedule, work/tools/dialog/shell guards, failure/cancellation, repeated quits, queued input, session changes and cleanup. The first installed-Pi check verifies actual loading, keybindings, persistence and quit ordering with model requests blocked.

The native-summary integration check uses the installed Pi and a loopback Responses fixture. It reproduces the exact output-cap failure for both manual and plugin-triggered compaction, verifies identical model/reasoning/output settings, no automatic policy retry, no partial checkpoint and no quit on failure. A subsequent explicit successful attempt persists a native handoff, and ordinary calls still use max reasoning. Only synthetic history/credentials are used; MCP and unrelated extensions remain disabled, and temporary state is cleaned up.

These checks do not wait 30 minutes in a real terminal or evaluate a real provider's summary quality.
