// Measures what moving the token budget to Rust/WebAssembly costs per model
// call, against the TypeScript implementation it replaced. Runs in Node (same
// V8 engine as Workers): Workers freeze the clock during execution, so
// timing inside workerd would read 0. No model calls.
//
//   npm run build:wasm && npm run bench:budget

import { readdirSync, readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import { CONTEXT_BUDGET_TOKENS, SYSTEM_PROMPT } from "../src/config";
import { conversationSchema, fillerFor, fillerPoolSchema } from "../src/experiment/conversation";
import { createBudgetEngine } from "../src/memory/budget-wasm-glue";
import { messageTextLength } from "../src/memory/message-text";
import * as reference from "../test/reference/tokens-reference";

const bytes = readFileSync("src/memory/wasm/budget.wasm");

// One-time cost per isolate: compile (done by the platform at deploy time in
// Workers) and instantiate (done when the Worker first loads the module).
let t = performance.now();
const module = new WebAssembly.Module(bytes);
const compileMs = performance.now() - t;
t = performance.now();
const engine = createBudgetEngine(module);
const instantiateMs = performance.now() - t;

// Histories as the experiment builds them: the 20 main conversations at ×1,
// at the point of the last question (the longest history each one reaches).
const pool = fillerPoolSchema.parse(JSON.parse(readFileSync("data/filler.json", "utf8"))).pairs;
const histories: ModelMessage[][] = [];
for (const file of readdirSync("data/conversations").filter((f) => f.startsWith("main-"))) {
  const c = conversationSchema.parse(JSON.parse(readFileSync(`data/conversations/${file}`, "utf8")));
  const blocks = fillerFor(c, pool, 1);
  const h: ModelMessage[] = [];
  let b = 0;
  for (const step of c.steps) {
    if (step.kind === "filler") {
      for (const p of blocks[b++]) h.push({ role: "user", content: p.user }, { role: "assistant", content: [{ type: "text", text: p.assistant }] });
    } else {
      h.push({ role: "user", content: step.kind === "say" ? step.text : step.question });
      h.push({ role: "assistant", content: [{ type: "text", text: "Noted." }] });
    }
  }
  histories.push(h);
}

function wasmFit(messages: ModelMessage[]) {
  // What src/memory/tokens.ts fitToBudget does now.
  const fit = engine.fitToBudget(
    SYSTEM_PROMPT.length, messages.map(messageTextLength), messages.map((m) => m.role === "tool"), 0, CONTEXT_BUDGET_TOKENS
  );
  return messages.slice(fit.start);
}
function tsFit(messages: ModelMessage[]) {
  return reference.fitToBudget({ system: SYSTEM_PROMPT, messages, toolTokens: 0 }, CONTEXT_BUDGET_TOKENS).messages;
}

function time(label: string, fn: (m: ModelMessage[]) => unknown) {
  for (let i = 0; i < 200; i++) for (const h of histories) fn(h); // warm up the JIT
  const samples: number[] = [];
  for (let i = 0; i < 300; i++) {
    for (const h of histories) {
      const s = performance.now();
      fn(h);
      samples.push((performance.now() - s) * 1000);
    }
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.floor(p * (samples.length - 1))].toFixed(1);
  console.log(`${label.padEnd(26)} median ${q(0.5)} µs   p99 ${q(0.99)} µs   (${samples.length} calls)`);
}

const sizes = histories.map((h) => h.length);
console.log(`Module: ${bytes.length} bytes. Compile ${compileMs.toFixed(2)} ms, instantiate ${instantiateMs.toFixed(2)} ms (once per isolate).`);
console.log(`Histories: ${histories.length}, ${Math.min(...sizes)}–${Math.max(...sizes)} messages each.\n`);
time("TypeScript fitToBudget", tsFit);
time("Rust/WASM fitToBudget", wasmFit);
