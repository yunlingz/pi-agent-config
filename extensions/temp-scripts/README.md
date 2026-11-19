# Managed temporary scripts

This local extension provides JavaScript execution with visible source, live output, managed background jobs, and explicit cleanup.
It uses Node.js built-ins and Pi-supplied APIs. It has no third-party runtime packages or CodeAnchor dependency.

## Tools and controls

| Tool | Purpose |
| --- | --- |
| `script_inline` | Small, dependency-free ESM JavaScript supplied directly in a tool call |
| `script_js` | Existing `.mjs` or `.js` entry points inside an editable managed workspace |
| `script_job` | Workspace creation, inspection, dependencies, retention, release, and cleanup |

Every execution requires a purpose and deadline. Top-level `await` works; stdout carries program output.
Each call starts a fresh Node.js process. There is no shared REPL or retained interpreter state.
Temporary helpers are JavaScript-only. Maintained extension code remains TypeScript.

Inline submission does not mean a workspace script: Node reads the submitted code through stdin.
Supporting source/log files can exist during execution, but safe successful inline calls remove them before returning.
Several sequential commands alone do not require a workspace.
`Inline JS` and `Workspace JS` describe execution methods, not permanent job types.
A retained inline job can be rerun through `script_js` using its saved `work/main.mjs`; this reuses the same job.
Dedicated session tools remain preferred and unchanged; this extension replaces shell execution, not normal file/search tools.

`/temp-scripts` toggles the extension. Explicit forms are `/temp-scripts on`, `/temp-scripts off`, and `/temp-scripts status`.
The default is on. The active branch stores the preference across reload and resume.
Powerline displays `scripts: on` or `scripts: off` through the `temp-scripts` status key.
Busy sessions cannot toggle execution policy.

When enabled, all agent-issued `bash` and `powershell` calls are blocked, including nested tool calls.
File/search tools remain unchanged. Manual `!` commands and Pi's internal clipboard operations remain outside these gates.
When disabled, managed tools and their guidance leave the active tool set, shell gates stop, and retained files remain intact.
No unavailable native tool is silently enabled.

## Concurrent execution

Independent calls can run concurrently in Pi's normal parallel tool mode, including foreground calls.
Foreground execution waits for completion; it does not impose a session-wide execution lock.
Each inline call has its own job, process, output stream, deadline, and cleanup decision.
Workspace runs and lifecycle mutations retain per-job leases. A conflicting operation on an active job rejects instead of queuing.
Job inspection does not force unrelated work to wait. Independent jobs can finish in any order.
Dependent steps, source edits, dependency changes, and shared-file mutations must stay in order.
Separate jobs do not lock shared project files or external services. An explicitly sequential Pi mode still takes precedence.
Explicit background execution remains separate; concurrency does not require background jobs.
New messages can enter Pi's native steering queue during foreground execution, but the model processes them after the batch returns.
Long independent work needs explicit background execution when later messages must be processed before completion.

## Ordinary file authoring

`script_job create` returns an ordinary source directory and entry-point path.
The main session uses its existing reader, writer, editor, and available structural tools on those paths.
When CodeAnchor is enabled, those tools supply hashline and AST behavior transparently.
No runtime adapter, import, decoder, or private method connects these extensions.
Combined integration tests load both extensions; the standalone terminal check does not load CodeAnchor.

## Background jobs and continuity

Both execution tools accept optional `background` settings, independently of source format.
Finite jobs use `background: { runtimeSeconds: 3600 }`; requested services use `background: { service: true }`.
For background execution, `timeoutSeconds` is a bounded startup deadline of at most 120 seconds.
The start call returns promptly; the agent can settle and accept later queries while the process runs.
An optional loopback HTTP `readyUrl` checks application readiness. Without it, running does not prove readiness.
Omitting `readyUrl` or setting it to an empty string disables readiness checks; a nonempty URL must identify a real endpoint.

The fixed background panel displays compact tree rows with job names, state markers, elapsed time, and recent output.
Its layout follows Todo's visual conventions without importing Todo or sharing its state.
The retention panel adds each job at startup, keeps stored jobs visible, and removes entries after successful cleanup or release.
The retention row shows the latest accepted run purpose and restores that label after reload.
Inspection keeps the original workspace purpose and exposes the latest run purpose separately.
A rejected duplicate does not replace the active run's label or state.
With standard global loading, both panels stay above Powerline through redraw and reload.
Empty panels render no lines. Reserved startup slots preserve their position; refreshes do not reinsert widgets.
`/script-jobs expand` and Pi's tool-output expansion reveal IDs, retention reasons, readiness details, and more output.
`/script-jobs collapse` returns to the compact view when Pi's tool-output expansion is off.
The compact budget is twelve content rows per panel, plus a trailing spacer. Running jobs appear before stopped jobs.
Periodic panel updates do not add transcript messages or model requests.
`script_job status`, `logs`, and `stop` inspect or stop the existing job without restarting it.

Native manual and automatic compaction preserve job controllers and processes; no compaction plugin is required.
Reload preserves active jobs and reconnects the panel in the same Pi process.
Quit and session replacement (`/new`, `/resume`, `/fork`, or `/clone`) stop owned jobs before leaving the session.
Cancelling a later query does not stop existing background work.

Escape or native manual compaction interrupts a foreground wait, not its process.
That process becomes visible in the fixed panel until completion, deadline, or explicit `script_job stop`.
This distinction avoids native manual compaction's automatic agent abort terminating useful work.
Interactive programs remain unsupported; background services need no terminal input.

Controllers are extension-owned process state, not saved PIDs to kill after restart.
After a crash or new Pi process, persisted files and unresolved leases remain diagnostic evidence; no automatic restart or PID-based kill occurs.

## Event-driven job reports

Background and interrupted jobs push lifecycle events through Pi's native custom follow-up messages.
The events cover preparation, process start, readiness changes, background handoff, child-command starts/exits, explicit progress, stopping, and final outcomes.
Final outcomes include success, failure, cancellation, timeout, output limits, and uncertain termination.
Ordinary foreground calls stream their state and return their result without duplicate callback messages.
Startup failures return through the original tool call rather than create a second agent turn.

Events can resume an idle agent and incur model charges. Busy agents receive events through Pi's normal follow-up queue.
The bridge pauses during compaction, reconnects after reload, and suppresses callbacks during quit or session replacement.
It does not invent user messages, restart jobs, authorize retries, or recover processes after Pi exits.
Runs started before this reporting feature was loaded keep their original reporting behavior and remain stoppable after reload.

The inbox batches bursts, keeps at most 64 pending events, and allows only one callback message to wait in Pi's queue.
Repeated progress is coalesced; overflow reports an omitted count. Each run has an event ID and ordered sequence numbers.
Event messages omit command arguments and bound included output. Scripts must not emit credentials.
Raw stdout/stderr and elapsed-time heartbeats update the UI without creating model callbacks.
Explicit `progress(message)` reports useful milestones; automatic native-command heartbeats stay UI-only.
Batching uses a one-shot timer after an event, not periodic job or file polling.

`script_job status` and `logs` remain available for requested manual snapshots and diagnosis.
Routine continuation does not require polling tools, wait helpers, internal-file reads, or sleep loops.

## Native command execution

Managed helpers can import the optional runtime through the file URL in `process.env.PI_SCRIPT_RUNTIME`:

```js
const { exec, progress } = await import(process.env.PI_SCRIPT_RUNTIME);

progress("Inspecting repository state");
await exec("git", ["status", "--short"], {
  cwd: process.cwd(),
  timeoutSeconds: 10,
});
```

`exec` accepts `cwd`, `env`, finite string `input`, `timeoutSeconds`, `signal`, and `allowFailure`.
Inside an explicitly background run, a child command can omit its options object and inherit the parent's lifetime.
It uses executable/argument arrays and `shell: false`. Output streams automatically to the parent run.
A failed command throws unless `allowFailure: true` requests explicit result inspection.
When a successful parent accepts a normal nonzero child exit, that exit alone does not retain safe inline files.
The command row still shows its actual failure status and accepted exit code.
Timeouts, signals, incomplete evidence, truncation, and uncertain termination still prevent automatic cleanup.
Results retain exit code, signal, status, elapsed time, output tail, and child-log paths.
Windows can report self-termination as an ordinary nonzero exit with no signal. The runtime cannot recover an unreported cause.
Explicit cancellation and deadlines retain their known status on every platform.
No shell quoting or expansion applies to arguments.

The runtime inherits Pi's environment without printing it. Pi's `bin` and job/project `node_modules/.bin` directories support tool discovery.
Child-specific overrides preserve other inherited values; Windows variable names are merged without case sensitivity.
`PI_SESSION_ID`, available `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` reflect the current session.
Proxy and credential variables remain available to authorized programs, but are not copied into run metadata.

Windows lookup considers `PATHEXT`. Recognized npm Node `.cmd` shims resolve to their Node entry point without CMD execution.
Modern npm/npx shims use their adjacent CLI. Batch global-prefix redirection is not emulated.
Arbitrary batch launchers and direct Bash, CMD, or PowerShell interpreters are rejected by the supported runtime API.
Shell aliases, functions, profile initialization, and `bashSpawnHook`/`bashCommandPrefix` behavior are not emulated.
Pi normally inherits shell configuration already established before startup.

## Output and lifecycle

Headers distinguish `Inline JS`, `Workspace JS`, and `Script job` actions.
Job actions show purpose names instead of bare IDs, including after release and transcript reload.
Inline source appears before output; workspace source comes from the executed snapshot, not a later edit.
Separate section budgets keep source, actual child command events, and recent output visible.
Expansion reveals complete submitted inline source, bounded snapshot source, commands, output, and execution metadata.
Source remains inspectable in the session after successful inline disk cleanup.

The tool row displays current phase, timestamp, elapsed time, stdout/stderr, and script-reported milestones.
Output updates are throttled; quiet execution updates elapsed status each second.
Routine UUIDs and hashes remain in expanded execution details rather than occupying the main result rows.
The model-facing output tail is limited to 48 KiB and 1,800 lines. Each process stops after 16 MiB of captured output.
Raw stdout and stderr logs remain separate while retained. Source hashes identify execution attempts.

Explicit stop, deadlines, quit, and session replacement stop owned processes before finalization.
POSIX runs own a process group. Managed native children join that group.
Windows uses trusted System32 `taskkill` for an active process tree.
Detached descendants and cross-OS process trees are not guaranteed; uncertain termination retains the process lease and blocks deletion.
Missing tools and invalid launch paths fail without starting a fallback shell.

## Retention and dependencies

A job contains editable `work/`, dependencies, and separate `runs/` records with source snapshots, logs, status, and artifacts.
New jobs live in private `~/.pi-temp-scripts/jobs/` directories, outside projects and the Pi configuration repository.
On POSIX, the storage/job directories use mode `0700`; sensitive records and captured source use `0600`.
`PI_TEMP_SCRIPTS_DIR` can select an isolated storage root, which the test verifiers use.
The root must use its canonical path, not a link or Windows short-name alias. Test verifiers canonicalize their own temporary roots.
Registered legacy `/tmp` jobs remain accessible to their owner; the extension never scans, migrates, or deletes them merely during upgrade.
Snapshot execution leaves the editable workspace unchanged. `import.meta.url` identifies the snapshot.
`PI_SCRIPT_WORK` identifies editable source; `PI_SCRIPT_ARTIFACTS` identifies run outputs.
Snapshot inputs must be regular files without links, below 32 MiB and 1,000 files.

Successful foreground inline calls remove their job when output is complete, no artifacts exist, and process termination is confirmed.
`keep: true`, failures, interruption, truncated output/command evidence, artifacts, and uncertain state preserve files for inspection.
Workspace jobs remain available across edits and runs, even after successful execution.
There is no timed expiry, background collector, or promised seven-day deletion.

Explicit `script_job release` deletes stopped owned source, dependencies, artifacts, and logs immediately.
`jobs: [ids]` batches lifecycle operations. Running leases and uncertain ownership block deletion.
`cleanup` retries deletion of an already released job; it does not bypass open or pinned protection.
Deletion writes a session tombstone, so removed registrations do not reappear after reload or compaction.
Cleanup verifies exact ownership and absence afterward. Requested deliverables belong in an approved destination before release.
The scratch directory is not a backup, even when jobs are pinned.

Compact panels use this layout:

```text
● Background jobs (1/1 active)
└─ ◐ Run the local service (running · 34s · ready)
   Listening on the configured loopback address

○ Job retention (2 stored)
├─ ○ Check remote refs (retained)
└─ ◆ Keep diagnostic records (pinned)
```

Retained jobs do not fade between turns. Releasing a job removes it from both panels.
Released records stay out of the retention panel, even when legacy files remain available for explicit inspection or cleanup.

`script_job dependencies` accepts exact package versions and installs within the job only.
Resolution uses `https://packagefeedproxy.microsoft.io/npm/`, Microsoft feed tarball hosts, a retained lockfile, disabled lifecycle scripts, and explicit deadlines.
User/global npm configuration is isolated. Installation failures do not switch registries and block execution until dependency setup succeeds.
The extension itself does not install dependencies during startup.

## Verification

Commands run from the global agent directory:

```text
node --test extensions/temp-scripts/temp-scripts.test.ts
node extensions/temp-scripts/verify-integration.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-background.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-events.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-live.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>
```

The shared offline workflow includes unit, authoring, concurrency, and native background/compaction integration tests.
Concurrency checks use actual sibling Pi calls and process barriers, not elapsed-time estimates alone.
They cover inline/workspace overlap, mixed job actions, same-job rejection, interruption, independent stop, shutdown, and cleanup.
The native lifecycle verifier loads only this extension; it needs no CodeAnchor or automatic/parallel compaction extension.
The live verifier uses configured defaults and normal authentication; it makes real provider requests and approved registry downloads.
It also checks real-model sibling calls, overlapping process lifetimes, same-job rejection, and two-job interruption.
Other coverage includes dedicated-tool selection, commands, PATH/stdin/environment, startup/tests, authoring, retention, dependencies, output, services, HTTP readiness, native compaction, reload, and cleanup.
The terminal verifier uses an existing `node-pty` installation only as a test driver.

Windows acceptance uses installed Pi 1.5.1 and Node.js 24.22.1, including actual terminal and configured-model checks.
Earlier acceptance covered Debian WSL with Pi 1.5.1 and Node.js 26.13.1.
Strict checking uses Node.js 22 declarations. The concurrency change has not been executed on Node.js 22, WSL, or macOS.

## Limits

This is workflow enforcement, not a sandbox. Arbitrary JavaScript and existing project programs retain normal OS permissions.
The supported `exec` API rejects direct shells and inline helpers in known other runtimes; it does not contain every descendant program.
Shell pipelines, expansion, and redirection require JavaScript equivalents. Existing project programs can retain their own required runtimes.
Interactive programs and persistence beyond Pi exit remain outside the supervised contract. Managed background services are supported while Pi runs.
PowerShell is prohibited through managed tools, including Windows PowerShell, PowerShell 7, and `.ps1` entry points.

Compatibility comparisons used the installed Pi implementation and the [upstream tool sources](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools).
Upstream `main` can differ from installed Pi; local acceptance results remain version-scoped.
