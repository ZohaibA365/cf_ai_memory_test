import { describe, expect, it } from "vitest";
import { CostMeter } from "../scripts/cost-meter";

describe("CostMeter", () => {
  it("totals calls and tokens per model and prices them", () => {
    const meter = new CostMeter("test-script");
    meter.add("@cf/qwen/qwen3-30b-a3b-fp8", { inputTokens: 600_000, outputTokens: 100_000 });
    meter.add("@cf/qwen/qwen3-30b-a3b-fp8", { inputTokens: 400_000, outputTokens: undefined });
    meter.add("@cf/openai/gpt-oss-20b", { inputTokens: 1_000_000, outputTokens: 0 });
    const [qwen, oss] = meter.records("note", "2026-10-12T00:00:00Z");
    // 1M input at 4,625/M plus 0.1M output at 30,475/M.
    expect(qwen).toMatchObject({
      script: "test-script", model: "@cf/qwen/qwen3-30b-a3b-fp8", calls: 2,
      inputTokens: 1_000_000, outputTokens: 100_000, neurons: 7672.5, basis: "measured", note: "note"
    });
    expect(oss.neurons).toBe(18182);
    expect(meter.totalNeurons()).toBeCloseTo(25854.5, 1);
  });

  it("produces no records when nothing was called", () => {
    expect(new CostMeter("idle").records()).toEqual([]);
  });
});
