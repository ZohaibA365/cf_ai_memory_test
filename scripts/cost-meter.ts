// Tracks model usage for one script run and turns it into neurons and
// dollars. Kept free of Node imports so it can be unit tested; scripts write
// the record with appendCostRecord (scripts/cost-log.ts).

import { neurons, neuronsToUsd, PRICING_DATE } from "../src/pricing";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CostRecord {
  script: string;
  ranAt: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  neurons: number;
  usd: number;
  pricingDate: string;
  /** "measured": from model-reported usage. "estimated": reconstructed. */
  basis: "measured" | "estimated";
  note?: string;
}

export class CostMeter {
  #byModel = new Map<string, { calls: number; input: number; output: number }>();

  constructor(readonly script: string) {}

  add(model: string, usage: Usage) {
    const row = this.#byModel.get(model) ?? { calls: 0, input: 0, output: 0 };
    row.calls += 1;
    row.input += usage.inputTokens ?? 0;
    row.output += usage.outputTokens ?? 0;
    this.#byModel.set(model, row);
  }

  /** One record per model used, ready to append to the cost log. */
  records(note?: string, ranAt = new Date().toISOString()): CostRecord[] {
    return [...this.#byModel].map(([model, r]) => {
      const n = neurons(model, r.input, r.output);
      return {
        script: this.script,
        ranAt,
        model,
        calls: r.calls,
        inputTokens: r.input,
        outputTokens: r.output,
        neurons: Math.round(n * 10) / 10,
        usd: Math.round(neuronsToUsd(n) * 1e6) / 1e6,
        pricingDate: PRICING_DATE,
        basis: "measured",
        ...(note ? { note } : {})
      };
    });
  }

  totalNeurons(): number {
    return this.records().reduce((sum, r) => sum + r.neurons, 0);
  }
}
