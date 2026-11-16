# Parallel native compaction

This extension runs history and split-turn prefix summaries concurrently when both require model requests.
It restores the request scheduling used before Pi commit `f58c11562605a21bcf3d3e45553c78fe105809f9`.
It uses Pi's current native prompt builders, merge logic, output limits, and retained boundary.
It does not change the selected model, reasoning effort, or compaction budgets.

## Behavior

- The two independent summary requests start concurrently. Retries can add requests.
- Single-summary compaction remains native and sequential.
- Virtual model selections remain on Pi's native routing path.
- Manual, threshold, overflow, idle, and pre-quit compaction use the same hook.
- A failed request cancels its sibling. The extension waits for both requests to settle.
- Failure or user cancellation saves no partial checkpoint. Existing pre-quit safeguards keep Pi open.
- Parallel requests forward provider retry limits, provider timeouts, HTTP idle fallback, and WebSocket timeout settings.
- The extension reads global settings and trusted project settings. Custom in-memory SDK settings are not exposed through the hook.

The private prefix helper is not imported or copied.
A prefix-only native compaction starts its request early.
The full native compaction generates history and reuses the completed prefix stream.
Pi still computes the merged summary, combined usage, and file-operation lists.

Pi marks custom checkpoints as extension-generated.
While loaded, this extension carries their native file lists into later compactions, including single-summary compactions.
After unloading it, Pi does not automatically carry those extension-generated file lists into the next checkpoint.
Original session entries and existing summary text remain saved.

Parallel requests use the model runtime directly, not Pi's native session wrapper.
They do not receive native header hooks, client identity, or retry lifecycle events.
Pi reports extension failures as cancelled compactions. A separate notification retains the original error.
These differences prevent full equivalence with built-in compaction.

## Activation and limits

Pi discovers `index.ts` automatically. Run `/reload`, or start a fresh `pi --no-mcp` process.
No package installation or settings change is required.

The provider must accept two concurrent generations.
Pi made the native requests sequential because single-concurrency providers could return HTTP 429.
This extension does not add automatic provider detection or a sequential retry mode.
Exclude this extension when the provider cannot run concurrent requests.

The implementation targets the installed Pi 1.4.0 native call structure.
Its verifier compares current native and parallel request inputs and results.
Run that verifier when upgrading Pi.

## Verification

From the agent directory:

```text
node extensions/parallel-compact/verify.ts <installed-pi-package-directory>
```

The verifier exercises the actual extension and installed native summarizer with controlled provider responses.
It covers concurrency, request/result parity, optional usage splits, history/prefix retries, cancellation, one-summary paths, persistence, repeated file tracking, and pre-quit safety.
Seven request-setting cases compare the actual extension with Pi's native session wrapper.
They cover defaults, provider settings, project overrides, idle fallback, zero values, and untrusted projects.
The verifier supports nested and hoisted Pi dependencies.
It also tests actual idle triggering at the exact deadline, single-summary delegation, failures, and cancellation with a controlled extension clock.
It makes no external model requests and removes its temporary state.

The shared offline command runs all maintained plugin checks:

```text
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

Optional live checks use Pi's configured default provider, model, reasoning level, and authentication:

```text
node extensions/parallel-compact/verify-live.ts <installed-pi-package-directory> [provider/model]
```

The optional override must identify an exact configured model. No model substitution occurs.
Real requests can incur charges. The verifier loads auto-compact, parallel-compact, and token-usage.
It covers idle and pre-quit triggers, two overlapping real SDK streams, unchanged effort, saved checkpoints, token reset, and continuation.
The selected provider must support concurrent requests and report usage. Unsupported capabilities fail clearly.
The live check has no fixed provider, endpoint, model, or provider-specific response assertions.
It advances only the extension clock, not the provider's timers. It does not test 30 minutes of real terminal inactivity.
