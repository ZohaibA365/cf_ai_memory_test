// The bridge to the Rust token-budget module (rust/budget, compiled to
// WebAssembly by `npm run build:wasm`). Rust holds the counting rules and
// decides which messages fit; this file passes it each text's length and
// reads the result back. tokens.ts is the public API, and budget-wasm.ts
// creates the instance the Worker uses.
//
// Only lengths cross the boundary, not text. The estimate depends on nothing
// but a text's length in UTF-16 code units (JavaScript's `length`, stored
// with the string), so passing it is exact and costs nothing, while copying
// every message into WebAssembly memory as UTF-8 cost more than the whole
// TypeScript fit it replaced (see SUMMARY.md).
//
// Kept free of bundler-specific imports, so Node scripts (the benchmark) can
// use it with a module read from disk.

interface BudgetExports {
  memory: WebAssembly.Memory;
  budget_alloc(len: number): number;
  budget_free(ptr: number, len: number): void;
  budget_text_tokens(units: number): number;
  budget_message_tokens(units: number): number;
  budget_fit(
    systemUnits: number,
    lensPtr: number,
    flagsPtr: number,
    count: number,
    toolTokens: number,
    budget: number,
    outTokensPtr: number
  ): number;
}

export interface WasmFit {
  /** Index of the first kept message. */
  start: number;
  estimatedTokens: number;
}

// Every length is in UTF-16 code units: a JavaScript string's `length`.
export interface BudgetEngine {
  /** Estimated tokens for a text of this length: ceil(length / 4). */
  textTokens(length: number): number;
  /** Estimated tokens for a message text of this length, plus the per-message overhead. */
  messageTokens(length: number): number;
  /**
   * Which messages fit the budget, newest first, from the system prompt's
   * length and each message's text length; see fit_to_budget in
   * rust/budget/src/lib.rs.
   */
  fitToBudget(systemLength: number, lengths: number[], isToolResult: boolean[], toolTokens: number, budget: number): WasmFit;
  /** Calls made into the module (for tests). */
  readonly calls: number;
}

/**
 * Instantiates the module. It has no imports, so this is synchronous; the
 * Worker does it once per isolate.
 */
export function createBudgetEngine(module: WebAssembly.Module): BudgetEngine {
  const wasm = new WebAssembly.Instance(module, {}).exports as unknown as BudgetExports;
  let calls = 0;

  // One scratch buffer for the length and flag arrays, reused by every call
  // and grown when needed. Calls are synchronous, so nothing else can use it
  // in between.
  let scratch = 0;
  let scratchSize = 0;
  function reserve(size: number): number {
    if (size > scratchSize) {
      if (scratch) wasm.budget_free(scratch, scratchSize);
      const next = Math.max(size, scratchSize * 2, 4096);
      scratch = wasm.budget_alloc(next);
      if (!scratch) throw new Error(`budget wasm: could not allocate ${next} bytes`);
      scratchSize = next;
    }
    return scratch;
  }

  function fitToBudget(
    systemLength: number,
    lengths: number[],
    isToolResult: boolean[],
    toolTokens: number,
    budget: number
  ): WasmFit {
    calls++;
    const n = lengths.length;
    // Layout: [f64 result][u32 × n lengths][u8 × n flags]. The buffer is
    // 8-byte aligned, so the f64 and u32 slots are aligned too.
    const lensOffset = 8;
    const flagsOffset = lensOffset + 4 * n;
    const base = reserve(flagsOffset + n);
    // Views are made after reserve(): allocating can grow memory, which
    // detaches views of the old buffer. budget_fit allocates nothing.
    const lens = new Uint32Array(wasm.memory.buffer, base + lensOffset, n);
    const flags = new Uint8Array(wasm.memory.buffer, base + flagsOffset, n);
    for (let i = 0; i < n; i++) {
      lens[i] = lengths[i];
      flags[i] = isToolResult[i] ? 1 : 0;
    }
    const start = wasm.budget_fit(systemLength, base + lensOffset, base + flagsOffset, n, toolTokens, budget, base);
    return { start, estimatedTokens: new Float64Array(wasm.memory.buffer, base, 1)[0] };
  }

  return {
    textTokens(length) {
      calls++;
      return wasm.budget_text_tokens(length);
    },
    messageTokens(length) {
      calls++;
      return wasm.budget_message_tokens(length);
    },
    fitToBudget,
    get calls() {
      return calls;
    }
  };
}
