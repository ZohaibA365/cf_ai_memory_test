import { MODEL_ID } from "./config";
import { neurons } from "./pricing";

// Read-only summary of an experiment for the demo page's charts. Verdicts
// come from the answer_verdicts view, so a hand label overrides the grader
// wherever one exists. Only experiments in PUBLIC_EXPERIMENTS are served:
// pilot runs set parameters and are never reported.

export const PUBLIC_EXPERIMENTS = ["full-1"];

export interface Tally {
  right: number;
  decided: number;
}

export interface DesignRow {
  design: string;
  scale: number;
  runs: number;
  fact: Tally;
  never: Tally;
  unclear: number;
  medianMs: number;
  p90Ms: number;
  neuronsPerRun: number;
}

export interface TypeRow {
  design: string;
  scale: number;
  type: string;
  right: number;
  decided: number;
}

export interface Results {
  experimentId: string;
  model: string;
  conversations: number;
  runs: number;
  humanLabels: number;
  designs: DesignRow[];
  byType: TypeRow[];
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export async function resultsFor(db: D1Database, experimentId: string): Promise<Results> {
  const [runs, answers, turns, labels] = await Promise.all([
    db
      .prepare(
        `SELECT id, conversation_id, design, filler_scale, compaction_input_tokens, compaction_output_tokens
         FROM runs WHERE experiment_id = ? AND status = 'done' AND variant = 'main' AND thinking = 'on'`
      )
      .bind(experimentId)
      .all<{ id: string; conversation_id: string; design: string; filler_scale: number; compaction_input_tokens: number; compaction_output_tokens: number }>(),
    db
      .prepare(
        `SELECT a.run_id, a.question_type, a.verdict FROM answer_verdicts a
         JOIN runs r ON r.id = a.run_id WHERE r.experiment_id = ?`
      )
      .bind(experimentId)
      .all<{ run_id: string; question_type: string; verdict: string }>(),
    db
      .prepare(
        `SELECT t.run_id, t.latency_ms, t.input_tokens, t.output_tokens FROM turns t
         JOIN runs r ON r.id = t.run_id WHERE r.experiment_id = ?`
      )
      .bind(experimentId)
      .all<{ run_id: string; latency_ms: number; input_tokens: number; output_tokens: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM human_labels h JOIN answers a ON a.id = h.answer_id
         JOIN runs r ON r.id = a.run_id WHERE r.experiment_id = ?`
      )
      .bind(experimentId)
      .first<{ n: number }>()
  ]);

  const runInfo = new Map(runs.results.map((r) => [r.id, r]));
  const key = (design: string, scale: number) => `${design}|${scale}`;
  const groups = new Map<string, DesignRow & { latencies: number[]; input: number; output: number }>();
  for (const r of runs.results) {
    const k = key(r.design, r.filler_scale);
    const g = groups.get(k) ?? {
      design: r.design, scale: r.filler_scale, runs: 0,
      fact: { right: 0, decided: 0 }, never: { right: 0, decided: 0 }, unclear: 0,
      medianMs: 0, p90Ms: 0, neuronsPerRun: 0, latencies: [], input: 0, output: 0
    };
    g.runs += 1;
    g.input += r.compaction_input_tokens;
    g.output += r.compaction_output_tokens;
    groups.set(k, g);
  }

  const byType = new Map<string, TypeRow>();
  for (const a of answers.results) {
    const run = runInfo.get(a.run_id);
    if (!run) continue;
    const g = groups.get(key(run.design, run.filler_scale))!;
    if (a.verdict === "unclear") {
      g.unclear += 1;
      continue;
    }
    const tally = a.question_type === "never" ? g.never : g.fact;
    tally.decided += 1;
    if (a.verdict === "right") tally.right += 1;
    const tk = `${run.design}|${run.filler_scale}|${a.question_type}`;
    const t = byType.get(tk) ?? { design: run.design, scale: run.filler_scale, type: a.question_type, right: 0, decided: 0 };
    t.decided += 1;
    if (a.verdict === "right") t.right += 1;
    byType.set(tk, t);
  }

  for (const t of turns.results) {
    const run = runInfo.get(t.run_id);
    if (!run) continue;
    const g = groups.get(key(run.design, run.filler_scale))!;
    g.latencies.push(t.latency_ms);
    g.input += t.input_tokens;
    g.output += t.output_tokens;
  }

  const designs: DesignRow[] = [...groups.values()].map(({ latencies, input, output, ...g }) => ({
    ...g,
    medianMs: quantile(latencies, 0.5),
    p90Ms: quantile(latencies, 0.9),
    neuronsPerRun: g.runs ? neurons(MODEL_ID, input, output) / g.runs : 0
  }));

  return {
    experimentId,
    model: MODEL_ID,
    conversations: new Set(runs.results.map((r) => r.conversation_id)).size,
    runs: runs.results.length,
    humanLabels: labels?.n ?? 0,
    designs: designs.sort((a, b) => a.scale - b.scale || a.design.localeCompare(b.design)),
    byType: [...byType.values()].sort((a, b) => a.scale - b.scale || a.design.localeCompare(b.design) || a.type.localeCompare(b.type))
  };
}
