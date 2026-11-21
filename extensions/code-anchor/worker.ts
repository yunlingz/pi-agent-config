import { parentPort, workerData } from "node:worker_threads";
import { applyWrites, discoverFiles, portablePath, resolveHostPath, supplyFile, type StagedEdit } from "./host-files.ts";
import { WasmEngine } from "./wasm-runtime.ts";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./core-types.ts";

// The parent supplies the packaged core path, never a project-selected module.
const data = workerData as { wasmPath: string };
const engine = await WasmEngine.load(data.wasmPath);
const port = parentPort;
if (!port) throw new Error("CodeAnchor worker requires a parent port");
let preview: { paths: string[]; cwd: string } | undefined;
let lockedAstPaths: string[] = [];
const cancelled = new Set<number>();
let completed = 0;

async function run(message: WorkerRequest): Promise<string> {
  const request = message.request;
  const beforeWrite = (): void => {
    if (cancelled.has(message.id)) throw new Error("CodeAnchor operation cancelled before writing");
  };
  beforeWrite();
  switch (request.action) {
    case "reset": engine.session({ action: "reset" }); preview = undefined; return "";
    case "read_target": return JSON.stringify(engine.session({ action: "read_target", path: request.path }));
    case "read": {
      let file = await supplyFile(request.path, process.cwd());
      let selector: string | null = null;
      let display = request.display;
      if (!file.exists) {
        const parsed = engine.session<{ path: string; selector: string | null }>({ action: "read_target", path: request.path });
        if (parsed.selector !== null) {
          file = await supplyFile(parsed.path, process.cwd());
          selector = parsed.selector;
          display = engine.session<{ path: string }>({ action: "read_target", path: request.display }).path;
        }
      }
      file.authored = display;
      return JSON.stringify(engine.session({ action: "read", file, selector, offset: request.offset ?? 1, limit: request.limit ?? (selector?.toLowerCase().includes("raw") ? 2000 : 300), summarize: request.offset === undefined && request.limit === undefined }));
    }
    case "inspect": {
      const paths = engine.session<string[]>({ action: "inspect", input: request.input, cwd: portablePath(request.cwd) });
      return JSON.stringify(await Promise.all(paths.map(path => resolveHostPath(path, request.cwd))));
    }
    case "apply": {
      const paths = engine.session<string[]>({ action: "inspect", input: request.input, cwd: portablePath(request.cwd) });
      const files = await Promise.all(paths.map(path => supplyFile(path, request.cwd, true)));
      if (request.lockedPaths && files.some(file => !request.lockedPaths?.some(path => portablePath(path) === file.path))) {
        throw new Error("An edit target changed while acquiring file locks; re-read and retry");
      }
      const plan = engine.session<StagedEdit>({ action: "stage", input: request.input, cwd: portablePath(await resolveHostPath(".", request.cwd)), home: portablePath(await resolveHostPath(request.home, request.cwd)), files });
      return JSON.stringify(await applyWrites(engine, plan, beforeWrite));
    }
    case "search": {
      const files = await discoverFiles(request.paths, request.cwd, engine, request.language);
      return JSON.stringify(engine.session({ action: "search", files, pattern: request.pattern, language: request.language, skip: request.skip }));
    }
    case "preview": {
      const files = await discoverFiles(request.paths, request.cwd, engine);
      const result = engine.session<{ files: object[] }>({ action: "preview", files, operations: request.operations });
      preview = result.files.length ? { paths: request.paths, cwd: request.cwd } : undefined;
      return JSON.stringify(result);
    }
    case "pending_paths": {
      if (!preview) throw new Error("No AST edit preview is pending");
      lockedAstPaths = (await discoverFiles(preview.paths, preview.cwd, engine)).map(file => file.path);
      return JSON.stringify(lockedAstPaths);
    }
    case "resolve": {
      if (!request.apply) { preview = undefined; return JSON.stringify({ text: engine.session<string>({ action: "reject" }), files: [] }); }
      if (!preview) throw new Error("No AST edit preview is pending");
      const files = await discoverFiles(preview.paths, preview.cwd, engine);
      if (files.some(file => !lockedAstPaths.includes(file.path))) throw new Error("AST targets changed while acquiring file locks; retry resolve");
      preview = undefined;
      const plan = engine.session<StagedEdit & { replacements: number }>({ action: "resolve", files });
      const result = await applyWrites(engine, plan, beforeWrite);
      if (result.isError) return JSON.stringify(result);
      return JSON.stringify({ ...result, text: `Applied ${plan.replacements} replacements in ${plan.files.length} files.\n${result.text}` });
    }
  }
}

// The core's session state and host write acknowledgements follow one request order.
let queue = Promise.resolve();
port.on("message", (message: WorkerMessage) => {
  if ("cancel" in message) { if (message.cancel > completed) cancelled.add(message.cancel); return; }
  queue = queue.then(async () => {
    try { port.postMessage({ id: message.id, ok: true, value: await run(message) } satisfies WorkerResponse); }
    catch (error) {
      port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : "Core operation failed", fatal: error instanceof WebAssembly.RuntimeError } satisfies WorkerResponse);
      if (error instanceof WebAssembly.RuntimeError) {
        // A trapped instance can retain interrupted allocator or session state. Discard its worker.
        setImmediate(() => { throw error; });
      }
    } finally { completed = message.id; cancelled.delete(message.id); }
  });
});
