# Corrected session cache rate

A local Pi extension that publishes a Powerline custom item without modifying `pi-powerline-footer` or Pi's usage accounting. It adds no tools, dependencies, network requests, timers, or disk writes.

## Metric

```text
cached-input share = cacheRead / (input + cacheRead + cacheWrite)
```

Pi normalizes `input` as input that is neither read from nor written to the prompt cache. Cache writes are newly processed input, not cache hits, so they belong in the denominator. Powerline 0.21.0's built-in percentage omits them.

The item sums valid assistant usage on the current session branch and skips failed or aborted responses. It includes history before compaction and excludes tool-result/subagent usage. Powerline 0.21.0's billing totals use a broader, all-branch scope. The cached-token count is cumulative across requests, not current context size or cache capacity.

The percentage rounds to one decimal, for example `cache in: 9.2k (92.0%)`. A genuine near-perfect rate can still round to `100.0%`. Empty sessions and sessions with no cached reads keep the item hidden.

## Integration

Pi discovers `index.ts` automatically. Run `/reload` after adding or changing the extension.

The repository's `settings.json`:

- disables Powerline's built-in `cache_read` segment;
- promotes the `cache-rate` status through the documented `powerline.customItems` API;
- puts `custom:cache_rate` in the original cache position in the default primary row;
- uses the theme's `muted` color and omits the status from the aggregate extension-status row.

Other primary segments, the secondary row, separators, icons, and editor behavior are unchanged. The explicit primary layout preserves today's default preset order; update that layout if you later want a different arrangement.

The extension runs only in TUI sessions. It includes the final response during `message_end` because Pi 1.4.0 emits that event before persisting the message, then refreshes from the authoritative branch on turn completion, settlement, navigation, and compaction. Session start/reload refreshes the value; shutdown clears this extension's status key.

## Checks

Runtime checks from the global agent repository:

```text
node --test extensions/cache-rate/cache-rate.test.ts
node extensions/cache-rate/verify-integration.ts <installed-pi-package-directory>
```

The integration check loads the real extension with the installed Pi, runs two synthetic responses through the normal agent lifecycle, and checks the installed Powerline configuration parser and custom renderer. Its model is local and deterministic, MCP is disabled, and all session/config fixtures stay in a disposable temporary directory. No user credentials or conversation contents are used.

If upstream corrects the native metric, this override can be removed by deleting the local extension and custom-item settings, restoring `cache_read` in the layout, and removing its disabled-segment entry. No third-party package files need restoration.
