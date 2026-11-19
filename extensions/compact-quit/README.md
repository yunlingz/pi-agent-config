# Compact, then quit

This extension adds `/compact-quit`. It has no event hooks, idle timers, input listeners, tools, or dependencies.

## Behavior

`/compact-quit` waits for Pi's current agent work to settle, requests native compaction, then requests graceful shutdown.
Repeated commands share the pending operation. The command accepts no arguments.
If Pi reports an empty or already-compacted session, the command exits without another summary request.
If compaction fails or is cancelled, Pi stays open. Run `/compact-quit` again to retry, or `/quit` to exit normally.

Ordinary `/quit`, inactivity, manual `/compact`, threshold checks, overflow recovery, and summary scheduling remain native.
The extension does not change prompts, model selection, reasoning effort, token budgets, retries, or saved settings.
Existing configured native budgets remain in effect. Native summaries can incur model charges.
Pi saves session history without this command; compaction is a lossy context checkpoint, not a save operation.
Work submitted after the checkpoint follows Pi's normal queue and shutdown behavior; the command does not repeatedly compact it.

## Activation

Pi automatically discovers `index.ts`. Existing sessions need `/reload`; new sessions load the command automatically.
No runtime installation or build step is required. The former automatic and parallel compaction extensions are removed.

## Verification

Run from the agent directory:

```text
node extensions/compact-quit/verify-integration.ts <installed-pi-package-directory>
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

The integration verifier uses actual Pi loading, command dispatch, native summarization, and a loopback Responses fixture.
It checks discovery, command-only registration, reload, argument handling, and exact request parity with native compaction.
It also checks sequential summaries, persistence before shutdown, repeated commands, no-ops, failures, retries, cancellation, and active-work completion.
The test uses synthetic history, blocks external requests, disables MCP, and removes its fixtures.

An optional live verifier uses the configured provider, model, reasoning level, and authentication:

```text
node extensions/compact-quit/verify-live.ts <installed-pi-package-directory> [provider/model]
```

It checks a native checkpoint, token reset, persistence before shutdown, session reopening, and exact continuation.
The optional override identifies an exact configured model. No model substitution occurs.
Real requests can incur charges. The shutdown handler is controlled; this verifier does not test terminal rendering or process exit.
