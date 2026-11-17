# Managed temporary scripts

This local extension provides JavaScript execution with owned processes, live output, retained source, and delayed cleanup.
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

`/temp-scripts` toggles the extension. Explicit forms are `/temp-scripts on`, `/temp-scripts off`, and `/temp-scripts status`.
The default is on. The active branch stores the preference across reload and resume.
Powerline displays `scripts: on` or `scripts: off` through the `temp-scripts` status key.
Busy sessions cannot toggle execution policy.

When enabled, all agent-issued `bash` and `powershell` calls are blocked, including nested tool calls.
File/search tools remain unchanged. Manual `!` commands and Pi's internal clipboard operations remain outside these gates.
When disabled, managed tools and their guidance leave the active tool set, shell gates stop, and retained files remain intact.
No unavailable native tool is silently enabled.

## Ordinary file authoring

`script_job create` returns an ordinary source directory and entry-point path.
The main session uses its existing reader, writer, editor, and available structural tools on those paths.
When CodeAnchor is enabled, those tools supply hashline and AST behavior transparently.
No runtime adapter, import, decoder, or private method connects these extensions.
Combined integration tests load both extensions; the standalone terminal check does not load CodeAnchor.

## Native command execution

Managed helpers can import the optional runtime through `process.env.PI_SCRIPT_RUNTIME`:

```js
const { exec, progress } = await import(process.env.PI_SCRIPT_RUNTIME);

progress("Inspecting repository state");
await exec("git", ["status", "--short"], {
  cwd: process.cwd(),
  timeoutSeconds: 10,
});
```

`exec` accepts `cwd`, `env`, finite string `input`, `timeoutSeconds`, `signal`, and `allowFailure`.
It uses executable/argument arrays and `shell: false`. Output streams automatically to the parent run.
A failed command throws unless `allowFailure: true` requests explicit result inspection.
Results retain exit code, signal, status, elapsed time, output tail, and child-log paths.
No shell quoting or expansion applies to arguments.

The runtime inherits Pi's environment without printing it. Pi's `bin` and job/project `node_modules/.bin` directories support tool discovery.
Child-specific overrides preserve other inherited values; Windows variable names are merged without case sensitivity.
`PI_SESSION_ID`, available `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` reflect the current session.
Proxy and credential variables remain available to authorized programs, but are not copied into run metadata.

Windows lookup considers `PATHEXT`. Recognized npm Node `.cmd` shims resolve to their Node entry point without CMD execution.
Arbitrary batch launchers and direct Bash, CMD, or PowerShell interpreters are rejected by the supported runtime API.
Shell aliases, functions, profile initialization, and `bashSpawnHook`/`bashCommandPrefix` behavior are not emulated.
Pi normally inherits shell configuration already established before startup.

## Output and lifecycle

The tool row displays current phase, timestamp, elapsed time, recent stdout/stderr, and script-reported milestones.
Output updates are throttled to avoid excessive redraws; a quiet run still updates elapsed status each second.
Collapsed rendering retains the newest visual rows. Expansion reveals the bounded result.
The model-facing output tail is limited to 48 KiB and 1,800 lines. Each process stops after 16 MiB of captured output.
Raw stdout and stderr logs remain separate. Full source and a source hash identify each execution attempt.

Cancellation, deadlines, reload, and session shutdown stop owned work before finalization.
POSIX runs own a process group. Managed native children join that group.
Windows uses trusted System32 `taskkill` for an active process tree.
Detached descendants and cross-OS process trees are not guaranteed; uncertain termination retains the process lease and blocks deletion.
Missing tools and invalid launch paths fail without starting a fallback shell.

## Retention and dependencies

A job contains editable `work/`, dependencies, and separate `runs/` records with source snapshots, logs, status, and artifacts.
Snapshot execution leaves the editable workspace unchanged. `import.meta.url` identifies the snapshot.
`PI_SCRIPT_WORK` identifies editable source; `PI_SCRIPT_ARTIFACTS` identifies run outputs.
Snapshot inputs must be regular files without links, below 32 MiB and 1,000 files.

Open and pinned jobs remain available for correction. Release starts a seven-day retention period.
Eligible jobs are collected during later activity in the owning session; there is no cleanup daemon.
`cleanup` with `immediate: true` removes a released job immediately. Active, pinned, open, and unresolved jobs are protected.
Cleanup validates the registered root and ownership before deletion and verifies absence afterward.
Requested deliverables belong outside the disposable directory before release.
OS temporary cleanup can remove even pinned files; pinning is not durable storage.

`script_job dependencies` accepts exact package versions and installs within the job only.
Resolution uses `https://packagefeedproxy.microsoft.io/npm/`, Microsoft feed tarball hosts, a retained lockfile, disabled lifecycle scripts, and explicit deadlines.
User/global npm configuration is isolated. Installation failures do not switch registries and block execution until dependency setup succeeds.
The extension itself does not install dependencies during startup.

## Verification

Commands run from the global agent directory:

```text
node --test extensions/temp-scripts/temp-scripts.test.ts
node extensions/temp-scripts/verify-integration.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-live.ts <installed-pi-package-directory>
node extensions/temp-scripts/verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>
```

The shared offline workflow includes the unit tests and real Pi offline integration.
The live verifier uses configured defaults and normal authentication; it makes real provider requests and approved registry downloads.
It covers command selection, PATH/stdin/environment, project startup/tests, authoring, dependencies, output, failures, deadlines, cancellation, reload, controls, and cleanup.
The terminal verifier uses an existing `node-pty` installation only as a test driver.

Runtime verification currently covers Debian WSL, installed Pi 1.5.1, and Node.js 26.13.1.
Strict checking uses Node.js 22 declarations. Node.js 22 execution, native Windows execution, and macOS execution were unavailable.
Windows environment/shim parsing has fixture coverage, not native runtime acceptance.

## Limits

This is workflow enforcement, not a sandbox. Arbitrary JavaScript and existing project programs retain normal OS permissions.
The supported `exec` API rejects direct shells and inline helpers in known other runtimes; it does not contain every descendant program.
Shell pipelines, expansion, and redirection require JavaScript equivalents. Existing project programs can retain their own required runtimes.
Interactive programs and persistent background services are outside the current supervised contract.
PowerShell is prohibited through managed tools, including Windows PowerShell, PowerShell 7, and `.ps1` entry points.

Compatibility comparisons used the installed Pi implementation and the [upstream tool sources](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools).
Upstream `main` can differ from installed Pi; local acceptance results remain version-scoped.
