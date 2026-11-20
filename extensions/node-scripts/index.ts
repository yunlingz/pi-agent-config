import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandHome, loadConfig } from "./config.ts";
import { dependencies } from "./npm.ts";
import { clean } from "./process.ts";
import { retainedWorkspace, sessionWorkspace, type Workspace } from "./workspace.ts";
import { jobActivity } from "./types.ts";
import { PANEL, jobText, mode, panelLines, queryText, renderers } from "./ui.ts";

export const TOOLS = ["node_npm_add", "node_npm_remove", "node_job_create", "node_job_run", "node_job_deprecate", "node_job_query", "node_job_list", "rm", "mkdir"];
const PREFERENCE = "node-scripts-preference";
const idSchema = Type.Object({ jobId: Type.String({ format: "uuid", description: "Complete job UUID from create or list" }) });
const result = <T>(text: string, details: T, isError = false) => {
  const safe = clean(text);
  const lines = safe.split("\n");
  const shown = lines.slice(0, 1800).join("\n");
  const bytes = Buffer.from(shown);
  const limited = bytes.subarray(0, 48 * 1024).toString("utf8");
  const content = lines.length > 1800 || bytes.length > 48 * 1024
    ? `${limited}\n[Output truncated; full definitions and logs remain in the workspace.]` : shown;
  return { content: [{ type: "text" as const, text: content }], details, isError };
};

export default function nodeScripts(pi: ExtensionAPI) {
  let workspace: Workspace | undefined;
  let fault: string | undefined;
  let enabled = true;
  let expanded = false;
  let dispose: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let redraw: (() => void) | undefined;
  const required = () => { if (!workspace || fault) throw new Error(fault ?? "node-scripts workspace is not available"); return workspace; };
  const status = (ctx: ExtensionContext) => { if (ctx.mode === "tui") ctx.ui.setStatus("node-scripts", `node-scripts: ${enabled ? fault ? "error" : "on" : "off"}`); };
  const activate = () => pi.setActiveTools([...pi.getActiveTools().filter(name => !TOOLS.includes(name)), ...(enabled ? TOOLS : [])]);
  const detach = () => { dispose?.(); dispose = undefined; clearInterval(timer); timer = undefined; redraw = undefined; };
  pi.on("session_start", async (_event, ctx) => {
    detach();
    workspace = undefined; fault = undefined; enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === PREFERENCE
      && entry.data !== null && typeof entry.data === "object" && "enabled" in entry.data && typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
    try { workspace = await sessionWorkspace(await loadConfig(getAgentDir()), ctx.sessionManager.getSessionId()); }
    catch (error) {
      // Bad reloaded settings must not detach ownership of an already running background job.
      workspace = await retainedWorkspace(ctx.sessionManager.getSessionId());
      fault = error instanceof Error ? error.message : "Cannot initialize node-scripts";
      ctx.ui.notify(fault, "error");
    }
    registerTools(); activate(); status(ctx);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(PANEL, tui => {
        redraw = () => tui.requestRender();
        return { render: width => enabled && workspace ? panelLines(workspace.views(), width, ctx.ui.theme, expanded || ctx.ui.getToolsExpanded()) : [], invalidate() {} };
      }, { placement: "aboveEditor" });
      dispose = workspace?.subscribe(() => redraw?.());
      timer = setInterval(() => redraw?.(), 1000);
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    detach(); ctx.ui.setWidget(PANEL, undefined); ctx.ui.setStatus("node-scripts", undefined);
    if (event.reason === "reload") await workspace?.interruptTimed();
    else await workspace?.shutdown();
  });
  pi.on("session_before_compact", async () => { await workspace?.interruptTimed(); });
  pi.on("tool_call", event => {
    if (!enabled) {
      if (TOOLS.includes(event.toolName)) return { block: true, reason: "node-scripts is off; use /node-scripts on" };
    } else if (event.toolName === "bash" || event.toolName === "powershell") {
      return { block: true, reason: "Agent-issued Bash and PowerShell are blocked while node-scripts is enabled. Node jobs provide execution; native file tools remain unchanged. Do not retry through another shell." };
    }
  });

  pi.registerCommand("node-scripts", {
    description: "Enable/disable Node tools, show workspace/status, or expand/collapse jobs",
    async handler(args, ctx) {
      const command = args.trim().toLowerCase();
      if (command === "expand" || command === "collapse") { expanded = command === "expand"; redraw?.(); return; }
      if (command === "status") { ctx.ui.notify(`node-scripts: ${enabled ? "on" : "off"}\nWorkspace: ${workspace?.root ?? "unavailable"}${fault ? `\n${fault}` : ""}`, "info"); return; }
      if (!["", "on", "off"].includes(command)) { ctx.ui.notify("Usage: /node-scripts [on|off|status|expand|collapse]", "warning"); return; }
      if (!ctx.isIdle() || workspace?.active || workspace?.dependencyBusy) { ctx.ui.notify("Wait for active jobs and npm operations, or deprecate running jobs first.", "warning"); return; }
      enabled = command === "" ? !enabled : command === "on";
      pi.appendEntry(PREFERENCE, { enabled }); activate(); status(ctx); redraw?.();
      ctx.ui.notify(`node-scripts ${enabled ? "on; agent shell tools blocked" : "off; native tools unchanged"}`, "info");
    },
  });
  function registerTools() {
    const guidance = [
      `Current node-scripts workspace: ${workspace?.root ?? "unavailable; check /node-scripts status"}.`,
      "node-scripts replaces agent-issued Bash and PowerShell execution, not normal file authoring. Scripts have normal OS permissions, not a sandbox.",
      "node-scripts workspace scripts must use .mjs files and ESM syntax, with explicit .mjs extensions in relative imports.",
      "The node-scripts workspace package.json must retain private:true and type:module. These conventions do not apply to unrelated projects or installed packages.",
      "Only node-scripts jobs are single-use; script files can be reused, edited, or deleted after execution.",
      "Before creating another node-scripts script, check existing workspace scripts for suitable code. Prefer focused edits and arguments when a script fits.",
      "Reuse node-scripts helpers through relative ESM imports when useful; do not extract helpers solely to avoid small duplication.",
      "Later node-scripts source edits or deletion do not change retained execution evidence.",
      "Keep node-scripts source and dependency mutations separate from running jobs. Logs persist; do not print credentials or secrets.",
      "Do not invoke PowerShell through node-scripts, including pwsh, powershell.exe and .ps1 scripts.",
    ];
    pi.registerTool({ name: "node_job_create", label: "Create Node job", description: "Create an immutable single-use job for an existing .mjs script inside the current session workspace. The script remains editable and reusable. Does not execute it. Returns the complete UUID and definition.", promptSnippet: "Define a Node script job", promptGuidelines: guidance,
      parameters: Type.Object({ scriptPath: Type.String(), args: Type.Optional(Type.Array(Type.String())), timeoutSeconds: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 2147483 }), Type.Null()], { description: "Positive seconds for timed foreground execution. Omit or set null for indefinite background execution. Do not substitute a large timeout for no timeout." })), name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }), executionMode: "sequential", ...renderers("Create Node job"),
      async execute(_id, input) { const job = await required().createJob({ ...input, timeoutSeconds: input.timeoutSeconds ?? undefined }); return result(jobText(job), job); },
    });
    pi.registerTool({ name: "node_job_run", label: "Run Node job", description: "Run a created .mjs ESM job once with Pi's Node binary and inherited environment. Record entry-file SHA-256 before launch, without saving source. Timeout means foreground wait and enforced deadline; no timeout returns after startup. Full logs persist. Interruption deprecates timed jobs; background jobs survive compaction/reload. No callback messages.", promptSnippet: "Execute a previously created .mjs ESM job",
      promptGuidelines: [
        "node_job_run is single-use. A timeout means foreground execution; no timeout means indefinite background execution. Scripts own internal concurrency.",
        "Interrupting a timed node_job_run terminates and deprecates it. Native /reload during timed work requires Escape first.",
        "Only background node-scripts jobs survive compaction/reload. Jobs never send callbacks; query status when needed.",
      ], parameters: idSchema, executionMode: "sequential", ...renderers("Run Node job", id => workspace?.jobs.get(id)?.name),
      async execute(_id, input, signal, update) {
        const store = required();
        const job = await store.run(input.jobId, signal, value => update?.(result(`${jobText(value)}\n${value.lastOutputLine ?? ""}`, value)));
        return result(queryText(job), job, ["failed", "timeout", "unconfirmed"].includes(job.status));
      },
    });
    pi.registerTool({ name: "node_job_deprecate", label: "Deprecate Node job", description: "Invalidate a job in any state. Terminate its owned process tree if running. Preserve source, definition and logs; hide successfully deprecated jobs. Never kill persisted PIDs after restart.", promptSnippet: "Terminate and invalidate a job without deleting evidence", parameters: idSchema, executionMode: "parallel", ...renderers("Deprecate Node job", id => workspace?.jobs.get(id)?.name),
      async execute(_id, input) { const job = await required().deprecate(input.jobId); return result(queryText(job), job); },
    });
    pi.registerTool({ name: "node_job_query", label: "Query Node job", description: "Read one current-session job definition, status, termination evidence and bounded stdout/stderr tails. Compare the current entry file with its launch SHA-256: same, changed, missing, unreadable, or not_recorded. Full logs persist. Does not restart jobs or change their order.", promptSnippet: "Inspect job evidence and compare current source",
      promptGuidelines: ["node_job_query compares entry-file bytes only, not imported modules, dependencies, inputs, or environment. A hash does not recover source."],
      parameters: idSchema, executionMode: "parallel", ...renderers("Query Node job", id => workspace?.jobs.get(id)?.name),
      async execute(_id, input) { const job = await required().query(input.jobId); return result(queryText(job), job); },
    });
    pi.registerTool({ name: "node_job_list", label: "List Node jobs", description: "Return the current workspace path and recent jobs of exactly one required status. recentN is required (1–100). Sort by last nonempty output time, otherwise start time, otherwise creation time; queries never change order. Returns full UUID/name/status/type/activity, matching count and hasMore. No output tails.", promptSnippet: "Discover the workspace and recent jobs for one status",
      promptGuidelines: ["node_job_list returns the current workspace path even when empty, and recovers complete job UUIDs. Avoid internal-record reads and separate polling helpers."],
      parameters: Type.Object({ status: Type.Union([Type.Literal("created"), Type.Literal("started"), Type.Literal("finished"), Type.Literal("failed"), Type.Literal("timeout"), Type.Literal("deprecated"), Type.Literal("unconfirmed")]), recentN: Type.Integer({ minimum: 1, maximum: 100 }) }), executionMode: "parallel", ...renderers("List Node jobs"),
      async execute(_id, input) {
        const store = required();
        const selected = store.list(input.status, input.recentN);
        const jobs = selected.jobs.map(job => ({ id: job.id, name: job.name, status: job.status, type: mode(job), activity: jobActivity(job) }));
        return result(`Workspace: ${store.root}\nStatus: ${input.status}\n${jobs.map(job => `${job.id} | ${job.name} | ${job.status} | ${job.type} | ${job.activity.source}: ${new Date(job.activity.at).toISOString()}`).join("\n")}\nShowing ${jobs.length} of ${selected.total}; hasMore: ${selected.hasMore}.`, { workspace: store.root, status: input.status, recentN: input.recentN, jobs, total: selected.total, hasMore: selected.hasMore });
      },
    });
    for (const action of ["add", "remove"] as const) pi.registerTool({ name: `node_npm_${action}`, label: `npm ${action}`, description: `${action === "add" ? "Install an exact-version production dependency" : "Remove a direct dependency"} in the session workspace using its configured registry. Lifecycle scripts disabled, logs retained, no automatic upgrades. Reject while jobs run; operation deadline 120s.`, promptSnippet: `${action === "add" ? "Add" : "Remove"} session-workspace npm dependencies`,
      parameters: Type.Object({ package: Type.String(), version: Type.Optional(Type.String({ description: "Required exact semantic version for add; omitted for remove" })) }), executionMode: "sequential", ...renderers(`npm ${action}`),
      async execute(_id, input, signal, update) { const value = await dependencies(required(), action, input.package, input.version, signal, text => update?.(result(text.slice(-8192), undefined))); return result(`${action}: ${value.package}${value.version ? `@${value.version}` : ""}\nWorkspace: ${value.workspace}\nEvidence: ${value.logDirectory}`, value); },
    });
    pi.registerTool({ name: "mkdir", label: "mkdir", description: "Create a directory and missing parents. Relative paths use Pi's current project directory, not the script workspace. Existing directories succeed.", promptSnippet: "Create directories without a shell", parameters: Type.Object({ path: Type.String({ minLength: 1 }) }), executionMode: "sequential", ...renderers("mkdir"),
      async execute(_id, input, _signal, _update, ctx) { const path = resolve(ctx.cwd, expandHome(input.path)); await withFileMutationQueue(path, () => mkdir(path, { recursive: true })); return result(`Directory ready: ${path}`, { path }); },
    });
    pi.registerTool({ name: "rm", label: "rm", description: "Remove a file or link, or a directory tree with recursive:true. Relative paths use Pi's project directory. Links themselves are removed, not targets. Root/home deletion and empty paths reject. Missing paths are reported. Deletion is permanent.", promptSnippet: "Remove files and directories without a shell", parameters: Type.Object({ path: Type.String({ minLength: 1 }), recursive: Type.Optional(Type.Boolean()) }), executionMode: "sequential", ...renderers("rm"),
      async execute(_id, input, _signal, _update, ctx) {
        if (!input.path.trim()) throw new Error("Removal path must not be empty");
        const path = resolve(ctx.cwd, expandHome(input.path));
        if (path === parse(path).root || path.toLowerCase() === resolve(homedir()).toLowerCase()) throw new Error("Refusing to remove a filesystem root or home directory");
        const removed = await withFileMutationQueue(path, async () => {
          let info; try { info = await lstat(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
          if (!info.isSymbolicLink()) {
            const canonical = await realpath(path);
            if (canonical === parse(canonical).root || canonical === await realpath(homedir())) throw new Error("Refusing to remove a filesystem root or home directory");
          }
          if (info.isDirectory() && !info.isSymbolicLink() && !input.recursive) throw new Error("Directory deletion requires recursive:true");
          await rm(path, { recursive: input.recursive ?? false, force: false }); return true;
        });
        return result(`${removed ? "Removed" : "Not found"}: ${path}`, { path, removed });
      },
    });
  }
  // Pi restores transcript renderers before session_start; refresh path guidance after workspace initialization.
  registerTools();
}
