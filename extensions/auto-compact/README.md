# Auto-compact before quit and while idle

A local, dependency-free Pi extension for interactive TUI sessions. It uses Pi's native compactor and does not replace the editor, footer, model, or compaction token settings.

## Activate

Run `/reload`, or start a fresh session with `pi --no-mcp`. Pi discovers this directory's `index.ts` automatically; no package installation or additional settings entry is required.

## Behavior

- **`/quit`:** wait for running Pi work and queued input, compact, then request orderly shutdown. Repeated quit requests share an ongoing compaction. Pi's public busy and queue state are checked again before exit.
- **Idle:** compact after 30 minutes with no terminal input received by Pi and no running agent/tool work, retries, compaction, queued messages, or blocking extension prompts. Finishing work restarts the full 30-minute interval.
- **Native policy:** use the current model and native compaction budgets, requesting an English summary. Empty, small, or already-compacted sessions can be a no-op. Original session history remains stored by Pi.
- **Failure or cancellation:** keep Pi open if pre-quit compaction fails. An idle failure is not retried without new activity. Use `/compact` or retry `/quit`.
- **Cleanup:** stop timers and remove input listeners on shutdown, reload, and session replacement. Timers do not keep a process alive. Print, JSON, and RPC sessions do not start idle compaction.

Pi 1.3.0 handles built-in `/quit` before extension commands. The plugin therefore observes the configured submit key through `onTerminalInput` and rewrites only `/quit` to its registered `/compact-quit` command. It does not consume the key or replace the editor. `/compact-quit` is also available directly in TUI sessions.

## Limits

- Ctrl+D, double Ctrl+C, signals, and closing or killing the terminal bypass the `/quit` input route. They are not guaranteed to compact.
- Idle activity means activity visible to Pi. Detached operating-system jobs and interactions with the terminal application's own UI are not monitored.
- Manual `!`/`!!` shell commands are conservatively treated as busy until Pi records their result. If a shell command or another extension fails before recording any result, the guard remains active. Once you know the command has stopped, use `/reload` to reset that guard.
- Native small-session no-ops may display Pi's ordinary “nothing to compact” message. The plugin does not reduce retention budgets to force a summary.

## Checks

From the global agent repository:

```text
node --test extensions/auto-compact/controller.test.mjs
node extensions/auto-compact/verify-integration.mjs Q:/.tools/.npm-global/node_modules/@earendil-works/pi-coding-agent
```

The regression suite uses a simulated clock for the 30-minute behavior, running-work guards, parallel tools, dialogs, shell completion, failure/cancellation, repeated quit requests, queued input, session changes, and cleanup.

The integration check loads the installed Pi and the real extension in a disposable SDK session with MCP disabled. It tests default and remapped submit keys, holds a deterministic summary until shutdown ordering is verified, checks the persisted native compaction entry, and verifies input-listener cleanup. Model requests are blocked and no user credentials or sessions are used. The temporary directory is removed on completion or failure.

These checks do not wait 30 minutes in a real terminal or evaluate a provider's actual summary quality.
