# Native compaction before quit and while idle

This local extension decides when to request Pi's native compaction in interactive TUI sessions.
Pi owns the summary prompt, model request, output limit, and retained context.
The extension adds no custom summary instructions and does not change model selection, reasoning effort, budgets, or persisted settings.

## Activate

Pi discovers `index.ts` automatically. `/reload` or a fresh `pi --no-mcp` process loads changes.
No runtime dependency installation or build step is required.

## Behavior

- **Quit:** `/quit` waits for running work and queued input, requests compaction, then requests orderly shutdown.
- **Idle:** compaction starts after 30 minutes without terminal input, running work, retries, queued messages, or blocking prompts.
- **Native summary:** `ctx.compact()` receives only completion and error callbacks. It receives no additional prompt or language instruction.
- **Concurrency:** repeated quit requests share an ongoing compaction. Busy and queue checks run again before exit.
- **Failure:** failed or cancelled pre-quit compaction keeps Pi open. Idle failures wait for new activity or an explicit command.
- **Cleanup:** shutdown and reload stop timers and remove input listeners. Print, JSON, and RPC sessions do not start idle compaction.

Pi 1.4.0 handles built-in `/quit` before extension commands.
The terminal listener rewrites only a submitted `/quit` to `/compact-quit`, using the configured submit key.
It does not consume that key or replace the editor. `/compact-quit` is also available directly in TUI sessions.

## Native compaction limits

Native compaction makes model requests and can incur latency and cost.
Pi's prompt preserves goals, constraints, progress, decisions, next steps, and critical context.
The extension does not replace or extend that prompt.

When Pi reports `Summarization failed: generation hit the token cap and the summary is incomplete`, it rejected an incomplete summary.
No partial checkpoint is persisted, and pre-quit compaction does not exit.
Pi 1.4.0 uses the model's output limit, subject to the context window.
Reasoning and visible summary text share the output allowance.
`compaction.reserveTokens` controls automatic compaction timing, not summary output length.

Saved session history remains on disk. A summary is not a guarantee of lossless model context.
No installed Pi files are patched.

Other limits:

- Ctrl+D, double Ctrl+C, signals, and closing the terminal bypass `/quit`; they are not guaranteed to compact.
- Detached OS jobs and terminal-application interactions are not monitored.
- Manual shell commands remain busy until Pi records their result.
- Small, empty, or already-compacted sessions can be native no-ops.
- Provider failures and output limits remain possible; the extension does not change native retry policy.

## Checks

Runtime checks from the global agent repository:

```text
node --test extensions/auto-compact/controller.test.ts
node extensions/auto-compact/verify-integration.ts <installed-pi-package-directory>
node extensions/auto-compact/verify-summary-integration.ts <installed-pi-package-directory>
```

The simulated-clock tests cover scheduling, work guards, cancellation, repeated quits, queued input, session changes, and cleanup.
They also assert that idle and pre-quit requests contain only callbacks, with no prompt, model, or budget overrides.

The first integration check exercises the actual extension, default/custom submit keys, checkpoint persistence, quit ordering, and cleanup.
Its controlled completion hook blocks model requests.

The summary integration check exercises Pi's native summarizer through a loopback Responses fixture.
It compares manual and pre-quit summary inputs and checks that no additional instructions are appended.
It covers output limits, incomplete-summary rejection, explicit retry, unchanged reasoning/settings, and persistence of a complete checkpoint.
The checks use synthetic history, keep MCP disabled, and remove temporary state.

These checks do not wait 30 minutes in a real terminal or evaluate a real provider's summary quality.
