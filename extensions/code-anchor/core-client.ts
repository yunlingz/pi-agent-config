import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { NativeRequest, WorkerRequest, WorkerResponse } from "./core-types.ts";

const root = dirname(fileURLToPath(import.meta.url));

export async function addonPath(): Promise<string> {
  const path = join(root, "wasm", "code_anchor_core.wasm");
  let file;
  try { file = await open(path, "r"); }
  catch { throw new Error(`Missing packaged CodeAnchor core: ${path}. Obtain the WASM artifact with Git LFS.`); }
  try {
    const header = Buffer.alloc(128);
    await file.read(header, 0, header.length, 0);
    if (header.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      throw new Error("CodeAnchor contains an LFS pointer, not a WASM module. Run git lfs pull before starting Pi.");
    }
  } finally { await file.close(); }
  return path;
}

interface Pending {
  accept(value: string): void;
  reject(error: Error): void;
}

export class NativeClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private path: string;

  constructor(path: string) { this.path = path; }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { wasmPath: this.path }, execArgv: [] });
    this.worker = worker;
    worker.on("message", (response: WorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.accept(response.value);
      else {
        const error = new Error(response.error);
        if (response.fatal) {
          fail(error);
          void worker.terminate();
        }
        pending.reject(error);
      }
    });
    const fail = (error: Error): void => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", code => fail(new Error(`CodeAnchor worker exited (${code}); re-read files before editing`)));
    return worker;
  }

  request(request: NativeRequest, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const worker = this.start();
    const id = ++this.sequence;
    return new Promise<string>((accept, reject) => {
      const cancel = (): void => {
        // Mutation cancellation is cooperative before the first write, never a worker termination midway.
        if (request.action === "apply" || request.action === "resolve") {
          worker.postMessage({ cancel: id });
          return;
        }
        void this.close(new Error("CodeAnchor operation cancelled; re-read files before editing"));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", cancel);
      this.pending.set(id, {
        accept(value) { cleanup(); accept(value); },
        reject(error) { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try { worker.postMessage({ id, request } satisfies WorkerRequest); }
      catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error("Cannot send a CodeAnchor request"));
      }
    });
  }

  async close(reason = new Error("CodeAnchor session ended")): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
