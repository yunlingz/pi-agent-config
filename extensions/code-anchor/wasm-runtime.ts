import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";

interface CoreExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  code_anchor_alloc(length: number): number;
  code_anchor_free(pointer: number): void;
  code_anchor_execute(pointer: number): bigint;
  code_anchor_session(pointer: number): bigint;
}

type SessionResponse<T> = { ok: true; value: T } | { ok: false; error: string };

export class WasmEngine {
  private core: CoreExports;

  private constructor(core: CoreExports) { this.core = core; }

  static async load(path: string): Promise<WasmEngine> {
    const bytes = await readFile(path);
    if (bytes.subarray(0, 128).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      throw new Error("CodeAnchor contains an LFS pointer. Run git lfs pull to obtain the WASM artifact.");
    }
    const module = await WebAssembly.compile(bytes);
    const allowed = new Set(["monotonic_ms", "stream_write", "stream_close", "stream_dup"]);
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.module !== "code_anchor" || entry.kind !== "function" || !allowed.has(entry.name)) {
        throw new Error(`Unexpected CodeAnchor import: ${entry.module}.${entry.name}`);
      }
    }
    let memory: WebAssembly.Memory | undefined;
    const instance = await WebAssembly.instantiate(module, { code_anchor: {
      monotonic_ms: () => performance.now(),
      stream_write(descriptor: number, pointer: number, length: number): number {
        if (!memory || ![1, 2].includes(descriptor)) return -1;
        return writeSync(descriptor, new Uint8Array(memory.buffer, pointer, length));
      },
      // Standard streams belong to Node. The core cannot close them or open other descriptors.
      stream_close: () => -1,
      stream_dup: () => -1,
    } });
    // These exports are produced by our pinned Rust build, not arbitrary project WASM.
    const core = instance.exports as CoreExports;
    memory = core.memory;
    return new WasmEngine(core);
  }

  private exchange<T>(request: object, session: boolean): T {
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const pointer = this.core.code_anchor_alloc(bytes.length);
    new Uint8Array(this.core.memory.buffer, pointer, bytes.length).set(bytes);
    const packed = session ? this.core.code_anchor_session(pointer) : this.core.code_anchor_execute(pointer);
    const address = Number(packed >> 32n);
    const length = Number(packed & 0xffff_ffffn);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(this.core.memory.buffer, address, length));
      // Restore the owned Rust protocol type at its serialization boundary.
      return JSON.parse(text) as T;
    } finally { this.core.code_anchor_free(address); }
  }

  session<T>(request: object): T {
    const response = this.exchange<SessionResponse<T>>(request, true);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }

  compute<T>(request: object): T {
    const response = this.exchange<T | { kind: "error"; message: string }>(request, false);
    if (response !== null && typeof response === "object" && "kind" in response && response.kind === "error" && "message" in response && typeof response.message === "string") {
      throw new Error(response.message);
    }
    return response as T;
  }
}
