// Starts an experiment: one Workflow instance per (conversation × design ×
// repeat), triggered in an interleaved order so slow periods on Workers AI do
// not land on one design. The model calls happen in the cloud; their neuron
// cost is logged by `npm run experiment:status` once the runs finish.
//
//   npm run experiment -- --id pilot-1 [--conversations seed-01,seed-02]
//     [--designs cutoff,builtin,search] [--repeats 3] [--scale 1] [--dry-run]
//     [--builtin-variants main,shipped]   # pilot: both memory-block wordings
//     [--scale 0.5,1,2]                    # pilot: several lengths at once
//     [--thinking on|off]                  # pilot: reply thinking
//     [--split pilot|main]                 # which conversations (default main)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Without --conversations, run every conversation in --split (default
// "main"). Pilot seeds only run when asked for, so they never end up in a
// full run by accident.
const split = arg("split") ?? "main";
const conversations =
  arg("conversations")?.split(",") ??
  readdirSync("data/conversations")
    .filter((f) => f.endsWith(".json"))
    .filter((f) => (JSON.parse(readFileSync(`data/conversations/${f}`, "utf8")) as { split: string }).split === split)
    .map((f) => f.replace(/\.json$/, ""));
if (conversations.length === 0) {
  console.error(`No conversations with split "${split}".`);
  process.exit(1);
}
const designs = (arg("designs")?.split(",") ?? ["cutoff", "builtin", "search"]) as DesignName[];
const repeats = Number(arg("repeats") ?? 3);
const scales = (arg("scale") ?? "1").split(",").map(Number);
if (scales.some((x) => !(x > 0))) throw new Error("--scale must be positive numbers");
const thinking = (arg("thinking") ?? "on") as "on" | "off";
if (thinking !== "on" && thinking !== "off") throw new Error("--thinking must be on or off");
const dryRun = process.argv.includes("--dry-run");
const builtinVariants = (arg("builtin-variants")?.split(",") ?? ["main"]) as ("main" | "shipped")[];

const runs: { id: string; params: RunParams }[] = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const fillerScale of scales) {
    for (const conversationId of conversations) {
      for (const design of designs) {
        for (const variant of design === "builtin" ? builtinVariants : (["main"] as const)) {
          const label =
            design + (variant === "main" ? "" : `-${variant}`) + (thinking === "off" ? "-nothink" : "");
          const id = `${experimentId}--${conversationId}--${label}--x${fillerScale}--r${repeat}`;
          if (id.length > 100) throw new Error(`instance id too long: ${id}`);
          runs.push({
            id,
            params: { experimentId, conversationId, design, variant, thinking, repeat, fillerScale }
          });
        }
      }
    }
  }
}

console.log(
  `Experiment ${experimentId}: ${runs.length} runs (${conversations.length} conversations, ` +
    `designs ${designs.join("/")}, built-in variants ${builtinVariants.join("/")}, ` +
    `scales ${scales.join("/")}, thinking ${thinking}, ${repeats} repeats)`
);
// The manifest lets experiment:status notice runs that never reached D1
// (for example an instance that failed before its first step).
if (!dryRun) {
  mkdirSync("results/experiments", { recursive: true });
  writeFileSync(
    `results/experiments/${experimentId}.json`,
    JSON.stringify(
      { experimentId, startedAt: new Date().toISOString(), split, scales, thinking, builtinVariants, runs: runs.map((r) => r.id) },
      null,
      2
    ) + "\n"
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
