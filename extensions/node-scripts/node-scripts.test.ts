import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "./config.ts";
import { Workspace, sessionWorkspace } from "./workspace.ts";
import { jobActivity, listJobs, panelJobs, type JobView } from "./types.ts";
import { dependencies } from "./npm.ts";

async function fixture(action: (store: Workspace, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "node-scripts-unit-")));
  const store = await Workspace.create({ rootFolder: root, npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" }, randomUUID());
  try { await action(store, root); }
  finally { await store.shutdown(); assert.equal(store.active, 0); await rm(root, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(root)); }
}
function until(store: Workspace, predicate: () => boolean, label: string) {
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<void>((accept, reject) => {
    const check = () => { if (predicate()) { clearTimeout(timer); stop(); accept(); } };
    timer = setTimeout(() => { stop(); reject(new Error(label)); }, 7000);
    stop = store.subscribe(check); check();
  });
}

test("configuration defaults and URL/path validation stay small and fail closed", () => {
  assert(parseConfig({}).rootFolder.endsWith(".pi-node-scripts"));
  assert.equal(parseConfig({}).npmRegistry, "https://packagefeedproxy.microsoft.io/npm/");
  for (const value of [null, [], { rootFolder: "relative" }, { unexpected: 1 }, { npmRegistry: "http://registry.test" }, { npmRegistry: "https://user:secret@registry.test" }]) assert.throws(() => parseConfig(value));
});

test("an idle session can select a new root, but an active workspace cannot", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "node-scripts-root-")));
  const config = { rootFolder: join(root, "original"), npmRegistry: "https://packagefeedproxy.microsoft.io/npm/" };
  const id = randomUUID();
  let current = await sessionWorkspace(config, id);
  try {
    const changed = { ...config, rootFolder: join(root, "new-root") };
    current = await sessionWorkspace(changed, id);
    assert.equal(current.root, join(changed.rootFolder, id));
    await writeFile(join(current.root, "scripts", "service.mjs"), 'setInterval(()=>{},1000);');
    const job = await current.createJob({ scriptPath: "scripts/service.mjs" });
    await current.run(job.id);
    await assert.rejects(sessionWorkspace({ ...config, rootFolder: join(root, "third-root") }, id), /while work is running/u);
  } finally { await current.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("one workspace persists source, definitions, arguments, full logs and single-use state", async () => {
  await fixture(async store => {
    const path = join(store.root, "scripts", "main.mjs");
    await writeFile(path, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),node:process.execPath,marker:process.env.NODE_SCRIPTS_TEST_MARKER}));console.error("stderr evidence");');
    const previous = process.env.NODE_SCRIPTS_TEST_MARKER;
    process.env.NODE_SCRIPTS_TEST_MARKER = "inherited";
    try {
      const created = await store.createJob({ scriptPath: "scripts/main.mjs", args: ["literal $ ; space", "42"], timeoutSeconds: 5, name: "Evidence" });
      assert.equal(created.status, "created");
      const output = await store.run(created.id);
      assert.equal(output.status, "finished", output.stderr);
      assert(output.terminationConfirmed);
      const data = JSON.parse(output.stdout) as { args: string[]; cwd: string; node: string; marker: string };
      assert.deepEqual(data, { args: ["literal $ ; space", "42"], cwd: store.root, node: process.execPath, marker: "inherited" });
      assert(output.stderr.includes("stderr evidence"));
      await assert.rejects(store.run(created.id), /only once/u);
      const reopened = await Workspace.create({ rootFolder: join(store.root, ".."), npmRegistry: store.registry }, store.sessionId);
      assert.equal((await reopened.query(created.id)).status, "finished");
      const deprecated = await store.deprecate(created.id);
      assert.equal(deprecated.previousStatus, "finished");
      assert.equal(store.list("finished", 10).total, 0);
      assert.equal(store.list("deprecated", 10).total, 1);
      assert(existsSync(path) && existsSync(output.stdoutPath));
    } finally { if (previous === undefined) delete process.env.NODE_SCRIPTS_TEST_MARKER; else process.env.NODE_SCRIPTS_TEST_MARKER = previous; }
  });
});

test("workspace .mjs entries use ESM and other entry extensions reject", async () => {
  await fixture(async store => {
    await writeFile(join(store.root, "scripts", "value.mjs"), 'export const value = await Promise.resolve(42);');
    await writeFile(join(store.root, "scripts", "esm.mjs"), 'import {value} from "./value.mjs";if(typeof require!=="undefined")throw new Error("CommonJS");console.log(value,import.meta.url);');
    const job = await store.createJob({ scriptPath: "scripts/esm.mjs", timeoutSeconds: 5 });
    const esm = await store.run(job.id);
    assert.equal(esm.status, "finished", esm.stderr);
    assert(esm.stdout.startsWith("42 file:"));
    for (const extension of ["js", "cjs", "ts"]) {
      await writeFile(join(store.root, "scripts", `wrong.${extension}`), 'console.log(42);');
      await assert.rejects(store.createJob({ scriptPath: `scripts/wrong.${extension}` }), /\.mjs file/u);
    }
    const pending = await store.createJob({ scriptPath: "scripts/esm.mjs", timeoutSeconds: 5 });
    await writeFile(join(store.root, "package.json"), '{"private":true,"type":"commonjs"}');
    const output = await store.run(pending.id);
    assert.equal(output.status, "failed");
    assert.match(output.error ?? "", /ESM/u);
    await assert.rejects(Workspace.create({ rootFolder: join(store.root, ".."), npmRegistry: store.registry }, store.sessionId), /ESM/u);
  });
});

test("background work returns at startup, survives same-process reload, and deprecates without deleting evidence", async () => {
  await fixture(async store => {
    const path = join(store.root, "scripts", "service.mjs");
    await writeFile(path, 'console.log(process.pid);setInterval(()=>console.log("tick"),100);');
    const job = await store.createJob({ scriptPath: "scripts/service.mjs" });
    const running = await store.run(job.id);
    assert.equal(running.status, "started"); assert(running.active);
    await until(store, () => Boolean(store.jobs.get(job.id)?.lastOutputLine), "Background output did not arrive");
    const cached = await sessionWorkspace({ rootFolder: join(store.root, ".."), npmRegistry: store.registry }, store.sessionId);
    const reloaded = await sessionWorkspace({ rootFolder: join(store.root, ".."), npmRegistry: store.registry }, store.sessionId);
    assert.equal(cached, reloaded);
    await store.interruptTimed(); assert.equal(store.active, 1);
    const record = await store.query(job.id);
    const pid = Number(record.stdout.split("\n")[0]); assert(Number.isInteger(pid) && pid > 0);
    const stopped = await store.deprecate(job.id);
    assert.equal(stopped.status, "deprecated"); assert(stopped.terminationConfirmed);
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    assert(existsSync(stopped.stdoutPath));
    assert.equal((await store.deprecate(job.id)).status, "deprecated");
  });
});

test("timed interruption and deadlines terminate actual owned process trees", async () => {
  await fixture(async store => {
    const child = 'console.log("CHILD",process.pid);setInterval(()=>{},1000);';
    await writeFile(join(store.root, "scripts", "tree.mjs"), `import {spawn} from "node:child_process";spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:["ignore","inherit","inherit"]});console.log("PARENT",process.pid);setInterval(()=>{},1000);`);
    const timed = await store.createJob({ scriptPath: "scripts/tree.mjs", timeoutSeconds: 10 });
    const controller = new AbortController();
    const execution = store.run(timed.id, controller.signal);
    await until(store, () => store.jobs.get(timed.id)?.lastOutputLine?.includes("CHILD") === true, "Child not observed");
    controller.abort();
    const stopped = await execution;
    assert.equal(stopped.status, "deprecated"); assert(stopped.terminationConfirmed);
    for (const match of stopped.stdout.matchAll(/(?:CHILD|PARENT) (\d+)/gu)) assert.throws(() => process.kill(Number(match[1]), 0), /ESRCH/u);
    const deadline = await store.createJob({ scriptPath: "scripts/tree.mjs", timeoutSeconds: 0.4 });
    const output = await store.run(deadline.id);
    assert.equal(output.status, "timeout"); assert(output.terminationConfirmed);
    assert(output.endedAt && output.startedAt && output.endedAt - output.startedAt < 7000);
  });
});

test("definition validation, missing scripts, links and launch races preserve single-use semantics", async () => {
  await fixture(async (store, root) => {
    await writeFile(join(store.root, "scripts", "main.mjs"), 'console.log("ok");');
    for (const timeoutSeconds of [0, -1, Infinity, NaN]) await assert.rejects(store.createJob({ scriptPath: "scripts/main.mjs", timeoutSeconds }));
    await assert.rejects(store.createJob({ scriptPath: "../outside.mjs" }));
    const external = join(root, "external.mjs"); await writeFile(external, 'console.log("outside");');
    await symlink(external, join(store.root, "scripts", "link.mjs"));
    await assert.rejects(store.createJob({ scriptPath: "scripts/link.mjs" }), /regular/u);
    const job = await store.createJob({ scriptPath: "scripts/main.mjs", timeoutSeconds: 5 });
    const run = store.run(job.id);
    await assert.rejects(store.run(job.id), /only once/u);
    await run;
    const pending = await store.createJob({ scriptPath: "scripts/main.mjs", timeoutSeconds: 5 });
    const launching = store.run(pending.id);
    await store.deprecate(pending.id);
    assert.equal((await launching).status, "deprecated");
    const missing = await store.createJob({ scriptPath: "scripts/main.mjs", timeoutSeconds: 5 });
    await rm(join(store.root, "scripts", "main.mjs"));
    assert.equal((await store.run(missing.id)).status, "failed");
    await assert.rejects(store.run(missing.id), /only once/u);
    await assert.rejects(store.query("1234"), /complete/u);
  });
});

test("exact-status lists share recency with a combined running-first panel", () => {
  const make = (id: string, active: boolean, lastOutputAt?: number): JobView => ({ format: 1, id, name: id, scriptPath: "scripts/main.mjs", args: [], status: active ? "started" : "finished", active, createdAt: 1, startedAt: 2, lastOutputAt, workspace: "root", stdoutPath: "stdout", stderrPath: "stderr" });
  const quiet = { ...make("quiet", true), startedAt: 40 };
  const data = [quiet, make("new-output", false, 100), make("timed", true, 20), make("background", true, 30)];
  assert.deepEqual(listJobs(data, "started", 2).jobs.map(job => job.id), ["quiet", "background"]);
  assert.equal(listJobs(data, "started", 2).total, 3);
  assert.equal(listJobs(data, "started", 2).hasMore, true);
  assert.deepEqual(jobActivity(quiet), { at: 40, source: "started" });
  assert.deepEqual(panelJobs(data).jobs.map(job => job.id), ["quiet", "background", "timed", "new-output"]);
  for (let i = 0; i < 12; i++) data.push({ ...make(`pending-${i}`, false), status: "created", createdAt: 200 + i, startedAt: undefined });
  assert(panelJobs(data).jobs.includes(quiet), "New pending/history jobs must not hide quiet running jobs");
  assert.equal(panelJobs(data).jobs.length, 8);
  assert.equal(panelJobs(data).hiddenRunning, 0);
  const crowded = Array.from({ length: 11 }, (_, i) => make(`active-${i}`, true, i));
  assert.equal(panelJobs(crowded).hiddenRunning, 3);
  assert.equal(panelJobs(crowded, true).jobs.length, 11);
  data.push({ ...make("hidden", false), status: "deprecated" });
  assert.equal(listJobs(data, "deprecated", 10).total, 1);
  assert(!panelJobs(data).all.some(job => job.id === "hidden"));
});

test("saved started records without owned controllers are unconfirmed and never use persisted PIDs", async () => {
  await fixture(async store => {
    await writeFile(join(store.root, "scripts", "main.mjs"), 'setInterval(()=>{},1000);');
    const job = await store.createJob({ scriptPath: "scripts/main.mjs" });
    await store.run(job.id);
    const reopened = await Workspace.create({ rootFolder: join(store.root, ".."), npmRegistry: store.registry }, store.sessionId);
    assert.equal((await reopened.query(job.id)).status, "unconfirmed");
    await assert.rejects(reopened.deprecate(job.id), /no saved PID/u);
    assert.equal((await store.query(job.id)).status, "started");
  });
});

test("query output is bounded while full stdout and stderr stay on disk", async () => {
  await fixture(async store => {
    await writeFile(join(store.root, "scripts", "large.mjs"), 'process.stdout.write("x".repeat(100000));console.error("ERROR_END");');
    const job = await store.createJob({ scriptPath: "scripts/large.mjs", timeoutSeconds: 5 });
    const output = await store.run(job.id);
    assert.equal(output.status, "finished"); assert(output.outputTruncated);
    assert(Buffer.byteLength(output.stdout) <= 24 * 1024);
    assert.equal((await readFile(output.stdoutPath)).length, 100000);
  });
});

test("latest output joins split chunks and blank output does not reorder jobs", async () => {
  await fixture(async store => {
    await writeFile(join(store.root, "scripts", "chunks.mjs"), 'process.stdout.write("FIRST_");await new Promise(r=>setTimeout(r,300));process.stdout.write("SECOND\\n");await new Promise(r=>setTimeout(r,300));process.stdout.write(" \\n\\n");');
    const job = await store.createJob({ scriptPath: "scripts/chunks.mjs", timeoutSeconds: 5 });
    const output = await store.run(job.id);
    assert.equal(output.lastOutputLine, "FIRST_SECOND");
    assert(output.lastOutputAt && output.endedAt && output.endedAt - output.lastOutputAt >= 250);
    const before = jobActivity(output);
    await store.query(job.id);
    store.list("finished", 10);
    assert.deepEqual(jobActivity(await store.query(job.id)), before);
  });
});

test("dependency operations reject unsafe specs and active workspace mutation before running npm", async () => {
  await fixture(async store => {
    for (const version of ["latest", "^1.0.0", "file:../project", "https://example.test/x.tgz"]) await assert.rejects(dependencies(store, "add", "example", version), /exact/u);
    await assert.rejects(dependencies(store, "add", "../project", "1.0.0"), /package name/u);
    await writeFile(join(store.root, "scripts", "service.mjs"), 'setInterval(()=>{},1000);');
    const job = await store.createJob({ scriptPath: "scripts/service.mjs" }); await store.run(job.id);
    await assert.rejects(dependencies(store, "add", "is-number", "7.0.0"), /running/u);
  });
});
