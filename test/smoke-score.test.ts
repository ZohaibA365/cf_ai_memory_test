import { describe, expect, it } from "vitest";
import { isReliable, summarize, trialPassed, type TrialResult } from "../scripts/smoke-score";
import { neurons, neuronsToUsd } from "../src/pricing";

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    model: "m",
    caseId: "pet",
    trial: 0,
    toolCalls: [],
    text: "Got it!",
    error: null,
    latencyMs: 100,
    inputTokens: 1000,
    outputTokens: 50,
    ...over
  };
}

const saved = (content: string, label = "memory") => [
  { toolName: "set_context", input: { label, content } }
];

describe("trialPassed", () => {
  it("passes when the fact is saved to the memory block", () => {
    expect(trialPassed(trial({ toolCalls: saved("Dog: Biscuit") }), "biscuit")).toBe(true);
  });

  it("fails without a save, with the wrong fact, block, or tool, or on error", () => {
    expect(trialPassed(trial({}), "biscuit")).toBe(false);
    expect(trialPassed(trial({ toolCalls: saved("Cat: Tom") }), "biscuit")).toBe(false);
    expect(trialPassed(trial({ toolCalls: saved("Biscuit", "notes") }), "biscuit")).toBe(false);
    expect(
      trialPassed(trial({ toolCalls: [{ toolName: "write", input: { content: "Biscuit" } }] }), "biscuit")
    ).toBe(false);
    expect(trialPassed(trial({ toolCalls: saved("Biscuit"), error: "boom" }), "biscuit")).toBe(false);
  });
});

describe("summarize and isReliable", () => {
  const cases = [{ id: "pet", message: "", expect: "biscuit" }];

  it("needs 90% saved and no errors", () => {
    const good = Array.from({ length: 10 }, (_, i) =>
      trial({ trial: i, toolCalls: i < 9 ? saved("Biscuit") : [] })
    );
    const s = summarize("m", good, cases);
    expect(s.passRate).toBe(0.9);
    expect(isReliable(s)).toBe(true);

    const withError = [...good.slice(0, 9), trial({ error: "rate limited" })];
    expect(isReliable(summarize("m", withError, cases))).toBe(false);
  });

  it("totals tokens and takes the median latency", () => {
    const s = summarize("m", [trial({ latencyMs: 100 }), trial({ latencyMs: 300 }), trial({ latencyMs: 200 })], cases);
    expect(s.medianLatencyMs).toBe(200);
    expect(s.inputTokens).toBe(3000);
  });
});

describe("pricing", () => {
  it("converts tokens to neurons and dollars", () => {
    // 1M input tokens on Qwen3-30B is 4,625 neurons, about $0.05.
    expect(neurons("@cf/qwen/qwen3-30b-a3b-fp8", 1_000_000, 0)).toBe(4625);
    expect(neuronsToUsd(4625)).toBeCloseTo(0.0509, 4);
  });

  it("refuses to guess a price for an unknown model", () => {
    expect(() => neurons("@cf/unknown", 1, 1)).toThrow(/No price/);
  });
});
