// Progress and headline numbers for an experiment, read from D1. When every
// run has finished, the experiment's model cost (turns + compaction) is
// appended to results/model-costs.jsonl, once.
//
//   npm run experiment:status -- pilot-1

import { readFileSync } from "node:fs";
import { MODEL_ID } from "../src/config";
import { neurons, neuronsToUsd, PRICING_DATE } from "../src/pricing";
import { appendCostRecords, COST_LOG } from "./cost-log";
import { query, sqlString } from "./d1";

const experimentId = process.argv[2];
if (!experimentId) {
  console.error("Usage: npm run experiment:status -- <experiment id>");
  process.exit(1);
}
const exp = sqlString(experimentId);

let manifest: string[] = [];
try {
  manifest = (JSON.parse(readFileSync(`results/experiments/${experimentId}.json`, "utf8")) as { runs: string[] }).runs;
} catch {
  console.log(`No manifest at results/experiments/${experimentId}.json; cannot check for missing runs.`);
}
const recorded = new Set(
  query<{ id: string }>(`SELECT id FROM runs WHERE experiment_id = ${exp}`).map((r) => r.id)
);
const missing = manifest.filter((id) => !recorded.has(id));
if (missing.length > 0) {
  console.log(`Missing from D1 (never started, or failed before its first step): ${missing.length}`);
  for (const id of missing) console.log(`  ${id}  -> npx wrangler workflows instances describe experiment-runner ${id}`);
}

const status = query<{ status: string; n: number }>(
  `SELECT status, COUNT(*) AS n FROM runs WHERE experiment_id = ${exp} GROUP BY status`
);
console.log(`Runs: ${status.map((s) => `${s.n} ${s.status}`).join(", ") || "none yet"}`);

const errors = query<{ id: string; error: string }>(
  `SELECT id, error FROM runs WHERE experiment_id = ${exp} AND status = 'errored'`
);
for (const e of errors) console.log(`  errored: ${e.id}: ${e.error}`);

const perDesign = query<{
  design: string; questions: number; right: number; wrong: number; unclear: number;
}>(
  `SELECT r.design || CASE WHEN r.variant = 'main' THEN '' ELSE '-' || r.variant END || CASE WHEN r.thinking = 'off' THEN '-nothink' ELSE '' END || ' x' || r.filler_scale AS design, COUNT(*) AS questions,
     SUM(v.verdict = 'right') AS right, SUM(v.verdict = 'wrong') AS wrong, SUM(v.verdict = 'unclear') AS unclear
   FROM answer_verdicts v JOIN runs r ON r.id = v.run_id
   WHERE r.experiment_id = ${exp} GROUP BY 1 ORDER BY 1`
);
const turns = query<{ design: string; latency_ms: number; input_tokens: number; output_tokens: number }>(
  `SELECT r.design || CASE WHEN r.variant = 'main' THEN '' ELSE '-' || r.variant END || CASE WHEN r.thinking = 'off' THEN '-nothink' ELSE '' END || ' x' || r.filler_scale AS design, t.latency_ms, t.input_tokens, t.output_tokens
   FROM turns t JOIN runs r ON r.id = t.run_id WHERE r.experiment_id = ${exp}`
);
const compaction = query<{ design: string; input: number; output: number; runs: number }>(
  `SELECT r.design || CASE WHEN r.variant = 'main' THEN '' ELSE '-' || r.variant END || CASE WHEN r.thinking = 'off' THEN '-nothink' ELSE '' END || ' x' || r.filler_scale AS design, SUM(r.compaction_input_tokens) AS input, SUM(r.compaction_output_tokens) AS output,
     COUNT(*) AS runs FROM runs r WHERE r.experiment_id = ${exp} GROUP BY 1`
);

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

if (perDesign.length > 0) {
  console.log("\nrun group                     questions  right  wrong  unclear  accuracy*  median ms  neurons/run");
  for (const d of perDesign) {
    const dt = turns.filter((t) => t.design === d.design);
    const c = compaction.find((x) => x.design === d.design);
    const n =
      neurons(MODEL_ID, dt.reduce((s, t) => s + t.input_tokens, 0), dt.reduce((s, t) => s + t.output_tokens, 0)) +
      neurons(MODEL_ID, c?.input ?? 0, c?.output ?? 0);
    const decided = d.right + d.wrong;
    console.log(
      `${d.design.padEnd(30)}${String(d.questions).padStart(9)}${String(d.right).padStart(7)}` +
        `${String(d.wrong).padStart(7)}${String(d.unclear).padStart(9)}` +
        `${(decided ? ((100 * d.right) / decided).toFixed(1) + "%" : "-").padStart(11)}` +
        `${String(median(dt.map((t) => t.latency_ms))).padStart(11)}` +
        `${(n / (c?.runs || 1)).toFixed(1).padStart(13)}`
    );
  }
  console.log("* right / (right + wrong); unclear answers wait for manual review.");
}

// Log the cost when nothing is still running. A rerun (e.g. restarted
// failed runs) adds only the spending not yet logged for this experiment.
const running = status.find((s) => s.status === "running")?.n ?? 0;
const script = `experiment ${experimentId}`;
let logged = { input: 0, output: 0 };
try {
  for (const line of readFileSync(COST_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { script: string; inputTokens: number; outputTokens: number };
    if (r.script === script || r.script.startsWith(`${script} (`)) {
      logged = { input: logged.input + r.inputTokens, output: logged.output + r.outputTokens };
    }
  }
} catch {
  // No log yet.
}
const finished = manifest.length > 0 && missing.length === 0 && running === 0;
const input = turns.reduce((s, t) => s + t.input_tokens, 0) + compaction.reduce((s, c) => s + c.input, 0);
const output = turns.reduce((s, t) => s + t.output_tokens, 0) + compaction.reduce((s, c) => s + c.output, 0);
const newInput = input - logged.input;
const newOutput = output - logged.output;
if (finished && (newInput > 0 || newOutput > 0)) {
  const n = neurons(MODEL_ID, newInput, newOutput);
  const isTopUp = logged.input > 0 || logged.output > 0;
  appendCostRecords([
    {
      script: isTopUp ? `${script} (rerun)` : script,
      ranAt: new Date().toISOString(),
      model: MODEL_ID,
      calls: turns.length,
      inputTokens: newInput,
      outputTokens: newOutput,
      neurons: Math.round(n * 10) / 10,
      usd: Math.round(neuronsToUsd(n) * 1e6) / 1e6,
      pricingDate: PRICING_DATE,
      basis: "measured",
      note: isTopUp
        ? "spending since the last record for this experiment (reruns), from D1"
        : `${manifest.length} runs; turns plus compaction, from D1`
    }
  ]);
  console.log(`\nCost: ${n.toFixed(1)} neurons ($${neuronsToUsd(n).toFixed(4)})${isTopUp ? " since last record" : ""}, logged to ${COST_LOG}`);
} else if (!finished) {
  console.log(`\nNot finished (${running} running, ${missing.length} missing); cost is logged once every run has a final status.`);
}
