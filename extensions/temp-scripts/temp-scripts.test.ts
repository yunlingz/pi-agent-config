import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test, { after } from "node:test";
import { validateDependencies, validateLock } from "./dependencies.ts";
import { cleanupJob, createJob, executeJob, finishInline, inspectJob, releaseJob, setRetention, withJobLease } from "./jobs.ts";
import { blockedTool, nativeBlockReason } from "./policy.ts";
import { displayText, runProcess } from "./process.ts";
import { progressText } from "./progress.ts";
import type { JobManifest, Progress, RunResult, SourceView } from "./types.ts";
import { restoredPreference, PREFERENCE_ENTRY } from "./controls.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { executionEnvironment, mergeEnvironment, projectBinDirectories } from "./environment.ts";
import { nodeShimTarget, nativeInvocation } from "./executables.ts";
import { CommandLog } from "./commands.ts";
import { jobDirectory, storageRoot } from "./storage.ts";
import { backgroundActive, backgroundStatus, forgetBackground, runForeground, startBackground, stopBackground, stopSessionBackground } from "./background.ts";

const previousStorage = process.env.PI_TEMP_SCRIPTS_DIR;
const testStorage = await mkdtemp(join(tmpdir(), "script-storage-test-"));
process.env.PI_TEMP_SCRIPTS_DIR = testStorage;
after(async () => {
  if (previousStorage === undefined) delete process.env.PI_TEMP_SCRIPTS_DIR;
  else process.env.PI_TEMP_SCRIPTS_DIR = previousStorage;
  assert.deepEqual(await readdir(join(testStorage, "jobs")), []);
  await rm(testStorage, { recursive: true });
});

async function fixture(action: (job: JobManifest) => Promise<void>): Promise<void> {
  const job = await createJob("unit-session", "Synthetic test job", () => {});
  try { await action(job); }
  finally {
    await stopSessionBackground(job.sessionId);
    assert(!existsSync(join(job.root, "lease")), "Unresolved test lease retained");
    await rm(job.root, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(job.root));
  }
}

test("agent shell tools are blocked regardless of command or shell edition", () => {
  assert(blockedTool("bash"));
  assert(blockedTool("powershell"));
  for (const name of ["script_inline", "script_js", "script_job", "read", "edit", "write", "ast_grep", "ast_edit"]) assert.equal(blockedTool(name), undefined);
});

test("managed native execution rejects shells and other inline interpreters without parsing command strings", () => {
  for (const command of ["powershell", "PowerShell.exe", "pwsh", "pwsh7", "pwsh-7.5", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "./run.ps1", "bash", "/bin/sh", "cmd.exe"]) {
    assert(nativeBlockReason(command, ["--version"]), command);
  }
  for (const command of ["python", "ruby", "perl"]) assert(nativeBlockReason(command, ["-e", "inline code"]));
  assert(nativeBlockReason("python", ["-c", "inline code"]));
  for (const command of ["git", "node", "nodejs", "npm", "custom-project-cli"]) assert.equal(nativeBlockReason(command, ["--version"]), undefined);
  assert.equal(nativeBlockReason("python", ["-m", "pytest"]), undefined);
});

test("dependency declarations require exact versions and approved resolved feeds", () => {
  validateDependencies({ "is-number": "7.0.0", "@scope/package": "1.2.3-beta.1" });
  for (const version of ["latest", "^1.0.0", "file:../project", "https://example.com/a.tgz", "npm:other@1.0.0"]) assert.throws(() => validateDependencies({ example: version }));
  validateLock({ packages: { "": {}, "node_modules/a": { resolved: "https://ms-feed-25.pkgs.visualstudio.com/feed/a.tgz" } } });
  assert.throws(() => validateLock({ packages: { "node_modules/a": { resolved: "https://registry.npmjs.org/a.tgz" } } }));
  assert.throws(() => validateLock({ packages: { "node_modules/a": { resolved: "file:../outside" } } }));
});

test("jobs retain files until release, protect pins and leases, and verify exact cleanup", async () => {
  await fixture(async job => {
    await assert.rejects(cleanupJob(job, job.sessionId), /Release/u);
    await setRetention(job, job.sessionId, "pinned");
    await assert.rejects(cleanupJob(job, job.sessionId), /Release/u);
    await withJobLease(job, job.sessionId, async () => {
      await assert.rejects(setRetention(job, job.sessionId, "released"), /lease/u);
    });
    assert.equal(await releaseJob(job, job.sessionId), true);
    assert(!existsSync(job.root));
  });
});

test("ownership rejects another session, modified tokens, and linked roots", async () => {
  await fixture(async job => {
    await assert.rejects(inspectJob(job, "different-session"), /ownership/u);
    await assert.rejects(inspectJob({ ...job, token: "wrong" }, job.sessionId), /ownership/u);
    const alias = `${job.root}-link`;
    try {
      await symlink(job.root, alias, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(inspectJob({ ...job, root: alias }, job.sessionId), /original directory/u);
    } finally { await rm(alias, { force: true }); }
  });
});

test("actual JavaScript runs preserve separate snapshots, stderr, cwd, arguments and failure evidence", async () => {
  await fixture(async job => {
    const path = join(job.root, "work", "main.mjs");
    await writeFile(path, 'console.log(process.argv[2]); console.error("diagnostic"); console.log(process.cwd());\n');
    const first = await executeJob(job, job.sessionId, "main.mjs", ["first"], { purpose: "first", cwd: job.root, timeoutSeconds: 5 });
    assert.equal(first.status, "succeeded", first.output);
    assert(first.output.includes("first"));
    assert(first.output.includes(job.root));
    assert.equal(await readFile(first.stderrPath, "utf8"), "diagnostic\n");
    await writeFile(path, 'console.log("second"); process.exitCode = 3;\n');
    const second = await executeJob(job, job.sessionId, "main.mjs", [], { purpose: "second", cwd: job.root, timeoutSeconds: 5 });
    assert.equal(second.status, "failed");
    assert.equal(second.exitCode, 3);
    assert.notEqual(first.sourceHash, second.sourceHash);
    assert.notEqual(first.run, second.run);
    assert((await readFile(join(first.run, "source", "main.mjs"), "utf8")).includes("diagnostic"));
    assert(existsSync(first.stdoutPath));
  });
});

test("inline JavaScript supports await and retained source without a compiler", async () => {
  await fixture(async job => {
    const code = 'await Promise.resolve(); console.log("inline-ready");\n';
    await writeFile(join(job.root, "work", "main.mjs"), code);
    const result = await executeJob(job, job.sessionId, "main.mjs", [], { purpose: "inline", cwd: job.root, timeoutSeconds: 5, inline: code });
    assert.equal(result.status, "succeeded", result.output);
    assert.equal(result.output.trim(), "inline-ready");
    assert.equal(await readFile(join(result.run, "source", "main.mjs"), "utf8"), code);
  });
});

test("source snapshots reject TypeScript, escaping entries, source links, and linked run directories", async () => {
  await fixture(async job => {
    const options = { purpose: "reject", cwd: job.root, timeoutSeconds: 5 };
    await assert.rejects(executeJob(job, job.sessionId, "main.ts", [], options), /\.mjs/u);
    await assert.rejects(executeJob(job, job.sessionId, "../main.mjs", [], options), /inside/u);
    await symlink(join(job.root, "manifest.json"), join(job.root, "work", "main.mjs"));
    await assert.rejects(executeJob(job, job.sessionId, "main.mjs", [], options), /without links/u);
    await rm(join(job.root, "work", "main.mjs"));
    await rm(join(job.root, "runs"), { recursive: true });
    await symlink(join(job.root, "work"), join(job.root, "runs"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(executeJob(job, job.sessionId, "main.mjs", [], options), /Run directory/u);
  });
});

test("runtime helper reports progress separately and launches native commands without a shell", async () => {
  await fixture(async job => {
    const reports: Progress[] = [];
    await writeFile(join(job.root, "work", "main.mjs"), 'const { progress, exec } = await import(process.env.PI_SCRIPT_RUNTIME); progress("inspecting"); const child = await exec("git", ["--version"], { timeoutSeconds: 3 }); console.log(child.output.trim());\n');
    const result = await executeJob(job, job.sessionId, "main.mjs", [], { purpose: "native", cwd: job.root, timeoutSeconds: 5, onProgress: update => reports.push(update) });
    assert.equal(result.status, "succeeded", result.output);
    assert.match(result.output, /git version/u);
    assert(reports.some(value => value.scriptReport === "inspecting"));
    assert(!result.output.includes("inspecting"));
  });
});

test("managed lifecycle can execute project Node entry points and tests while rejecting PowerShell", async () => {
  await fixture(async job => {
    await writeFile(join(job.root, "project.mjs"), 'console.log("PROJECT_NODE_OK");');
    await writeFile(join(job.root, "project.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("project", () => assert.equal(2 + 2, 4));');
    const code = 'const {exec} = await import(process.env.PI_SCRIPT_RUNTIME); for (const args of [["project.mjs"], ["--test", "project.test.mjs"]]) { const child = await exec(process.execPath, args, {timeoutSeconds: 3}); if (child.status !== "succeeded") throw new Error(child.output); console.log(child.output); } for (const command of ["pwsh", "powershell.exe"]) { try { await exec(command, ["--version"], {timeoutSeconds: 1}); throw new Error("Unblocked"); } catch (error) { if (!error.message.includes("PowerShell execution is blocked")) throw error; } }';
    await writeFile(join(job.root, "work", "main.mjs"), code);
    const result = await executeJob(job, job.sessionId, "main.mjs", [], {purpose: "project workflow", cwd: job.root, timeoutSeconds: 8});
    assert.equal(result.status, "succeeded", result.output);
    assert.match(result.output, /PROJECT_NODE_OK/u);
    assert.match(result.output, /pass 1/u);
  });
});

test("deadlines stop an owned process tree and retain streamed evidence", async () => {
  await fixture(async job => {
    const code = 'const {spawn} = await import("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "inherit"}); console.log(child.pid); process.on("SIGTERM", () => { child.kill(); }); child.on("exit", () => process.exit()); setInterval(() => {}, 1000);';
    await writeFile(join(job.root, "work", "main.mjs"), code);
    const reports: Progress[] = [];
    const result = await executeJob(job, job.sessionId, "main.mjs", [], {purpose: "tree", cwd: job.root, timeoutSeconds: 0.3, onProgress: update => reports.push(update)});
    assert.equal(result.status, "timed_out", result.output);
    assert(result.terminationConfirmed);
    const pid = Number(result.output.trim());
    assert(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    assert(reports.some(value => value.outputTail?.includes(String(pid))));
  });
});

test("quiet helpers time out, emit observed heartbeats, and stop their direct process", async () => {
  await fixture(async job => {
    const reports: Progress[] = [];
    const result = await runProcess({ command: process.execPath, args: ["--input-type=module", "-"], stdin: "setInterval(() => {}, 1000);", cwd: job.root, timeoutSeconds: 0.2,
      stdoutPath: join(job.root, "stdout"), stderrPath: join(job.root, "stderr"), heartbeatMs: 30, onProgress: update => reports.push(update) });
    assert.equal(result.status, "timed_out");
    assert(result.terminationConfirmed);
    assert(reports.length >= 2);
    assert(reports.every(value => value.outputBytes === 0));
  });
});

test("abort and output limits are failures with preserved partial logs", async () => {
  await fixture(async job => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const aborted = await runProcess({ command: process.execPath, args: ["-e", 'console.log("start"); setInterval(() => {}, 1000)'], cwd: job.root, timeoutSeconds: 5, signal: controller.signal,
        stdoutPath: join(job.root, "abort-out"), stderrPath: join(job.root, "abort-err") });
      assert.equal(aborted.status, "cancelled");
      assert(aborted.terminationConfirmed);
    } finally { clearTimeout(timer); }
    const limited = await runProcess({ command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(50000))'], cwd: job.root, timeoutSeconds: 5,
      stdoutPath: join(job.root, "limit-out"), stderrPath: join(job.root, "limit-err"), maxLogBytes: 1000 });
    assert.equal(limited.status, "output_limit");
    assert.equal((await readFile(join(job.root, "limit-out"))).length, 1000);
  });
});

test("source changes during a run do not change its executed snapshot", async () => {
  await fixture(async job => {
    const path = join(job.root, "work", "main.mjs");
    await writeFile(path, 'await new Promise(r => setTimeout(r, 100)); console.log("original");');
    let changed = false;
    const running = executeJob(job, job.sessionId, "main.mjs", [], { purpose: "snapshot", cwd: job.root, timeoutSeconds: 5, onProgress: () => { changed = true; } });
    while (!changed) await new Promise(accept => setTimeout(accept, 5));
    await writeFile(path, 'console.log("changed");');
    const result = await running;
    assert.equal(result.output.trim(), "original");
  });
});

test("cleanup removes internal links without deleting their external targets", async () => {
  const outside = await mkdtemp(join(tmpdir(), "script-external-test-"));
  try {
    await writeFile(join(outside, "keep"), "deliverable");
    await fixture(async job => {
      await symlink(outside, join(job.root, "external"), process.platform === "win32" ? "junction" : "dir");
      await setRetention(job, job.sessionId, "released");
      assert(await cleanupJob(job, job.sessionId));
      assert.equal(await readFile(join(outside, "keep"), "utf8"), "deliverable");
    });
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("progress labels observations separately from script reports and strips terminal controls", () => {
  const text = progressText("Inspect files", { phase: "running", elapsedMs: 20500, outputBytes: 20, lastOutputMs: null, scriptReport: "3 files" });
  assert.match(text, /elapsed 20\.5s/u);
  assert.match(text, /no output yet/u);
  assert.match(text, /Script report: 3 files/u);
  assert.equal(displayText("\x1b[31mred\x1b[0m\x00"), "red");
});

test("preference defaults on and restores the active branch without rewriting history", () => {
  const entries: SessionEntry[] = [];
  assert.equal(restoredPreference(entries), true);
  const entry = (enabled: boolean): SessionEntry => ({type:"custom", customType:PREFERENCE_ENTRY, data:{enabled}, id:String(enabled), parentId:null, timestamp:new Date().toISOString()});
  entries.push(entry(false));
  assert.equal(restoredPreference(entries), false);
  entries.push(entry(true));
  assert.equal(restoredPreference(entries), true);
  entries.pop();
  assert.equal(restoredPreference(entries), false);
});

test("native child output reaches progress before the child finishes", async () => {
  await fixture(async job => {
    const childSource = 'console.log("EARLY_STDOUT"); console.error("EARLY_STDERR"); setTimeout(()=>console.log("LATE_STDOUT"), 300)';
    await writeFile(join(job.root, "work", "main.mjs"), `const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec(process.execPath,["-e", ${JSON.stringify(childSource)}],{timeoutSeconds:2});`);
    const updates: Progress[] = [];
    const result = await executeJob(job, job.sessionId, "main.mjs", [], {purpose:"stream",cwd:job.root,timeoutSeconds:4,onProgress:value=>updates.push(value)});
    assert.equal(result.status, "succeeded", result.output);
    assert(updates.some(value=>value.outputTail?.includes("EARLY_STDOUT") && !value.outputTail.includes("LATE_STDOUT")));
    assert(result.output.includes("EARLY_STDERR"));
    assert(result.output.includes("LATE_STDOUT"));
  });
});

test("environment setup preserves inherited values and normalizes Windows Path without shell startup", () => {
  const inherited = { PATH: "/usr/bin:/bin", FIXTURE_VALUE: "private-fixture" };
  const env = executionEnvironment(inherited, ["/agent/bin", "/agent/bin"], "linux");
  assert.equal(env.PATH, "/agent/bin:/usr/bin:/bin");
  assert.equal(env.FIXTURE_VALUE, inherited.FIXTURE_VALUE);
  assert.equal(inherited.PATH, "/usr/bin:/bin");
  const windows = executionEnvironment({ Path: "C:\\Tools;C:\\Windows", PATH: "ignored-duplicate" }, ["c:\\tools", "C:\\Agent\\bin"], "win32");
  assert.equal(windows.Path, "C:\\Agent\\bin;C:\\Tools;C:\\Windows");
  assert.equal(windows.PATH, undefined);
  assert.deepEqual(mergeEnvironment({Path:"old",HOME:"home"},{PATH:"new",home:"changed"},"win32"),{PATH:"new",home:"changed"});
});

test("real managed child resolves a PATH-only executable and inherits environment with explicit overrides", { skip: process.platform === "win32" }, async () => {
  await fixture(async job => {
    const bin = join(job.root, "custom-bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "path-only-fixture"));
    const childSource = 'console.log(JSON.stringify({inherited:process.env.SCRIPT_ENV_FIXTURE==="private-fixture",override:process.env.SCRIPT_OVERRIDE==="overridden",cwd:process.cwd()}));';
    const source = `const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); const child=await exec("path-only-fixture",["-e",${JSON.stringify(childSource)}],{timeoutSeconds:2,env:{SCRIPT_OVERRIDE:"overridden"}}); if(child.status!=="succeeded") throw new Error(child.output);`;
    await writeFile(join(job.root, "work", "main.mjs"), source);
    const result = await executeJob(job, job.sessionId, "main.mjs", [], {purpose:"PATH and environment fixture",cwd:job.root,timeoutSeconds:4,env:executionEnvironment({...process.env,SCRIPT_ENV_FIXTURE:"private-fixture"},[bin])});
    assert.equal(result.status, "succeeded", result.output);
    assert.deepEqual(JSON.parse(result.output.trim()), {inherited:true,override:true,cwd:job.root});
    assert(!result.output.includes("private-fixture"));
  });
});

test("Windows npm Node shim parsing rejects ambiguous and arbitrary batch content", () => {
  assert.equal(nodeShimTarget('@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n'), "node_modules\\npm\\bin\\npm-cli.js");
  assert.equal(nodeShimTarget('"%~dp0\\tool.js" %*\n'), "tool.js");
  assert.equal(nodeShimTarget('echo unsupported\n'), undefined);
  assert.equal(nodeShimTarget('"%dp0%\\a.js" %*\n"%dp0%\\b.js" %*'), undefined);
});

test("managed commands preserve literal arguments, stdin, spaced cwd, project bins, and child failure status", {skip:process.platform === "win32"}, async () => {
  await fixture(async job => {
    const cwd=join(job.root,"project with spaces");
    await mkdir(join(cwd,"node_modules",".bin"),{recursive:true});
    await symlink(process.execPath,join(cwd,"node_modules",".bin","project-fixture"));
    const argumentsFixture=["space value","$literal","a;b","*.mjs","界",'quote"value'];
    const childSource='let input=""; for await(const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({args:process.argv.slice(1),input,cwd:process.cwd()}));';
    const source=`const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec("project-fixture",["-e",${JSON.stringify(childSource)},...${JSON.stringify(argumentsFixture)}],{timeoutSeconds:2,input:"finite stdin\\n"}); const expected=await exec(process.execPath,["-e","process.exitCode=9"],{timeoutSeconds:2,allowFailure:true}); if(expected.exitCode!==9) throw new Error("Wrong exit code");`;
    await writeFile(join(job.root,"work","main.mjs"),source);
    const result=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"command compatibility",cwd,timeoutSeconds:5});
    assert.equal(result.status,"succeeded",result.output);
    assert.deepEqual(JSON.parse(result.output.trim()),{args:argumentsFixture,input:"finite stdin\n",cwd});
    assert.equal(projectBinDirectories(cwd)[0],join(cwd,"node_modules",".bin"));
    await writeFile(join(job.root,"work","main.mjs"),'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec(process.execPath,["-e","process.exitCode=8"],{timeoutSeconds:2});');
    assert.equal((await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"nonzero propagation",cwd,timeoutSeconds:4})).status,"failed");
  });
});

test("missing tools, invalid cwd, and shell aliases fail clearly without a fallback shell", async () => {
  await fixture(async job => {
    await assert.rejects(nativeInvocation("nonexistent-fixture-command",[],job.root,process.env),/Executable not found/u);
    await assert.rejects(nativeInvocation("bash",["-c","echo bypass"],job.root,process.env),/Shell execution is blocked/u);
    const result=await runProcess({command:process.execPath,args:[],cwd:join(job.root,"missing"),timeoutSeconds:2,stdoutPath:join(job.root,"missing-out"),stderrPath:join(job.root,"missing-err")});
    assert.equal(result.status,"failed");
    assert.equal(result.launchError,"ENOENT");
    assert.match(await readFile(join(job.root,"missing-err"),"utf8"),/Process launch failed: ENOENT/u);
  });
});

test("managed lifecycle supports Git mutations, package scripts, parallel commands, and finite pipeline input", async () => {
  await fixture(async job => {
    await writeFile(join(job.root,"package.json"),JSON.stringify({private:true,type:"module",scripts:{test:'node --test project.test.mjs'}}));
    await writeFile(join(job.root,"project.test.mjs"),'import test from "node:test"; import assert from "node:assert/strict"; test("fixture",()=>assert.equal(6*7,42));');
    const source = [
      'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME);',
      'const {writeFile}=await import("node:fs/promises");',
      'await exec("git",["init","--quiet"],{timeoutSeconds:2});',
      'await writeFile("tracked.txt","fixture\\n");',
      'await exec("git",["add","tracked.txt"],{timeoutSeconds:2});',
      'await exec("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","--quiet","-m","Fixture"],{timeoutSeconds:2});',
      'const outcomes=await Promise.all([exec("git",["status","--porcelain"],{timeoutSeconds:2}),exec("git",["log","-1","--format=%s"],{timeoutSeconds:2})]);',
      'if(!outcomes[1].output.includes("Fixture")) throw new Error("Missing commit");',
      'await exec("npm",["test","--","--test-reporter=tap"],{timeoutSeconds:5});',
    ].join("\n");
    await writeFile(join(job.root,"work","main.mjs"),source);
    const result=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"common development commands",cwd:job.root,timeoutSeconds:12});
    assert.equal(result.status,"succeeded",result.output);
    assert.match(result.output,/pass 1/u);
    assert.match(result.output,/Fixture/u);
  });
});

test("successful disposable inline evidence is removed while its captured result remains readable", async () => {
  await fixture(async job => {
    const code = 'const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec("git",["--version"],{timeoutSeconds:2});';
    await writeFile(join(job.root, "work", "main.mjs"), code);
    const output = await executeJob(job, job.sessionId, "main.mjs", [], {purpose:"one time",cwd:job.root,timeoutSeconds:4,inline:code});
    assert.equal(output.status,"succeeded",output.output);
    assert.equal(output.commands.length,1);
    assert.equal(output.commands[0]?.status,"succeeded");
    assert.equal((await finishInline(job,job.sessionId,output)).state,"removed");
    assert(!existsSync(job.root));
    assert.match(output.output,/git version/u);
  });
});

test("inline retention preserves explicit keeps, artifacts, output truncation, failures and uncertain termination", async () => {
  const cases = [
    {name:"keep",code:'console.log("keep");',keep:true,change:(value:RunResult)=>value},
    {name:"artifact",code:'const {writeFile}=await import("node:fs/promises"); await writeFile(process.env.PI_SCRIPT_ARTIFACTS+"/deliverable.txt","keep");',change:(value:RunResult)=>value},
    {name:"truncated",code:'console.log("x".repeat(50000));',change:(value:RunResult)=>value},
    {name:"failed",code:'process.exitCode=2;',change:(value:RunResult)=>value},
    {name:"uncertain",code:'console.log("uncertain");',change:(value:RunResult)=>({...value,terminationConfirmed:false})},
    {name:"partial commands",code:'console.log("partial");',change:(value:RunResult)=>({...value,commandsTruncated:true})},
  ];
  for(const entry of cases) await fixture(async job=>{
    await writeFile(join(job.root,"work","main.mjs"),entry.code);
    const output=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:entry.name,cwd:job.root,timeoutSeconds:4,inline:entry.code});
    assert.equal((await finishInline(job,job.sessionId,entry.change(output),entry.keep)).state,"retained",entry.name);
    assert(existsSync(output.stdoutPath),entry.name);
  });
});

test("cleanup inspection failures retain files and report cleanup_failed",async()=>{
  await fixture(async job=>{
    const code='console.log("ready");';
    await writeFile(join(job.root,"work","main.mjs"),code);
    const output=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"cleanup failure",cwd:job.root,timeoutSeconds:3,inline:code});
    await rm(output.artifacts,{recursive:true});
    assert.equal((await finishInline(job,job.sessionId,output)).state,"cleanup_failed");
    assert(existsSync(job.root));
  });
});

test("workspace source views use the exact executed snapshot and never clean up successful development runs",async()=>{
  await fixture(async job=>{
    const code='console.log("executed snapshot");';
    const entry=join(job.root,"work","main.mjs");
    await writeFile(entry,code);
    let source:SourceView|undefined;
    const output=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"source view",cwd:job.root,timeoutSeconds:3,onSource:value=>{source=value;}});
    await writeFile(entry,'console.log("later edit");');
    assert.equal(source?.text,code);
    assert.equal(source?.path,join(output.run,"source","main.mjs"));
    assert(existsSync(entry));
    assert.equal((await inspectJob(job,job.sessionId)).state,"open");
  });
});

test("command events expose actual starts and exits, use stable identities, and bound persisted evidence",async()=>{
  const log=new CommandLog();
  log.append({id:"one",command:"git",args:["--version"],cwd:"/project",status:"running"});
  log.append({id:"one",command:"git",args:["--version"],cwd:"/project",status:"succeeded",exitCode:0});
  assert.equal(log.snapshot().length,1);
  assert.equal(log.snapshot()[0]?.status,"succeeded");
  log.append({id:"invalid",command:"ignored",args:[3],cwd:"/project",status:"running"});
  assert(log.truncated);
  for(let index=0;index<100;index++) log.append({id:String(index),command:"tool",args:[],cwd:"/project",status:"running"});
  assert(log.snapshot().length<=64);
  await fixture(async job=>{
    const code='const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec("git",["--version"],{timeoutSeconds:2});';
    await writeFile(join(job.root,"work","main.mjs"),code);
    const updates:Progress[]=[];
    const output=await executeJob(job,job.sessionId,"main.mjs",[],{purpose:"command events",cwd:job.root,timeoutSeconds:4,onProgress:value=>updates.push(value)});
    assert(updates.some(value=>value.commands?.some(command=>command.status==="running")));
    assert.equal(output.commands[0]?.status,"succeeded");
    assert.deepEqual(output.commands[0]?.args,["--version"]);
  });
});

test("private stable storage rejects substituted roots and preserves registered legacy jobs",async()=>{
  const jobs=await jobDirectory(true);
  assert.equal(jobs,join(storageRoot(),"jobs"));
  if(process.platform!=="win32") assert.equal((await lstat(testStorage)).mode & 0o777,0o700);
  await fixture(async job=>{
    assert.equal((await lstat(job.root)).mode & 0o077,0);
    const alias=`${testStorage}-link`;
    try{
      await symlink(testStorage,alias,process.platform==="win32"?"junction":"dir");
      process.env.PI_TEMP_SCRIPTS_DIR=alias;
      await assert.rejects(inspectJob(job,job.sessionId),/original directory/u);
    } finally {process.env.PI_TEMP_SCRIPTS_DIR=testStorage;await rm(alias,{force:true});}
  });
  const root=await mkdtemp(join(tmpdir(),"pi-managed-script-"));
  const legacy:JobManifest={format:1,id:"legacy-fixture",root,token:"owned-fixture",sessionId:"legacy-session",purpose:"No automatic migration",createdAt:0,state:"released",dependencies:{}};
  try{
    await writeFile(join(root,"manifest.json"),JSON.stringify(legacy));
    assert.equal((await inspectJob(legacy,legacy.sessionId)).root,root);
    await jobDirectory(true);
    assert(existsSync(root));
    assert(await cleanupJob(legacy,legacy.sessionId));
  }finally{await rm(root,{force:true,recursive:true});}
});

test("background start returns before completion, retains its lease, ignores later abort and stops explicitly",async()=>{
  await fixture(async job=>{
    const code='console.log(process.pid); setInterval(()=>console.log("tick"),100);';
    await writeFile(join(job.root,"work","main.mjs"),code);
    const controller=new AbortController();
    const start=Date.now();
    const running=await startBackground(job,job.sessionId,"main.mjs",[],"inline",{purpose:"service",cwd:job.root,timeoutSeconds:2,inline:code,signal:controller.signal},{startupSeconds:2,service:true});
    assert(Date.now()-start<2000);
    assert.equal(running.status,"running");
    assert(backgroundActive(job.sessionId));
    assert(existsSync(join(job.root,"lease")));
    controller.abort();
    await new Promise(accept=>setTimeout(accept,150));
    assert.equal((await backgroundStatus(job,job.sessionId))?.status,"running");
    await assert.rejects(releaseJob(job,job.sessionId),/lease/u);
    const stopped=await stopBackground(job,job.sessionId);
    assert.equal(stopped.status,"cancelled");
    assert(stopped.record?.terminationConfirmed);
    assert(!existsSync(join(job.root,"lease")));
    forgetBackground(job.id);
  });
});

test("foreground interruption stops waiting, preserves process ownership and allows explicit stop",async()=>{
  await fixture(async job=>{
    const code='console.log("FOREGROUND_ALIVE");setInterval(()=>{},1000);';
    await writeFile(join(job.root,"work","main.mjs"),code);
    const controller=new AbortController();
    let updates = 0;
    let sources = 0;
    const started=Promise.withResolvers<void>();
    const waiting=runForeground(job,job.sessionId,"main.mjs",[],"workspace",{purpose:"foreground",cwd:job.root,timeoutSeconds:5,signal:controller.signal,onProgress:()=>{updates++;started.resolve();},onSource:()=>{sources++;}});
    await started.promise;
    controller.abort();
    const detached=await waiting;
    assert(detached.background);
    const callbacksAtHandoff = { updates, sources };
    await new Promise(accept=>setTimeout(accept,150));
    assert.deepEqual({ updates, sources }, callbacksAtHandoff, "Old tool callbacks must detach after foreground handoff");
    assert(backgroundActive(job.sessionId));
    const stopped=await stopBackground(job,job.sessionId);
    assert.equal(stopped.status,"cancelled");
    forgetBackground(job.id);
  });
});

test("background startup validation and finite deadlines preserve failure records without orphan processes",async()=>{
  await fixture(async job=>{
    const code='setInterval(()=>{},1000);';
    await writeFile(join(job.root,"work","main.mjs"),code);
    const options={purpose:"validation",cwd:job.root,timeoutSeconds:1};
    await assert.rejects(startBackground(job,job.sessionId,"main.mjs",[],"workspace",options,{startupSeconds:1}),/requires runtimeSeconds/u);
    await assert.rejects(startBackground(job,job.sessionId,"main.mjs",[],"workspace",options,{startupSeconds:1,service:true,runtimeSeconds:2}),/requires runtimeSeconds/u);
    await assert.rejects(startBackground(job,job.sessionId,"main.mjs",[],"workspace",options,{startupSeconds:1,service:true,readyUrl:"https://example.com"}),/loopback/u);
    await startBackground(job,job.sessionId,"main.mjs",[],"workspace",options,{startupSeconds:1,runtimeSeconds:0.3});
    await new Promise(accept=>setTimeout(accept,500));
    const completed=await backgroundStatus(job,job.sessionId);
    assert.equal(completed?.status,"timed_out");
    assert(completed?.record?.terminationConfirmed);
    forgetBackground(job.id);
  });
});

test("loopback readiness is checked and failed startup stops the actual process",async()=>{
  const reservation=createServer();
  await new Promise<void>(accept=>reservation.listen(0,"127.0.0.1",accept));
  const address=reservation.address();
  assert(address && typeof address!=="string");
  const port=address.port;
  await new Promise<void>((accept,reject)=>reservation.close(error=>error?reject(error):accept()));
  await fixture(async job=>{
    const code=`import http from "node:http";http.createServer((request,response)=>{response.statusCode=request.url==="/not-ready"?503:200;response.end("fixture");}).listen(${port},"127.0.0.1");`;
    await writeFile(join(job.root,"work","main.mjs"),code);
    const details=await startBackground(job,job.sessionId,"main.mjs",[],"workspace",{purpose:"readiness",cwd:job.root,timeoutSeconds:2},{startupSeconds:2,service:true,readyUrl:`http://127.0.0.1:${port}/`});
    assert.equal(details.background?.readiness,"ready");
    await stopBackground(job,job.sessionId);
    forgetBackground(job.id);
    await assert.rejects(startBackground(job,job.sessionId,"main.mjs",[],"workspace",{purpose:"failed readiness",cwd:job.root,timeoutSeconds:1},{startupSeconds:0.2,service:true,readyUrl:`http://127.0.0.1:${port}/not-ready`}),/startup failed/u);
    assert(!backgroundActive(job.sessionId));
    assert(!existsSync(join(job.root,"lease")));
    forgetBackground(job.id);
  });
});

test("background exec accepts omitted options while foreground exec still requires a child deadline", async () => {
  await fixture(async job => {
    const child = 'console.log("DEFAULT_OPTIONS_CHILD");setInterval(()=>{},1000);';
    const code = `const {exec}=await import(process.env.PI_SCRIPT_RUNTIME);await exec(process.execPath,["-e",${JSON.stringify(child)}]);`;
    await writeFile(join(job.root, "work", "main.mjs"), code);
    await startBackground(job, job.sessionId, "main.mjs", [], "workspace", { purpose: "Default child options", cwd: job.root, timeoutSeconds: 2 }, { startupSeconds: 2, service: true });
    const deadline = Date.now() + 2000;
    while (!(await backgroundStatus(job, job.sessionId))?.output.includes("DEFAULT_OPTIONS_CHILD")) {
      assert(Date.now() < deadline, "The actual child command did not start");
      await new Promise(accept => setTimeout(accept, 20));
    }
    const stopped = await stopBackground(job, job.sessionId);
    assert.equal(stopped.status, "cancelled");
    assert(stopped.record?.terminationConfirmed);
    forgetBackground(job.id);
    const foreground = await executeJob(job, job.sessionId, "main.mjs", [], { purpose: "Required foreground deadline", cwd: job.root, timeoutSeconds: 2 });
    assert.equal(foreground.status, "failed");
    assert.match(foreground.output, /explicit positive deadline/u);
    assert(!foreground.output.includes("TypeError"));
  });
});
