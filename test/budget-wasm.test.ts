import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { CONTEXT_BUDGET_TOKENS as B, SYSTEM_PROMPT } from "../src/config";
import { fillerFor } from "../src/experiment/conversation";
import { loadConversations, loadFillerPool } from "../src/experiment/data";
import type { MemoryAgent } from "../src/memory/agent";
import { budget } from "../src/memory/budget-wasm";
import { estimateMessageTokens, estimateTextTokens, fitToBudget, messageTextLength } from "../src/memory/tokens";
import { filler, scriptedModel, userMessage } from "./helpers";
import * as reference from "./reference/tokens-reference";

// The token budget runs in Rust (rust/budget) compiled to WebAssembly. These
// tests check that the Worker really calls it, and that it gives exactly the
// answers of the TypeScript code it replaced (test/reference), so the
// reported results still describe the code.

type Fit = ReturnType<typeof fitToBudget>;

/** Same result, and the same message objects, from both implementations. */
function expectSameFit(input: Parameters<typeof fitToBudget>[0], b: number, label: string) {
  const wasm: Fit = fitToBudget(input, b);
  const ts: Fit = reference.fitToBudget(input, b);
  expect(wasm.estimatedTokens, label).toBe(ts.estimatedTokens);
  expect(wasm.droppedMessages, label).toBe(ts.droppedMessages);
  expect(wasm.messages.length, label).toBe(ts.messages.length);
  wasm.messages.forEach((m, i) => expect(m, label).toBe(ts.messages[i]));
}

// ---- The Worker calls the WebAssembly module --------------------------------

/** What a model call received, measured with the reference (TypeScript) estimator. */
function referenceCallTokens(call: { prompt: { role: string; content: unknown }[]; tools?: unknown[] }): number {
  let total = 0;
  for (const m of call.prompt) {
    total += m.role === "system"
      ? reference.estimateTextTokens(String(m.content))
      : reference.estimateMessageTokens(m as ModelMessage);
  }
  for (const t of (call.tools ?? []) as { name?: string; description?: string; inputSchema?: unknown }[]) {
    total += reference.estimateTextTokens(`${t.name} ${t.description ?? ""} ${JSON.stringify(t.inputSchema)}`);
  }
  return total;
}

const designs = [
  { name: "cutoff", ns: () => env.CutoffAgent },
  { name: "builtin", ns: () => env.BuiltinAgent },
  { name: "search", ns: () => env.SearchAgent }
];

describe.each(designs)("Worker integration: $name", ({ name, ns }) => {
  it("enforces the budget through the WebAssembly module on every model call", async () => {
    const stub = await getAgentByName(ns(), `wasm-${name}`);
    const { calls, wasmCalls } = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel(
        name === "builtin"
          ? [{ toolCall: { toolName: "set_context", input: { label: "memory", content: "Dog: Biscuit" } } }, { text: "Noted!" }]
          : []
      );
      agent.modelOverride = model;
      await agent.addMessages(filler(120));
      const before = budget.calls;
      const result = await agent.saveMessages([userMessage("My dog is called Biscuit. What do you think about dogs?")]);
      expect(result.status).toBe("completed");
      return {
        calls: model.doStreamCalls.map((c) => referenceCallTokens(c as never)),
        wasmCalls: budget.calls - before
      };
    });
    // The budget step ran in WebAssembly for this turn...
    expect(wasmCalls).toBeGreaterThan(0);
    // ...and, measured independently with the old TypeScript estimator, every
    // model call stayed within the budget while using most of it.
    expect(calls.length).toBeGreaterThan(0);
    for (const tokens of calls) expect(tokens).toBeLessThanOrEqual(B);
    expect(calls[0]).toBeGreaterThan(B * 0.8);
  });
});

describe("public token functions", () => {
  it("go through the WebAssembly module", () => {
    const before = budget.calls;
    estimateTextTokens("hello");
    estimateMessageTokens({ role: "user", content: "hello" });
    fitToBudget({ system: "s", messages: [{ role: "user", content: "hi" }], toolTokens: 0 }, B);
    expect(budget.calls - before).toBe(3);
  });
});

// ---- Same answers as the TypeScript implementation ---------------------------

/** Small deterministic PRNG (mulberry32), so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces chosen to hit every UTF-8 width and the JavaScript-specific cases.
const PIECES = [
  "a", "word ", "The quick brown fox. ", "\n", "  ", "1,234", "{\"k\":\"v\"}",
  "é", "Zoë", "ß", "ñ", "東京", "日本語", "한국어", "Ελληνικά", "עברית",
  "😀", "👍🏽", "👨‍👩‍👧", "🇨🇦", "é", "​", "﻿",
  "\ud800", "\udc00", "x\ud83dy", "\u{10ffff}", "\u0000", "\t"
];

function randomText(r: () => number, maxPieces: number): string {
  let s = "";
  const n = Math.floor(r() * maxPieces);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

function randomMessage(r: () => number): ModelMessage {
  const kind = r();
  if (kind < 0.35) return { role: "user", content: randomText(r, 40) };
  if (kind < 0.6) return { role: "assistant", content: [{ type: "text", text: randomText(r, 40) }] };
  if (kind < 0.75) {
    return {
      role: "assistant",
      content: [
        { type: "reasoning", text: randomText(r, 10) },
        { type: "tool-call", toolCallId: "c", toolName: "set_context", input: { label: "memory", content: randomText(r, 20) } }
      ]
    };
  }
  if (kind < 0.9) {
    return {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c", toolName: "set_context", output: { type: "text", value: randomText(r, 8) } }]
    };
  }
  return { role: "system", content: randomText(r, 20) };
}

const ODD_BUDGETS = [0, 1, 3, 9.5, -5, 2000, 2000.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe("equivalence with the TypeScript implementation: random input", () => {
  it("measures message text length without building the text", () => {
    const r = rng(4);
    const odd = [
      { role: "assistant", content: [] },
      { role: "assistant", content: [null, { type: "text", text: "a" }, undefined] },
      { role: "user", content: [{ type: "image", image: "x" }] },
      { role: "assistant", content: [{ type: "text" }] }
    ] as unknown as ModelMessage[];
    for (const m of [...odd, ...Array.from({ length: 3000 }, () => randomMessage(r))]) {
      expect(messageTextLength(m), JSON.stringify(m)).toBe(reference.messageText(m).length);
    }
  });

  it("estimates text and message tokens identically", () => {
    const r = rng(1);
    for (let i = 0; i < 3000; i++) {
      const text = randomText(r, 60);
      expect(estimateTextTokens(text), JSON.stringify(text)).toBe(reference.estimateTextTokens(text));
      const m = randomMessage(r);
      expect(estimateMessageTokens(m), JSON.stringify(m)).toBe(reference.estimateMessageTokens(m));
    }
  }, 60_000);

  it("fits identically, including fractional, negative and non-finite budgets", () => {
    const r = rng(2);
    for (let i = 0; i < 1500; i++) {
      const messages = Array.from({ length: Math.floor(r() * 60) }, () => randomMessage(r));
      const system = randomText(r, 80);
      const toolTokens = r() < 0.5 ? 0 : Math.round(r() * 200 * 4) / 4;
      const total = reference.estimateTextTokens(system) + toolTokens + reference.estimateMessagesTokens(messages);
      // Budgets around the interesting range (often the exact tipping point) plus odd values.
      const budgets = [Math.round(r() * total), Math.floor(total / 2), total, total - 1, ...ODD_BUDGETS];
      for (const b of budgets) expectSameFit({ system, messages, toolTokens }, b, `case ${i}, budget ${b}`);
    }
  }, 60_000);

  it("handles a very large history (the scratch buffer grows)", () => {
    const r = rng(3);
    const messages = Array.from({ length: 5000 }, () => randomMessage(r));
    const system = "s".repeat(200_000);
    for (const b of [B, 50_000, 1e9]) expectSameFit({ system, messages, toolTokens: 37 }, b, `budget ${b}`);
  }, 60_000);
});

describe("equivalence with the TypeScript implementation: the real test conversations", () => {
  // Rebuilds each conversation the way the experiment plays it (facts, small
  // talk from the committed pool at both lengths, questions) and compares the
  // two implementations at every point where the model is called, with each
  // design's kind of system prompt. Replies are stand-ins; the fit only depends
  // on lengths and roles, and these are realistic ones.
  const conversations = loadConversations();
  const pool = loadFillerPool();
  const toolTokens = reference.estimateTextTokens(
    'set_context Save or replace a context block. {"type":"object","properties":{"label":{"type":"string"},"content":{"type":"string"}}}'
  );

  it.each([0.5, 1])("at ×%s", (scale) => {
    let compared = 0;
    for (const c of conversations) {
      const blocks = fillerFor(c, pool, scale);
      const history: ModelMessage[] = [];
      const said: string[] = [];
      let block = 0;
      for (const step of c.steps) {
        if (step.kind === "filler") {
          for (const pair of blocks[block++]) {
            history.push({ role: "user", content: pair.user }, { role: "assistant", content: [{ type: "text", text: pair.assistant }] });
          }
          continue;
        }
        const text = step.kind === "say" ? step.text : step.question;
        if (step.kind === "say") said.push(step.text);
        history.push({ role: "user", content: text });
        const systems = [
          SYSTEM_PROMPT,
          `${SYSTEM_PROMPT}\n\nMEMORY:\n${said.join("\n")}`,
          `${SYSTEM_PROMPT}\n\nRelevant earlier messages:\n${said.slice(-3).map((s, i) => `[${i}] user: ${s}`).join("\n")}`
        ];
        for (const [i, system] of systems.entries()) {
          expectSameFit({ system, messages: history, toolTokens: i === 1 ? toolTokens : 0 }, B, `${c.id} ×${scale} ${step.id}`);
          compared++;
        }
        history.push({ role: "assistant", content: [{ type: "text", text: `Noted: ${text}` }] });
      }
    }
    expect(compared).toBeGreaterThan(conversations.length * 3 * 10);
  }, 60_000);
});
