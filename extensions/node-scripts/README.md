# node-scripts

A small Node.js runner for Pi. Each Pi session has one ESM workspace for scripts, npm dependencies, job definitions, and logs.

When enabled, this extension blocks direct native Bash and PowerShell tool calls, not interpreters launched by Node jobs.
It adds `rm` and `mkdir`, so routine file deletion and directory creation do not need a script.

## Start here

A job is a saved execution definition. Creating a job does not run it.

```text
Inspect project commands    Reuse or author .mjs launcher    Create job         Run once
native file tools      -->  existing code first          --> node_job_create --> node_job_run
                                                                     |
                                     +-------------------------------+-------------------+
                                     |                                                   |
                              timeout supplied                                    no timeout
                                     |                                                   |
                              wait for result                                  return after startup
                                     |                                                   |
                       finished / failed / timeout                      node_job_query when needed
```

The extension uses Pi's standard tool descriptions, snippets, and guidelines for workspace, ESM, and reuse instructions.
It refreshes registered guidelines after workspace initialization, so the current path appears without a custom prompt hook.
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

## Reuse and source identity

Inspect the project's instructions and existing commands before writing automation.
Prefer suitable project scripts, then existing workspace helpers, then new automation.
Run working Python, PowerShell, Bash, and other project commands unchanged; do not translate them into JavaScript.
The `.mjs` requirement applies only to the Node entry file. Existing child processes retain their original language and project contract.

For new one-off automation, prefer Node APIs over newly embedded shell or Python programs.
Keep launchers small. Use arguments and focused edits when an existing helper fits; do not extract helpers solely to avoid small duplication.
For example, create another job for `scripts/hello.mjs` with `"args": ["world"]`; do not copy the script.

### Launch an existing project program

This example belongs in a workspace `.mjs` entry, not in the project source:

```js
import { spawn } from "node:child_process";

const child = spawn("python", ["scripts/check.py", ...process.argv.slice(2)], {
  cwd: "C:/src/example-project",
  shell: false,
  windowsHide: true,
  stdio: "inherit",
});
child.once("error", error => { console.error(error.code ?? "SPAWN_FAILED"); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (signal) console.error(signal); process.exitCode = code ?? 1; });
```

Use the project's documented interpreter and working directory. Unix projects may require `python3` or a virtual-environment executable.
For an existing PowerShell file, the same pattern can launch `pwsh` with `["-NoProfile", "-File", "scripts/check.ps1", ...args]`.
Existing Bash scripts can use their documented Bash interpreter. Do not silently add execution-policy bypasses, elevation, or approval suppression.
Use a package manager's documented entry point when the command is a Windows `.cmd` shim; `shell: false` cannot launch every shim directly.

The runner records `scriptSha256AtStart` from the entry file's exact bytes immediately before launch.
It saves the digest in the job record, not a source snapshot. Later edits or deletion leave the execution evidence intact.
`node_job_query` computes `scriptSha256Current` on demand and reports `sourceState`:

| State | Meaning |
| --- | --- |
| `same` | Current entry bytes match the launch digest |
| `changed` | Current entry bytes differ |
| `missing` | The entry file was deleted |
| `unreadable` | The current entry cannot be safely read |
| `not_recorded` | No launch digest exists, including older jobs and unlaunched jobs |

Source comparisons never alter status, logs, or activity order. The panel and list do not hash source files.
The digest covers only the entry file, not imports, dependencies, inputs, or environment. It cannot recover old source.
Without snapshots or filesystem locks across Node startup, an external edit can occur between hashing and Node reading the file.

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
├── .npm-cache/                   session-local npm download cache
├── scripts/                      ordinary .mjs source files
├── jobs/
│   └── <job-uuid>.json            definition and execution metadata
└── logs/
    ├── <job-uuid>/
    │   ├── stdout.log            full stdout
    │   └── stderr.log            full stderr
    └── npm-<operation-uuid>/      npm output and result evidence
```

`jobs/<uuid>.json` stores the name, script path, launch digest, arguments, timeout, state, timestamps, output metadata, and exit/termination information.
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
Rows include full UUID, name, `scriptPath`, status, type, and activity time with its source. `total` and `hasMore` identify omitted matches.
There is no pagination, wildcard status, or implicit default. Querying, listing, redraws, and reload never update recency.
Use native `ls`/`find` to discover source files. Use `node_job_list` to recover job IDs, script paths, or prior execution history.
When the UUID is known, query it directly. Do not rerun work merely to recover a result, or list before every job.

The panel uses this same recency comparator, but combines statuses and puts all known running jobs first.
Quiet background workers cannot be displaced by newer created or terminal jobs. Timed and background jobs have equal running priority.

## Panel and controls

Powerline displays exactly `node-scripts: on`, `node-scripts: off`, or `node-scripts: error`.
The extension defaults on. The active branch stores the preference across reload and resume.

```text
● Node jobs (3 running · 1 created · 6 ended)
├─ ◐ [7f3a] Local server       started    bg             — Listening on :8080
├─ ◐ [b914] Project tests      started    sync 60s       — Test 12 passed
├─ ◐ [a521] Quiet worker       started    bg
├─ ○ [c315] Generate report    created    sync 30s
├─ ✓ [ac31] Format report      finished   sync 10s       — Report written
├─ ✓ [9521] Generate report    finished   sync 10s       — Done
├─ ✓ [fa22] Parse metrics      finished   sync 10s       — Read 32 rows
├─ ✓ [29c1] Check inputs       finished   sync 10s       — Valid
└─ +2 jobs · /node-scripts expand
```

The collapsed panel has at most ten physical lines: one summary, up to eight one-line job rows, and one overflow line.
Wide layouts align names, status, execution mode/deadline, and latest output using terminal-width-aware space padding, not literal tabs.
Narrow layouts omit secondary columns. Rows never wrap or add spacer lines.
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

Transcript calls show a short action and job name, following the installed todo plugin's visual conventions.
Collapsed results show status and the latest output, with source warnings when needed.
Expansion shows full UUIDs, aligned metadata, source hashes, arguments, log paths, and bounded output without empty stdout/stderr headings.

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

Managed script entries, job records, logs, and npm control files must stay inside the current session's canonical workspace.
The plugin checks path containment, existing ancestor links, hard links, and workspace identity before managed file operations.
npm's mutable trees permit internal bin links but reject links outside this workspace. npm cache and operation logs stay inside it.
These checks do not restrict general `mkdir`/`rm`, script imports, or child-process filesystem access. They do not prevent external filesystem races.

Shell blocking applies to agent-issued native `bash` and `powershell`, including nested calls. Manual user `!` commands remain native.
Arbitrary scripts and existing programs have normal OS permissions. This is workflow control, not a security sandbox.
Detached descendants and cross-OS process trees are outside the termination guarantee. Windows and POSIX use different tree-termination mechanisms.
Full logs and indefinite services can consume unbounded disk space. There is no automatic collector or expiry policy.

## Native tools and resumed sessions

This configuration selects four built-in tools by default; extension tools remain available:

```json
"defaultTools": ["write", "grep", "find", "ls"]
```

node-scripts preserves the active native file tools. It does not activate missing tools or overwrite another extension's selection.
Project settings and CLI options can override these defaults.
rw-hashline separately provides `hashline_read` and `hashline_edit` and blocks native `read` and `edit` while on.

Pi 1.5.1 restores a resumed session's recorded tool selection. Changing defaults alone does not repair that selection.
`/reload` adds newly configured defaults, but does not remove previously active tools or re-enable unchanged defaults.
To correct an affected session once, resume it with modifiers:

```text
pi --no-mcp --resume --tools +write,+grep,+find,+ls,-bash,-powershell
```

The modifiers preserve extension tools. After the next model request, Pi records the corrected selection in the session.
Do not use a plain `--tools write,grep,...` allowlist here; it can exclude extension tools.

## Replacement and verification

This replaces the `temp-scripts` extension; it does not migrate or delete `~/.pi-temp-scripts` data.
Existing sessions need a user-issued `/reload` or a new session to change the loaded extension.

Commands run from the global agent directory:

```text
node --test extensions/node-scripts/node-scripts.test.ts
node extensions/node-scripts/verify-integration.ts <installed-pi-package-directory>
node extensions/node-scripts/verify-live.ts <installed-pi-package-directory>
node extensions/node-scripts/verify-reuse-live.ts <installed-pi-package-directory>
node extensions/node-scripts/verify-tui.ts <installed-pi-package-directory> <existing-node-pty-directory> <powerline-directory>
node scripts/verify-extensions.ts <installed-pi-package-directory> offline
```

Offline checks use real Node processes and isolated Pi sessions. They do not make external model requests.
Live checks use the configured provider, model, reasoning level, and authentication. Real requests and npm downloads can incur charges.
The live verifier runs twelve two-part work cycles with quiet and sustained-output services.
It also tests three native compactions, reloads, saved-session reopening, dependency protection, and deprecation.
The separate reuse verifier gives outcome-only requests for an existing project program, a second input, and prior execution evidence.
It checks real invocation receipts, unchanged project source, launcher reuse, and list/query recovery without another execution.
Python uses `NODE_SCRIPTS_TEST_PYTHON` or the platform default. Set `NODE_SCRIPTS_TEST_POWERSHELL` only when PowerShell execution is authorized.
The unit and reuse-live checks report unrun PowerShell coverage explicitly when that variable is unset.
Expect several minutes; provider speed and compaction time affect duration. The final result reports time and prompt/request/tool counts.
Verifiers preserve fixture evidence when process termination remains uncertain.
Terminal checks use an existing terminal driver; the runtime extension has no third-party dependency beyond Pi's supplied APIs.
Platform and runtime coverage must be reported with the verification results; passing one platform does not prove another.
