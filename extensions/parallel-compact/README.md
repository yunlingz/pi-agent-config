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
- The extension reads the merged global/project retry settings. Custom in-memory SDK settings are not exposed through the hook.

The private prefix helper is not imported or copied.
A prefix-only native compaction starts its request early.
The full native compaction generates history and reuses the completed prefix stream.
Pi still computes the merged summary, combined usage, and file-operation lists.

Pi marks custom checkpoints as extension-generated.
While loaded, this extension carries their native file lists into later compactions, including single-summary compactions.
After unloading it, Pi does not automatically carry those extension-generated file lists into the next checkpoint.
Original session entries and existing summary text remain saved.

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

From `C:/Users/yunlingzhu/.pi/agent`:

```text
node extensions/parallel-compact/verify.ts Q:/.tools/.npm-global/node_modules/@earendil-works/pi-coding-agent
```

The verifier exercises the actual extension and installed native summarizer with controlled provider responses.
It covers concurrency, request/result parity, optional usage splits, history/prefix retries, cancellation, one-summary paths, persistence, repeated file tracking, and pre-quit safety.
It makes no external model requests and removes its temporary state.
