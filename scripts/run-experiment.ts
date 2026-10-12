// Starts an experiment: one Workflow instance per (conversation × design ×
// repeat), triggered in an interleaved order so slow periods on Workers AI do
// not land on one design. The model calls happen in the cloud; their neuron
// cost is logged by `npm run experiment:status` once the runs finish.
//
//   npm run experiment -- --id pilot-1 [--conversations seed-01,seed-02]
//     [--designs cutoff,builtin,search] [--repeats 3] [--scale 1] [--dry-run]

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import type { DesignName } from "../src/memory/design";
import type { RunParams } from "../src/experiment/runner";
import { triggerWorkflow } from "./d1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const experimentId = arg("id");
if (!experimentId || !/^[a-z0-9-]+$/.test(experimentId)) {
  console.error("Pass --id with lowercase letters, digits and dashes, e.g. --id pilot-1");
  process.exit(1);
}
const conversations =
  arg("conversations")?.split(",") ??
  readdirSync("data/conversations").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
const designs = (arg("designs")?.split(",") ?? ["cutoff", "builtin", "search"]) as DesignName[];
const repeats = Number(arg("repeats") ?? 3);
const fillerScale = Number(arg("scale") ?? 1);
const dryRun = process.argv.includes("--dry-run");

const runs: { id: string; params: RunParams }[] = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const conversationId of conversations) {
    for (const design of designs) {
      const id = `${experimentId}--${conversationId}--${design}--r${repeat}`;
      if (id.length > 100) throw new Error(`instance id too long: ${id}`);
      runs.push({ id, params: { experimentId, conversationId, design, repeat, fillerScale } });
    }
  }
}

console.log(
  `Experiment ${experimentId}: ${runs.length} runs (${conversations.length} conversations × ` +
    `${designs.length} designs × ${repeats} repeats), filler scale ${fillerScale}`
);
// The manifest lets experiment:status notice runs that never reached D1
// (for example an instance that failed before its first step).
if (!dryRun) {
  mkdirSync("results/experiments", { recursive: true });
  writeFileSync(
    `results/experiments/${experimentId}.json`,
    JSON.stringify({ experimentId, startedAt: new Date().toISOString(), fillerScale, runs: runs.map((r) => r.id) }, null, 2) + "\n"
  );
}
for (const run of runs) {
  if (dryRun) {
    console.log(`  would start ${run.id}`);
    continue;
  }
  triggerWorkflow("experiment-runner", run.id, run.params);
  console.log(`  started ${run.id}`);
}
if (!dryRun) console.log(`\nCheck progress with: npm run experiment:status -- ${experimentId}`);
