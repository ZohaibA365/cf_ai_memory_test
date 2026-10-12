// The project's model cost log: one JSON line per (script run, model) in
// results/model-costs.jsonl, committed with the results. Every script that
// calls the model appends to it, including when it fails partway.

import { appendFileSync, mkdirSync } from "node:fs";
import type { CostMeter, CostRecord } from "./cost-meter";

export const COST_LOG = "results/model-costs.jsonl";

export function appendCostRecords(records: CostRecord[]) {
  if (records.length === 0) return;
  mkdirSync("results", { recursive: true });
  appendFileSync(COST_LOG, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Writes the meter's records and prints a one-line cost summary. */
export function logCost(meter: CostMeter, note?: string) {
  const records = meter.records(note);
  appendCostRecords(records);
  const neurons = records.reduce((s, r) => s + r.neurons, 0);
  const usd = records.reduce((s, r) => s + r.usd, 0);
  console.log(`Cost: ${neurons.toFixed(1)} neurons ($${usd.toFixed(4)}), logged to ${COST_LOG}`);
}
