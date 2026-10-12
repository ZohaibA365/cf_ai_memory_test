// Stage 4 pilot report: accuracy by question kind, latency, cost and
// built-in fact loss for one experiment, plus the length the rule picks.
// Reads D1 only (no model calls). Also saves results/pilot/<id>.json.
//
//   npm run pilot:report -- pilot-b
//   npm run pilot:report -- pilot-b,pilot-d   # several experiments combined

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { conversationSchema, type Conversation } from "../src/experiment/conversation";
import { factLoss, factsFor, pickLength, type ScaleResult } from "../src/experiment/pilot";
import { MODEL_ID } from "../src/config";
import { neurons } from "../src/pricing";
import { query, sqlString } from "./d1";

const experimentId = process.argv[2];
if (!experimentId) {
  console.error("Usage: npm run pilot:report -- <experiment id>");
  process.exit(1);
}
// One or more experiments (comma separated), reported together.
const exp = experimentId.split(",").map(sqlString).join(", ");

const conversations = new Map<string, Conversation>();
function conversation(id: string): Conversation {
  if (!conversations.has(id)) {
    conversations.set(id, conversationSchema.parse(JSON.parse(readFileSync(`data/conversations/${id}.json`, "utf8"))));
  }
  return conversations.get(id)!;
}

interface Run {
  id: string; conversation_id: string; design: string; variant: string; thinking: string;
  filler_scale: number; status: string; compaction_input_tokens: number; compaction_output_tokens: number;
}
const runs = query<Run>(
  `SELECT id, conversation_id, design, variant, thinking, filler_scale, status,
     compaction_input_tokens, compaction_output_tokens FROM runs WHERE experiment_id IN (${exp})`
);
const answers = query<{ run_id: string; question_type: string; verdict: string }>(
  `SELECT a.run_id, a.question_type, a.verdict FROM answer_verdicts a JOIN runs r ON r.id = a.run_id
   WHERE r.experiment_id IN (${exp})`
);
const turns = query<{
  run_id: string; step_index: number; latency_ms: number; input_tokens: number; output_tokens: number; memory_block: string | null;
}>(
  `SELECT t.run_id, t.step_index, t.latency_ms, t.input_tokens, t.output_tokens, t.memory_block
   FROM turns t JOIN runs r ON r.id = t.run_id WHERE r.experiment_id IN (${exp})`
);

const notDone = runs.filter((r) => r.status !== "done");
if (notDone.length) console.log(`Note: ${notDone.length} runs not done (${notDone.map((r) => r.status).join(", ")}); excluded.`);
const done = runs.filter((r) => r.status === "done");

const label = (r: Run) =>
  r.design + (r.variant === "main" ? "" : `-${r.variant}`) + (r.thinking === "off" ? "-nothink" : "");
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---- Accuracy, latency, cost per group --------------------------------
interface Row {
  group: string; scale: number; runs: number; factRight: number; factDecided: number; neverRight: number;
  neverDecided: number; unclear: number; medianMs: number; p90Ms: number; neuronsPerRun: number;
}
const rows: Row[] = [];
const groups = new Map<string, Run[]>();
for (const r of done) {
  const key = `${label(r)}|${r.filler_scale}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
for (const [key, groupRuns] of [...groups].sort()) {
  const [group, scale] = key.split("|");
  const ids = new Set(groupRuns.map((r) => r.id));
  const a = answers.filter((x) => ids.has(x.run_id));
  const t = turns.filter((x) => ids.has(x.run_id));
  const fact = a.filter((x) => x.question_type !== "never");
  const never = a.filter((x) => x.question_type === "never");
  const decided = (xs: typeof a) => xs.filter((x) => x.verdict !== "unclear");
  const n =
    neurons(MODEL_ID, t.reduce((s, x) => s + x.input_tokens, 0), t.reduce((s, x) => s + x.output_tokens, 0)) +
    groupRuns.reduce((s, r) => s + neurons(MODEL_ID, r.compaction_input_tokens, r.compaction_output_tokens), 0);
  rows.push({
    group, scale: Number(scale), runs: groupRuns.length,
    factRight: fact.filter((x) => x.verdict === "right").length, factDecided: decided(fact).length,
    neverRight: never.filter((x) => x.verdict === "right").length, neverDecided: decided(never).length,
    unclear: a.filter((x) => x.verdict === "unclear").length,
    medianMs: quantile(t.map((x) => x.latency_ms), 0.5), p90Ms: quantile(t.map((x) => x.latency_ms), 0.9),
    neuronsPerRun: n / groupRuns.length
  });
}

console.log(`\nPilot ${experimentId}: ${done.length} runs done`);
console.log("group                        scale runs  fact right  never right  unclear  median ms  p90 ms  neurons/run");
for (const r of rows.sort((a, b) => a.scale - b.scale || a.group.localeCompare(b.group))) {
  console.log(
    `${r.group.padEnd(28)} ${String(r.scale).padStart(5)} ${String(r.runs).padStart(4)}` +
      `  ${`${r.factRight}/${r.factDecided} ${pct(r.factRight, r.factDecided)}`.padStart(10)}` +
      `  ${`${r.neverRight}/${r.neverDecided} ${pct(r.neverRight, r.neverDecided)}`.padStart(11)}` +
      `  ${String(r.unclear).padStart(7)}  ${String(r.medianMs).padStart(9)}  ${String(r.p90Ms).padStart(6)}` +
      `  ${r.neuronsPerRun.toFixed(0).padStart(11)}`
  );
}

// ---- Fact loss in the built-in memory block ----------------------------
console.log("\nBuilt-in memory block: facts saved and lost");
console.log("group                        scale  facts  saved  lost (of saved)  missing at end");
const lossRows: Record<string, unknown>[] = [];
for (const [key, groupRuns] of [...groups].sort()) {
  if (!key.startsWith("builtin")) continue;
  const [group, scale] = key.split("|");
  let total = 0, saved = 0, lost = 0, missingAtEnd = 0;
  for (const run of groupRuns) {
    const snapshots = turns
      .filter((t) => t.run_id === run.id && t.memory_block !== null)
      .map((t) => ({ stepIndex: t.step_index, memoryBlock: t.memory_block! }));
    const outcomes = factLoss(factsFor(conversation(run.conversation_id)), snapshots);
    total += outcomes.length;
    saved += outcomes.filter((o) => o.saved).length;
    lost += outcomes.filter((o) => o.lost).length;
    missingAtEnd += outcomes.filter((o) => o.missingAtEnd).length;
  }
  lossRows.push({ group, scale: Number(scale), facts: total, saved, lost, missingAtEnd });
  console.log(
    `${group.padEnd(28)} ${scale.padStart(5)}  ${String(total).padStart(5)}  ${pct(saved, total).padStart(5)}` +
      `  ${`${lost} (${pct(lost, saved)})`.padStart(15)}  ${String(missingAtEnd).padStart(14)}`
  );
}

// ---- Length choice (thinking on, main variants) ------------------------
const acc = (group: string, scale: number) => {
  const r = rows.find((x) => x.group === group && x.scale === scale);
  return r && r.factDecided ? r.factRight / r.factDecided : NaN;
};
const scales = [...new Set(rows.map((r) => r.scale))].sort((a, b) => a - b);
const scaleResults: ScaleResult[] = scales
  .map((scale) => ({ scale, cutoff: acc("cutoff", scale), others: { builtin: acc("builtin", scale), search: acc("search", scale) } }))
  .filter((r) => !Number.isNaN(r.cutoff));
const choice = pickLength(scaleResults);
console.log(`\nLength rule: ${choice.scale === null ? "no scale qualifies" : `scale ${choice.scale}`} (${choice.reason})`);

mkdirSync("results/pilot", { recursive: true });
writeFileSync(
  `results/pilot/${experimentId.replace(/,/g, "+")}.json`,
  JSON.stringify({ experimentId, generatedAt: new Date().toISOString(), rows, factLoss: lossRows, lengthChoice: choice }, null, 2) + "\n"
);
console.log(`Saved results/pilot/${experimentId.replace(/,/g, "+")}.json`);
