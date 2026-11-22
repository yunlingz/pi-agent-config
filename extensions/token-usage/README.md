# Token usage since compaction

This TUI-only extension publishes raw input, cache-read, cache-write, and output counts in one status item:

```text
in 100 · cr 800 · cw 100 · out 200 · cache 80.0%
cache rate = cacheRead / (input + cacheRead + cacheWrite) × 100%
```

The rate excludes output and uses unrounded totals, not average request percentages.
Labels use compact numbers; percentages round to one decimal.
Reasoning tokens are already part of reported output and are not added again.

## Reporting window

Totals begin at session creation or after the latest saved compaction entry.
The compaction operation's own usage is excluded. Failed or cancelled compaction does not reset the window.
All later branches, standalone usage, branch summaries, and nested-tool usage contribute when recorded.
Reload/resume reconstructs the same totals; existing session history is not changed.
Failed/aborted requests retain reported usage, but unrecorded calls cannot be reconstructed.

An empty window shows zero counts and `cache --`; input without cache hits shows `cache 0.0%`.
Pi's message-end event adds the completed message before persistence without later double counting.
The item adds no tools, network requests, timers, dependencies, or disk writes.

## Display and checks

Settings map `token-usage` to `custom:token_usage`; Powerline excludes that status from its aggregate display.
Normal overflow handling can hide an item wider than the terminal.
Pi discovers `index.ts`; use `/reload` after code or settings changes.

Run from the agent directory:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
node extensions/compact-quit/verify-live.ts <installed-pi-package-directory> [provider/model]
```

Offline checks cover exact totals, manual/automatic compaction, failures, reload/resume, footer layout, and both color modes.
The optional live check covers token reset, reopening, and continuation with the configured model and reported usage.
Live requests can incur charges. Tests use owned fixtures, isolate MCP, and preserve user credentials/history.
