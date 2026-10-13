// The AI judge, a second grader (src/judge/). It grades answers in the cloud
// through the judge-runner Workflow; this script starts a job and reports on
// it. The judge is a second opinion only: hand labels and the rule grader's
// verdicts are never changed.
//
//   npm run judge -- run --scope blind|all [--experiment full-1] [--job <id>] [--rejudge]
//   npm run judge -- status --job <id> [--compare results/judge/<earlier job>.csv]
//
// "blind" grades the 100 answers in the blind hand-label sample and compares
// the judge with the user's labels; "all" grades every answer of the
// experiment (skipping ones already judged) and compares with the rule grader.
// --rejudge grades answers again even if they already have a judge verdict
// (the newer verdict replaces the older one; --compare reads a saved copy).
// The job's model cost is logged to results/model-costs.jsonl once it is done.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BLIND_BATCH, JUDGE_MODEL } from "../src/judge/config";
import { neurons, neuronsToUsd, PRICING_DATE } from "../src/pricing";
import { appendCostRecords, COST_LOG } from "./cost-log";
import { query, sqlString, triggerWorkflow } from "./d1";
import { agreement, parseCsv } from "./labels-lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Manifest {
  jobId: string;
  experimentId: string;
  scope: "blind" | "all";
  model: string;
  rejudge: boolean;
  expected: number;
  startedAt: string;
}

const command = process.argv[2];
const dir = "results/judge";
const manifestPath = (job: string) => `${dir}/${job}.json`;
const model = sqlString(JUDGE_MODEL);

if (command === "run") {
  const scope = arg("scope");
  if (scope !== "blind" && scope !== "all") throw new Error("--scope must be blind or all");
  const experimentId = arg("experiment") ?? "full-1";
  const jobId = arg("job") ?? `judge-${scope}-${Date.now().toString(36)}`;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) throw new Error("--job: letters, digits, - and _ only");
  const rejudge = process.argv.includes("--rejudge");
  const scopeSql = scope === "blind" ? `AND a.id IN (SELECT answer_id FROM human_labels WHERE batch = '${BLIND_BATCH}')` : "";
  const [{ n }] = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM answers a JOIN runs r ON r.id = a.run_id
     WHERE r.experiment_id = ${sqlString(experimentId)} AND r.status = 'done' ${scopeSql}
       ${rejudge ? "" : `AND a.id NOT IN (SELECT answer_id FROM judge_verdicts WHERE model = ${model})`}`
  );
  if (n === 0) {
    console.log("Nothing left to judge.");
    process.exit(0);
  }
  triggerWorkflow("judge-runner", jobId, { jobId, experimentId, scope, rejudge });
  const manifest: Manifest = { jobId, experimentId, scope, model: JUDGE_MODEL, rejudge, expected: n, startedAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(jobId), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Started ${jobId}: ${n} answers for ${JUDGE_MODEL}. Check with: npm run judge -- status --job ${jobId}`);
} else if (command === "status") {
  const jobId = arg("job");
  if (!jobId) throw new Error("--job is required");
  const m = JSON.parse(readFileSync(manifestPath(jobId), "utf8")) as Manifest;
  const job = sqlString(jobId);

  type Row = {
    answer_id: string; job_id: string; verdict: string | null; reason: string; attempts: number; input_tokens: number;
    output_tokens: number; rule_verdict: string; coordinator_rule: string | null; question_type: string; design: string;
    scale: number; question: string; answer: string; human: string | null;
  };
  // "all" reports on every judged answer of the experiment (this job plus
  // earlier ones); cost and progress count only this job.
  const all = query<Row>(
    `SELECT j.answer_id, j.job_id, j.verdict, j.reason, j.attempts, j.input_tokens, j.output_tokens, a.rule_verdict,
       j.rule_verdict AS coordinator_rule, a.question_type, r.design, r.filler_scale AS scale, a.question, a.answer,
       (SELECT h.label FROM human_labels h WHERE h.answer_id = a.id AND h.batch = '${BLIND_BATCH}') AS human
     FROM judge_verdicts j JOIN answers a ON a.id = j.answer_id JOIN runs r ON r.id = a.run_id
     WHERE r.experiment_id = ${sqlString(m.experimentId)} AND j.model = ${model}
       ${m.scope === "all" ? "" : `AND j.job_id = ${job}`}
     ORDER BY j.answer_id`
  );
  const rows = all.filter((r) => r.job_id === jobId);
  const done = rows.length >= m.expected;
  const input = rows.reduce((s, r) => s + r.input_tokens, 0);
  const output = rows.reduce((s, r) => s + r.output_tokens, 0);
  const spent = neurons(JUDGE_MODEL, input, output);
  const unparsed = rows.filter((r) => r.verdict === null).length;
  const retried = rows.filter((r) => r.attempts > 1).length;
  console.log(`${jobId} (${m.scope}, ${m.experimentId}, ${JUDGE_MODEL}): ${rows.length}/${m.expected} judged${done ? "" : ", still running"}`);
  console.log(
    `Unparsed: ${unparsed}, retried: ${retried}. Neurons so far: ${spent.toFixed(0)} ` +
      `(${rows.length ? (spent / rows.length).toFixed(1) : "0"} per answer; ` +
      `${rows.length ? Math.round(input / rows.length) : 0} in / ${rows.length ? Math.round(output / rows.length) : 0} out tokens)`
  );

  const judge = (r: Row) => r.verdict ?? "unparsed";
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

  // The coordinator re-runs the rule grader on every answer; it should match
  // the verdict stored when the run was graded.
  const checked = all.filter((r) => r.coordinator_rule !== null);
  const ruleDiff = checked.filter((r) => r.coordinator_rule !== r.rule_verdict);
  console.log(`Coordinator's rule grade matches the stored rule verdict: ${checked.length - ruleDiff.length}/${checked.length}` +
    (ruleDiff.length ? ` (differs: ${ruleDiff.map((r) => r.answer_id).join(", ")})` : ""));

  const comparePath = arg("compare");
  if (comparePath) {
    const [head, ...lines] = parseCsv(readFileSync(comparePath, "utf8"));
    const before = new Map(lines.map((l) => [l[head.indexOf("answer_id")], l[head.indexOf("verdict")]]));
    const same = rows.filter((r) => before.get(r.answer_id) === (r.verdict ?? ""));
    const changed = rows.filter((r) => before.has(r.answer_id) && before.get(r.answer_id) !== (r.verdict ?? ""));
    console.log(`Same verdict as ${comparePath}: ${same.length}/${rows.length}` +
      (changed.length ? `; changed: ${changed.map((r) => `${r.answer_id} ${before.get(r.answer_id)}→${judge(r)}`).join(", ")}` : ""));
  }

  if (m.scope === "blind") {
    const labelled = rows.filter((r) => r.human !== null);
    const j = agreement(labelled.map((r) => ({ rule: judge(r), human: r.human! })));
    const g = agreement(labelled.map((r) => ({ rule: r.rule_verdict, human: r.human! })));
    const agreeJ = labelled.filter((r) => judge(r) === r.human).length;
    const agreeG = labelled.filter((r) => r.rule_verdict === r.human).length;
    console.log(`\nAgreement with the user's ${labelled.length} blind labels:`);
    console.log(`  AI judge     ${agreeJ}/${labelled.length} (${pct(j.agreement)}), Cohen's κ ${j.kappa.toFixed(2)}`);
    console.log(`  Rule grader  ${agreeG}/${labelled.length} (${pct(g.agreement)}), Cohen's κ ${g.kappa.toFixed(2)}`);
    const bad = labelled.filter((r) => judge(r) !== r.human);
    console.log(`\nJudge disagreements with the user (${bad.length}):`);
    for (const r of bad) {
      console.log(
        `- ${r.answer_id} [${r.design}, ${r.question_type}] you: ${r.human}, judge: ${judge(r)}, rule grader: ${r.rule_verdict}\n` +
          `    Q: ${r.question}\n    A: ${r.answer.replace(/\s+/g, " ").slice(0, 300)}\n    Judge's reason: ${r.reason}`
      );
    }
  } else {
    const rows = all;
    console.log(`\nReport covers all ${rows.length} judged answers of ${m.experimentId}.`);
    // Judge vs rule grader. The rule grader's "unclear" (sent to review) is
    // counted separately, not as a disagreement.
    const graded = rows.filter((r) => r.rule_verdict !== "unclear");
    const differ = graded.filter((r) => judge(r) !== r.rule_verdict);
    console.log(`\nJudge vs rule grader: ${graded.length - differ.length}/${graded.length} agree (${pct(1 - differ.length / Math.max(1, graded.length))}).`);
    console.log(`Rule grader "unclear" (left for review): ${rows.length - graded.length}.`);
    const table = new Map<string, { n: number; differ: number; judgeRight: number; ruleRight: number }>();
    for (const r of graded) {
      for (const key of [`${r.design} | ${r.question_type}`, `${r.design} | all`, `all | ${r.question_type}`]) {
        const t = table.get(key) ?? { n: 0, differ: 0, judgeRight: 0, ruleRight: 0 };
        t.n++;
        if (judge(r) !== r.rule_verdict) t.differ++;
        if (judge(r) === "right" && r.rule_verdict === "wrong") t.judgeRight++;
        if (judge(r) !== "right" && r.rule_verdict === "right") t.ruleRight++;
        table.set(key, t);
      }
    }
    console.log("\ndesign | question type: disagreements / answers (judge says right where grader says wrong; the reverse)");
    for (const [key, t] of [...table].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${key.padEnd(28)} ${String(t.differ).padStart(4)}/${String(t.n).padEnd(5)} (${pct(t.differ / t.n).padStart(6)})  ${t.judgeRight} / ${t.ruleRight}`);
    }
  }

  if (done) {
    // Log the job's cost once; a rerun of status adds nothing.
    const script = `judge ${jobId}`;
    let logged = false;
    try {
      logged = readFileSync(COST_LOG, "utf8").split("\n").some((l) => l.trim() && (JSON.parse(l) as { script: string }).script === script);
    } catch {
      // No log yet.
    }
    if (!logged) {
      appendCostRecords([
        {
          script,
          ranAt: new Date().toISOString(),
          model: JUDGE_MODEL,
          calls: rows.reduce((s, r) => s + r.attempts, 0),
          inputTokens: input,
          outputTokens: output,
          neurons: Math.round(spent * 10) / 10,
          usd: Math.round(neuronsToUsd(spent) * 1e6) / 1e6,
          pricingDate: PRICING_DATE,
          basis: "measured",
          note: `AI judge, ${m.scope} scope, ${rows.length} answers of ${m.experimentId}; from judge_verdicts in D1`
        }
      ]);
      console.log(`\nCost: ${spent.toFixed(1)} neurons ($${neuronsToUsd(spent).toFixed(4)}), logged to ${COST_LOG}`);
    }
  }
} else {
  console.error("Usage: npm run judge -- run --scope blind|all [--experiment full-1] [--job <id>]\n       npm run judge -- status --job <id>");
  process.exit(1);
}
