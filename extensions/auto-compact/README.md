# Auto-compact before quit and while idle

A local, dependency-free Pi extension for interactive TUI sessions. It decides **when** to request compaction through Pi's standard hooks.

When `pi-vcc` is loaded and its override is enabled, those hooks use `pi-vcc`. Without `pi-vcc`, Pi uses its built-in compactor. The extension does not change the selected model, reasoning level, compaction budgets, or persisted settings.

## Activate

Run `/reload`, or start a fresh session with `pi --no-mcp`. Pi discovers this directory's `index.ts` automatically; no package installation or extra settings entry is required.

## Behavior

- **`/quit`:** wait for running Pi work and queued input, request compaction, then request orderly shutdown. Repeated quit requests share an ongoing compaction. Busy and queue checks run again before exit.
- **Idle:** request compaction after 30 minutes without terminal input, running work, retries, queued messages, or blocking extension prompts. Finishing work restarts the full interval.
- **Compactor:** use the existing `ctx.compact()` path. `pi-vcc` intercepts it with `overrideDefaultCompaction: true`; no package imports or separate compaction implementation are needed.
- **UI:** after a successful `pi-vcc` result, print `Auto-compaction completed with pi-vcc.` before a pending quit. The result's `details.compactor` identifies the actual compactor. Package presence alone does not produce a success message.
- **Instructions:** when the `/pi-vcc` command is registered, omit prose compaction instructions. `pi-vcc` would interpret them as a follow-up prompt. Without that command, retain the English instruction for built-in compaction.
- **Policy:** retain the current model and reasoning level. Each compactor controls its own summary format and retained history. Built-in fallback keeps native output and retention budgets. Empty, small, or already-compacted sessions can remain no-ops.
- **Failure/cancellation:** keep Pi open if pre-quit compaction fails. Do not accept incomplete summary text. Idle failures wait for new activity or an explicit command. Manual `/compact` still uses Pi's standard hooks.
- **Cleanup:** stop timers and remove input listeners on shutdown, reload and session replacement. Timers do not keep a process alive. Print, JSON and RPC sessions do not start idle compaction.

Pi 1.4.0 handles built-in `/quit` before extension commands. The plugin observes the configured submit key through `onTerminalInput` and rewrites only `/quit` to its `/compact-quit` command. It does not consume the key or replace the editor. `/compact-quit` is also available directly in TUI sessions.

## Built-in output-limit failures

When built-in fallback reports `Summarization failed: generation hit the token cap and the summary is incomplete`, Pi rejected an incomplete summary. The idle timer does not produce this error. Pi 1.4.0 uses the model's output limit, reduced when input and output would exceed the context window. `compaction.reserveTokens` controls automatic compaction timing, not summary output length. Reasoning and visible summary text share the output allowance. Provider or model output limits can still cause incomplete summaries.

When `pi-vcc` handles compaction, it uses algorithmic extraction instead of a model summary request. Its `smartKeepTail` setting controls the retained tail. Extraction can omit details; `vcc_recall` can retrieve earlier session entries.

For built-in fallback, the trigger-only extension leaves summarization policy to Pi. Adaptive output budgeting or chunked native-summary recovery belongs in the compactor/provider layer while respecting the selected model and reasoning level. Original session history stays stored, and failed/incomplete output must not become a checkpoint. No installed Pi files are patched by this extension.

## Limits

- Ctrl+D, double Ctrl+C, signals, and closing or killing the terminal bypass `/quit`; they are not guaranteed to compact.
- Idle activity means activity visible to Pi. Detached OS jobs and terminal-application UI interactions are not monitored.
- Manual `!`/`!!` shell commands remain busy until Pi records their result. If no result is recorded, use `/reload` after confirming the command stopped.
- Native small-session no-ops may display Pi's ordinary message. The plugin does not reduce retention budgets to force a summary.
- Provider/network/output-limit failures can still occur. A correctly declared context window is not a guarantee of successful generation or lossless summarization.

## Checks

Runtime checks from the global agent repository:

```text
node --test extensions/auto-compact/controller.test.ts
node extensions/auto-compact/verify-integration.ts <installed-pi-package-directory>
node extensions/auto-compact/verify-summary-integration.ts <installed-pi-package-directory>
node extensions/auto-compact/verify-vcc-integration.ts <installed-pi-package-directory>
```

The simulated-clock tests cover the 30-minute schedule, work guards, cancellation, repeated quits, queued input, session changes, and cleanup. They also cover `pi-vcc` availability, instruction handling, truthful completion messages, and stale callbacks. The first installed-Pi check verifies actual loading, keybindings, persistence and quit ordering with model requests blocked.

The native-summary integration check uses the installed Pi and a loopback Responses fixture. It verifies that manual and plugin-triggered summaries use the model's output limit with max reasoning. An incomplete response must fail without a partial checkpoint or shutdown. The check also verifies identical model/output settings, unchanged compaction settings, and no automatic policy retry. A subsequent explicit successful attempt persists a native handoff, and ordinary calls still use max reasoning. The fixture uses only synthetic history and credentials, keeps MCP and unrelated extensions disabled, and removes temporary state.

The `pi-vcc` check loads the actual installed package and the local extensions. It covers manual, pre-quit, and clock-driven idle compaction. It verifies the default override, persisted `pi-vcc` checkpoints, zero model requests, no unsolicited agent turns, preserved settings, and UI notifications before shutdown. It also verifies restored session history and shared input cleanup. It tests multiple extension load orders. An optional second argument selects the installed `pi-vcc` package directory.

These checks do not wait 30 minutes in a real terminal or evaluate a real provider's summary quality.
