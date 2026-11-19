# Token usage since compaction

This local Pi extension publishes one Powerline item for four raw token counts and their cache rate:

```text
in 100 · cr 800 · cw 100 · out 200 · cache 80.0%
```

| Label | Value |
| --- | --- |
| `in` | Input tokens outside the read and write cache fields |
| `cr` | Input tokens read from the prompt cache |
| `cw` | Input tokens written to the prompt cache |
| `out` | Generated tokens, including reasoning tokens when reported as part of output |
| `cache` | The share of input tokens read from cache |

```text
cache rate = cacheRead / (input + cacheRead + cacheWrite) × 100%
```

The formula excludes output. It uses unrounded totals, not averages of individual request percentages.
The percentage rounds to one decimal. Large counts use compact labels such as `K`, `M`, and `B`.
The fields remain separate; this item does not use Powerline's built-in `token_in` or `token_out` segments.
Middle dots separate the fields. No Nerd Font icons are added.

## Reporting window

Before the first compaction, totals start at session creation.
After successful manual or automatic compaction, totals include only records added after the latest saved compaction entry.
Earlier records and the compaction operation's own usage are excluded, even when Pi retains earlier messages in model context.
Later requests that resend retained context contribute their newly reported usage normally.
Saved session history is not deleted or changed.

A fresh reporting period shows:

```text
in 0 · cr 0 · cw 0 · out 0 · cache --
```

When input exists but no tokens came from cache, the rate is `0.0%`.
Failed or cancelled compaction does not reset the window.
Reloading or resuming reconstructs the same window from the saved session record.
The four counts accumulate within that period; the cache percentage can rise or fall.

Within the window, totals include all branches in the session file and recorded standalone, branch-summary, and nested-tool usage.
Failed and aborted model requests retain their reported usage. Missing usage and calls outside the session file cannot be reconstructed.

## Powerline integration

The global `settings.json` maps `token-usage` to `custom:token_usage` as the single token/cache item.
The previous separate cache-rate publisher is removed. Powerline omits the new status from its aggregate extension-status segment to avoid duplication.
Pi discovers `index.ts` automatically. `/reload` activates the new code and settings in an existing session.
Normal Powerline overflow behavior applies; an item wider than the terminal can be hidden.

The item runs only in TUI sessions and adds no tools, dependencies, network requests, timers, or disk writes.
Session events refresh the display. The final message contributes before Pi persists it, without being counted twice afterward.

## Checks

These commands run from the global agent directory:

```text
node --test extensions/token-usage/token-usage.test.ts scripts/verification-data.test.ts
node extensions/token-usage/verify-integration.ts <installed-pi-package-directory>
```

The integration check uses the installed Pi with a deterministic local provider and disabled MCP and network access.
It checks manual and automatic compaction, failed and cancelled compaction, reload, persisted-session resume, configured layout, and rendering in both color modes.
Temporary fixtures are removed after success or failure. User credentials and conversation history are not used.

The shared offline command runs these checks with the other maintained plugins:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

Optional live compaction and usage checks use Pi's configured model and authentication:

```text
node extensions/compact-quit/verify-live.ts <installed-pi-package-directory> [provider/model]
```

The combined verifier checks token reset after native compact-quit, then real reported usage after reopening the session and continuing.
The optional override uses an exact configured provider/model identifier. No provider, model, or token count is hard-coded.
The selected provider must report usage. Missing usage causes a clear failure, not a model substitution.
Live requests can incur charges. Deterministic totals and renderer behavior remain covered by offline tests.
