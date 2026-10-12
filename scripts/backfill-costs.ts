// One-off: records model costs from before the cost log existed
// (2026-10-12), using only figures that were actually observed. Run once.
import { readFileSync } from "node:fs";
import { MODEL_ID } from "../src/config";
import { neurons, neuronsToUsd, PRICING_DATE } from "../src/pricing";
import { appendCostRecords } from "./cost-log";
import type { CostRecord } from "./cost-meter";

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

function record(r: Omit<CostRecord, "neurons" | "usd" | "pricingDate"> & { neurons?: number }): CostRecord {
  const n = r.neurons ?? neurons(r.model, r.inputTokens, r.outputTokens);
  return { ...r, neurons: round(n, 1), usd: round(neuronsToUsd(n), 6), pricingDate: PRICING_DATE };
}

const smoke = JSON.parse(readFileSync("results/model-smoke.json", "utf8")) as {
  ranAt: string;
  summaries: { model: string; trials: number; inputTokens: number; outputTokens: number }[];
};

const records: CostRecord[] = [
  // 3-trial smoke run: model-reported tokens saved in results/model-smoke.json.
  ...smoke.summaries.map((s) =>
    record({
      script: "model-smoke", ranAt: smoke.ranAt, model: s.model, calls: s.trials,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens, basis: "measured",
      note: "backfilled from results/model-smoke.json (3 trials per case)"
    })
  ),
  // Earlier 1-trial smoke run: only per-model neurons were printed.
  ...([
    ["@cf/qwen/qwen3-30b-a3b-fp8", 72], ["@cf/openai/gpt-oss-20b", 115],
    ["@cf/meta/llama-4-scout-17b-16e-instruct", 74], ["@cf/mistralai/mistral-small-3.1-24b-instruct", 262],
    ["@cf/openai/gpt-oss-120b", 170], ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", 237]
  ] as const).map(([model, n]) =>
    record({
      script: "model-smoke", ranAt: "2026-10-12", model, calls: 5, inputTokens: 0, outputTokens: 0,
      neurons: n, basis: "measured", note: "backfilled 1-trial run: neurons from console output, token counts not kept"
    })
  ),
  // First stage 1 live check of the deployed agents: usage from /inspect.
  record({
    script: "live-check (stage 1)", ranAt: "2026-10-12", model: MODEL_ID, calls: 7,
    inputTokens: 276 + 1838 + 335, outputTokens: 242 + 436 + 353, basis: "measured",
    note: "backfilled from the agents' /inspect usage; the second stage 1 check and the stage 0 checks were not recorded"
  })
];

appendCostRecords(records);
console.log(`Backfilled ${records.length} records, ${round(records.reduce((s, r) => s + r.neurons, 0), 1)} neurons`);
