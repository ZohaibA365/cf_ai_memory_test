// Exports an experiment from D1 to CSV files in results/<id>/, so the Python
// analysis (analysis/) runs offline and anyone can reproduce it from the
// repo. Verdicts are final: a hand label overrides the grader. Also computes
// built-in's per-run fact loss from the memory block saved after each turn,
// and exports the AI judge's verdicts (judge.csv) when it has run.
// No model calls.
//
//   npm run export:results -- full-1

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { conversationSchema, type Conversation } from "../src/experiment/conversation";
import { factLoss, factsFor } from "../src/experiment/pilot";
import { query, sqlString } from "./d1";

const experimentId = process.argv[2] ?? "full-1";
const exp = sqlString(experimentId);
const dir = `results/${experimentId}`;
mkdirSync(dir, { recursive: true });

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) throw new Error(`${name}: no rows`);
  const head = Object.keys(rows[0]);
  const body = rows.map((r) => head.map((h) => csvField(r[h])).join(","));
  writeFileSync(`${dir}/${name}`, [head.join(","), ...body].join("\n") + "\n");
  console.log(`${dir}/${name}: ${rows.length} rows`);
}

const runFilter = `r.experiment_id = ${exp} AND r.status = 'done'`;

const runs = query<Record<string, unknown> & { run_id: string; conversation_id: string; design: string }>(
  `SELECT r.id AS run_id, r.conversation_id, r.design, r.variant, r.thinking, r.filler_scale AS scale,
     r.repeat, r.model, r.budget_tokens, r.compaction_calls, r.compaction_input_tokens,
     r.compaction_output_tokens, r.compaction_errors, r.compaction_skipped
   FROM runs r WHERE ${runFilter} ORDER BY r.id`
);
writeCsv("runs.csv", runs);

writeCsv(
  "turns.csv",
  query(
    `SELECT t.run_id, t.step_index, t.step_id, t.kind, t.history_messages, t.latency_ms, t.model_latency_ms,
       t.model_calls, t.input_tokens, t.output_tokens, t.estimated_tokens
     FROM turns t JOIN runs r ON r.id = t.run_id WHERE ${runFilter} ORDER BY t.run_id, t.step_index`
  )
);

writeCsv(
  "answers.csv",
  query(
    `SELECT a.id AS answer_id, a.run_id, a.question_id, a.question_type, a.question, a.answer,
       a.rule_verdict, a.grader_version, a.human_label, a.verdict
     FROM answer_verdicts a JOIN runs r ON r.id = a.run_id WHERE ${runFilter} ORDER BY a.run_id, a.question_id`
  )
);

writeCsv(
  "labels.csv",
  query(
    `SELECT h.answer_id, h.batch, h.label, a.rule_verdict, a.question_type, r.design, r.filler_scale AS scale
     FROM human_labels h JOIN answers a ON a.id = h.answer_id JOIN runs r ON r.id = a.run_id
     WHERE ${runFilter} ORDER BY h.batch, h.answer_id`
  )
);

// The AI judge's second opinion, when it has run (never part of the verdicts above).
const judged = query<Record<string, unknown>>(
  `SELECT j.answer_id, j.verdict AS judge_verdict, j.reason AS judge_reason, j.model AS judge_model,
     j.rule_verdict AS coordinator_rule_verdict, j.job_id
   FROM judge_verdicts j JOIN answers a ON a.id = j.answer_id JOIN runs r ON r.id = a.run_id
   WHERE ${runFilter} ORDER BY j.answer_id`
);
if (judged.length > 0) writeCsv("judge.csv", judged);

// Built-in fact loss, from the memory block saved after every turn.
const conversations = new Map<string, Conversation>();
const conv = (id: string) => {
  if (!conversations.has(id)) {
    conversations.set(id, conversationSchema.parse(JSON.parse(readFileSync(`data/conversations/${id}.json`, "utf8"))));
  }
  return conversations.get(id)!;
};
const blocks = query<{ run_id: string; step_index: number; memory_block: string | null }>(
  `SELECT t.run_id, t.step_index, t.memory_block FROM turns t JOIN runs r ON r.id = t.run_id
   WHERE ${runFilter} AND r.design = 'builtin' ORDER BY t.run_id, t.step_index`
);
const lossRows: Record<string, unknown>[] = [];
for (const run of runs.filter((r) => r.design === "builtin")) {
  const snapshots = blocks
    .filter((b) => b.run_id === run.run_id && b.memory_block !== null)
    .map((b) => ({ stepIndex: b.step_index, memoryBlock: b.memory_block! }));
  for (const o of factLoss(factsFor(conv(run.conversation_id)), snapshots)) {
    lossRows.push({
      run_id: run.run_id,
      fact_id: o.fact.id,
      outdated_later: o.fact.outdatedAt !== null,
      saved: o.saved,
      lost: o.lost,
      missing_at_end: o.missingAtEnd
    });
  }
}
writeCsv("fact_loss.csv", lossRows);
