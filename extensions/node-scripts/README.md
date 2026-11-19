# node-scripts

A small Node.js runner for Pi. Each Pi session has one ESM workspace for scripts, npm dependencies, job definitions, and logs.

When enabled, this extension blocks agent-issued native Bash and PowerShell calls. It does not replace Pi's file editor or reader.
It adds `rm` and `mkdir`, so routine file deletion and directory creation do not need a script.

## Start here

A job is a saved execution definition. Creating a job does not run it.

```text
Discover workspace     Author a .mjs file       Create job         Run once
node_job_list      -->  available file tools --> node_job_create --> node_job_run
                                                                     |
                                     +-------------------------------+-------------------+
                                     |                                                   |
                              timeout supplied                                    no timeout
                                     |                                                   |
                              wait for result                                  return after startup
                                     |                                                   |
                       finished / failed / timeout                      node_job_query when needed
```

The extension does not choose which file tools Pi uses. Its generic prompt section exposes the current workspace and ESM conventions.
`node_job_list` also returns the workspace path, even when there are no jobs.

## A short example

Suppose `node_job_list` returns this workspace:

```text
C:/Users/example/.pi-node-scripts/01a1ea0d-0b68-76f0-915a-bc0ef11d300f
```

Create `scripts/hello.mjs` there with an available file tool:

```js
import { basename } from "node:path";

const name = process.argv[2] ?? "world";
console.log(`Hello, ${name}!`);
console.log(`Workspace: ${basename(process.cwd())}`);
```

Create its job:

```json
{
  "scriptPath": "scripts/hello.mjs",
  "args": ["Pi"],
  "name": "Say hello",
  "timeoutSeconds": 10
}
```

Call `node_job_run` with the returned UUID:

```json
{ "jobId": "<complete-job-uuid>" }
```

The tool waits for completion and returns the status, output tails, and full log paths.
To execute the script again, create another job. The script file can be reused; the job cannot.

## ESM only

All workspaces have a private `package.json` with `"type": "module"`. Every job entry must have the `.mjs` extension.
Use ESM `import` and `export`, and include `.mjs` in relative imports between helper modules. Top-level `await` works.

```js
// scripts/main.mjs
import { format } from "./format.mjs";
console.log(await format(42));
```

`.js`, `.cjs`, and `.ts` job entries reject. There is no compilation step, inline execution mode, REPL, or custom `exec()` library.
These helper conventions do not apply to unrelated project source or installed npm packages.

## Nine tools

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `node_npm_add` | `package`, exact `version` | Add a production dependency to this workspace |
| `node_npm_remove` | `package` | Remove a direct dependency |
| `node_job_create` | `scriptPath`, optional `args`, `name`, `timeoutSeconds` | Save an immutable execution definition |
| `node_job_run` | `jobId` | Start a created job once |
| `node_job_deprecate` | `jobId` | Invalidate a job; terminate it if running |
| `node_job_query` | `jobId` | Read its definition, status, and bounded output |
| `node_job_list` | required `status`, `recentN` | Discover the workspace and recent IDs for one exact status |
| `rm` | `path`, optional `recursive` | Remove a file, link, or directory tree |
| `mkdir` | `path` | Create a directory and missing parents |

Job tools require the complete UUID. Four-character IDs in the panel are labels, not accepted tool arguments.
`args` is a string array, not a shell command. No shell expansion or quoting applies.

## Workspace and evidence

Configuration lives in `~/.pi/agent/pi-node-scripts.json`:

```json
{
  "$schema": "./pi-node-scripts.schema.json",
  "rootFolder": "~/.pi-node-scripts",
  "npmRegistry": "https://packagefeedproxy.microsoft.io/npm/"
}
```

Missing settings use these defaults. Invalid settings produce a clear error; they do not silently enable shell execution.
`rootFolder` must be absolute or home-relative. The registry must be a credential-free HTTPS URL.
A running job prevents a workspace-root change. No automatic migration occurs.

```text
<rootFolder>/<pi-session-uuid>/
├── package.json                  private ESM package
├── package-lock.json             npm lockfile, when dependencies exist
├── node_modules/                 dependencies shared by this session's scripts
├── scripts/                      ordinary .mjs source files
├── jobs/
│   └── <job-uuid>.json            definition and execution metadata
└── logs/
    ├── <job-uuid>/
    │   ├── stdout.log            full stdout
    │   └── stderr.log            full stderr
    └── npm-<operation-uuid>/      npm output and result evidence
```

`jobs/<uuid>.json` stores the name, script path, arguments, timeout, state, timestamps, output-recency metadata, and exit/termination information.
It does not copy script source, the inherited environment, or full output.

The same Pi session UUID uses the same workspace across compaction, reload, and resume. A new UUID uses another workspace.
The plugin never automatically deletes workspace source, definitions, dependencies, or logs. Deprecation is not deletion.
Explicit authorized deletion and external disk failures remain possible; retained logs are not a backup.

## Timed and background jobs

The presence of a positive `timeoutSeconds` determines behavior. Omission or `null` means no timeout; there is no second mode switch.

| Definition | `node_job_run` behavior | Suitable use |
| --- | --- | --- |
| Positive timeout | Wait for terminal result and enforce the deadline | Tests, builds, finite commands |
| No timeout | Return after Node starts; process can continue indefinitely | Requested local service or background worker |

Zero is not unlimited. The maximum supported timeout is 2,147,483 seconds, within Node's timer range.
The deadline starts at process launch. Termination confirmation and log flushing can take a short additional interval.
Process startup is not application readiness; this plugin has no HTTP readiness probe.

`node_job_run` calls are sequential at Pi's tool level. Scripts can use Node's asynchronous APIs for internal parallelism.
Several background jobs can coexist because each startup call returns promptly.
A timed foreground job delays model processing of queued messages until it returns or is interrupted.

Each process uses `process.execPath`, the same Node executable as Pi. Its working directory is the session workspace.
It inherits Pi's environment, including `PATH`, proxies, and credentials. It does not copy Pi's own command-line flags.
Use ordinary Node.js APIs such as `spawn()` with argument arrays and `shell: false` to invoke existing project programs.
Interactive stdin is unsupported.

## States and deprecation

```text
created --run--> started --exit 0------------> finished
                    |----nonzero/error-----> failed
                    |----deadline----------> timeout
                    +----deprecate---------> deprecated

created / finished / failed / timeout --deprecate--> deprecated
```

A launch failure consumes the job and records `failed`. Terminal jobs cannot run again.
Editing a script before running affects execution because there are no snapshots. Editing source while it runs is unsupported.

Deprecating a running job terminates its owned process tree. Successfully deprecated jobs leave the normal panel.
Their UUID remains queryable; `node_job_list({"status":"deprecated","recentN":10})` lists recent deprecations. Repeated deprecation is harmless.

The plugin confirms process termination before reporting successful deprecation. If it cannot confirm termination, it reports an `unconfirmed` warning.
It does not hide uncertain work or kill a saved PID after a Pi restart.

## Compaction, reload, and exit

| Event | Running timed job | Running background job |
| --- | --- | --- |
| Escape | Terminate and deprecate | Unaffected |
| Manual compaction | Terminate and deprecate before summarization | Survive |
| Automatic compaction | Normally already finished at the tool boundary | Survive |
| Reload | No active timed wait can remain | Survive in the same Pi process |
| Quit or session replacement | Terminate and deprecate | Terminate and deprecate |

**During a timed job, native Pi rejects `/reload` while its response is active.**

1. Press **Escape** to terminate and deprecate the timed job.
2. Run **`/reload`** normally.

No terminal-input interception or custom reload command is added. Compaction waits only for bounded termination, not the original workload.
Background jobs continue with their original process identity. Reload reconnects the UI without restarting them.

After a Pi crash or restart, records and logs persist, but a saved `started` record alone does not prove a live job exists.
Such jobs show `unconfirmed`. There is no daemon, restart service, PID-based recovery, or supported concurrent ownership of one workspace.

## Querying and job ordering

Jobs never send proactive status messages, invoke a model, or resume the agent. Query when a status snapshot is useful.
`node_job_query` returns the definition, current status, activity, exit information, log paths, and stdout/stderr tails.
Each tail is bounded to 24 KiB. Full raw output remains on disk; query output strips terminal controls.
Tool text is limited to 48 KiB or 1,800 lines, plus a truncation notice.

`node_job_list(status, recentN)` requires both arguments. Status is `created`, `started`, `finished`, `failed`, `timeout`, `deprecated`, or `unconfirmed`.
`recentN` supports 1–100. The result always includes the workspace path, even with no matches.

```text
current session jobs
    -> filter the exact requested status
    -> sort by last nonempty output time
       otherwise start time
       otherwise creation time
    -> start time, creation time, and full UUID break ties
    -> return up to recentN rows
```

These timestamps are fallbacks, not separate priority groups. A silent job started at 12:05 ranks above output last seen at 12:01.
Rows include full UUID, name, status, type, and activity time with its source. `total` and `hasMore` identify omitted matches.
There is no pagination, wildcard status, or implicit default. Querying, listing, redraws, and reload never update recency.

The panel uses this same recency comparator, but combines statuses and puts all known running jobs first.
Quiet background workers cannot be displaced by newer created or terminal jobs. Timed and background jobs have equal running priority.

## Panel and controls

Powerline displays exactly `node-scripts: on`, `node-scripts: off`, or `node-scripts: error`.
The extension defaults on. The active branch stores the preference across reload and resume.

```text
Jobs · 1 sync · 2 background · 1 created · 6 terminal
◐ [7f3a] started · async · unlimited · Local server — Listening on :8080
◐ [b914] started · sync · 60s · Project tests — Test 12 passed
◐ [a521] started · async · unlimited · Quiet worker — no output
○ [c315] created · sync · 30s · Generate report — no output
✓ [ac31] finished · sync · 10s · Format report — Report written
✓ [9521] finished · sync · 10s · Generate report — Done
✓ [fa22] finished · sync · 10s · Parse metrics — Read 32 rows
✓ [29c1] finished · sync · 10s · Check inputs — Valid
+2 jobs · /node-scripts expand
```

The collapsed panel has at most ten physical lines: one summary, up to eight one-line job rows, and one overflow line.
Each row includes its latest nonempty output, shortened to the remaining terminal width. Rows never wrap or add spacer lines.
If more than eight jobs run, the overflow line reports how many running jobs are hidden. Expansion shows every nondeprecated job.
Summary counts cover all nondeprecated jobs; `unconfirmed` appears when needed. Empty panels are hidden.
The panel refreshes locally above Powerline without transcript entries or model requests.

```text
/node-scripts            toggle on/off
/node-scripts on
/node-scripts off
/node-scripts status     show enabled state and workspace path
/node-scripts expand
/node-scripts collapse
```

Disabling rejects while jobs or npm operations are running. Finish or deprecate jobs first.
Disabling removes these nine tools and shell gates; it does not enable unavailable native tools or delete anything.

Transcript rows show the definition, bounded live output, terminal status, and evidence paths. Expansion reveals more details.
There is no duplicated inline-source block because scripts are ordinary files.

## npm dependencies

Dependencies belong to this session workspace, never the project or a global installation.
`node_npm_add` requires an exact semantic version and records it in `dependencies`, not `devDependencies`.
Adding an existing direct dependency rejects. Update by removal followed by addition.

npm uses the configured registry, a lockfile, disabled lifecycle scripts, and a 120-second operation deadline.
Git, URL, local-path, and alias specifications are not accepted by the tools. Registry failures do not switch registries.
Dependency changes reject while jobs run because all scripts share `node_modules`.
Some native/build-dependent packages need installation scripts and will not work under this policy.

## Filesystem scope and limits

`rm` and `mkdir` resolve relative paths against Pi's current project directory, not the node-scripts workspace.
Absolute and `~/` paths work. `mkdir` creates missing parents and accepts an existing directory.
`rm` requires `recursive: true` for directories, removes links themselves rather than targets, and reports missing paths.
Empty removal paths, filesystem roots, and the user's home directory reject. Other deletion is permanent.

Shell blocking applies to agent-issued native `bash` and `powershell`, including nested calls. Manual user `!` commands remain native.
Arbitrary scripts and existing programs have normal OS permissions. This is workflow control, not a security sandbox.
Detached descendants and cross-OS process trees are outside the termination guarantee. Windows and POSIX use different tree-termination mechanisms.
Full logs and indefinite services can consume unbounded disk space. There is no automatic collector or expiry policy.

## Replacement and verification

This replaces the `temp-scripts` extension; it does not migrate or delete `~/.pi-temp-scripts` data.
Existing sessions need a user-issued `/reload` or a new session to change the loaded extension.

Commands run from the global agent directory:

```text
node --test extensions/node-scripts/node-scripts.test.ts
node extensions/node-scripts/verify-integration.ts <installed-pi-package-directory>
node extensions/node-scripts/verify-live.ts <installed-pi-package-directory>
node extensions/node-scripts/verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

Offline checks use real Node processes and isolated Pi sessions. They do not make external model requests.
Live checks use the configured provider, model, reasoning level, and authentication. Real requests and npm downloads can incur charges.
The live verifier runs twelve two-part work cycles with quiet and sustained-output services.
It also tests three native compactions, reloads, saved-session reopening, dependency protection, and deprecation.
Expect several minutes; provider speed and compaction time affect duration. The final result reports time and prompt/request/tool counts.
Verifiers preserve fixture evidence when process termination remains uncertain.
Terminal checks use an existing terminal driver; the runtime extension has no third-party dependency beyond Pi's supplied APIs.
Platform and runtime coverage must be reported with the verification results; passing one platform does not prove another.
