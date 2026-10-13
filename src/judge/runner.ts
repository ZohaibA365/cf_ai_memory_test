import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { BLIND_BATCH, JUDGE_MODEL } from "./config";
import type { AnswerToGrade, GradingCoordinator } from "./coordinator";

// Feeds answers to the grading coordinator in chunks; the coordinator does
// the grading (rule grader + judge sub-agent) and records the verdicts.
// Scopes: "blind" = the 100 answers in the blind hand-label sample (the judge
// sees the answers, never the labels); "all" = every answer of the
// experiment. Answers already judged by this model are skipped, so a
// restarted job resumes, unless `rejudge` is set. Started by scripts/judge.ts.

export interface JudgeParams {
  jobId: string;
  experimentId: string;
  scope: "blind" | "all";
  /** Grade again answers that already have a judge verdict. */
  rejudge?: boolean;
}

export { BLIND_BATCH };
const CHUNK = 20;

export class JudgeRunner extends WorkflowEntrypoint<Env, JudgeParams> {
  async run(event: WorkflowEvent<JudgeParams>, step: WorkflowStep) {
    const p = event.payload;
    const db = this.env.DB;

    const ids = await step.do("list answers", async () => {
      const scopeSql =
        p.scope === "blind" ? `AND a.id IN (SELECT answer_id FROM human_labels WHERE batch = '${BLIND_BATCH}')` : "";
      const skipSql = p.rejudge ? "" : "AND a.id NOT IN (SELECT answer_id FROM judge_verdicts WHERE model = ?2)";
      const rows = await db
        .prepare(
          `SELECT a.id FROM answers a JOIN runs r ON r.id = a.run_id
           WHERE r.experiment_id = ?1 AND r.status = 'done' ${scopeSql} ${skipSql}
           ORDER BY a.id`
        )
        .bind(...(p.rejudge ? [p.experimentId] : [p.experimentId, JUDGE_MODEL]))
        .all<{ id: string }>();
      return rows.results.map((r) => r.id);
    });

    let graded = 0;
    const ruleMismatches: string[] = [];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const r = await step.do(
        `grade ${start}`,
        { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          const rows = await db
            .prepare(
              `SELECT a.id, r.conversation_id AS conversationId, a.question_id AS questionId, a.question, a.expected,
                 a.outdated, a.answer, a.rule_verdict AS storedRuleVerdict
               FROM answers a JOIN runs r ON r.id = a.run_id WHERE a.id IN (${chunk.map(() => "?").join(",")})`
            )
            .bind(...chunk)
            .all<AnswerToGrade>();
          const coordinator = await getAgentByName<Env, GradingCoordinator>(
            this.env.GradingCoordinator as unknown as DurableObjectNamespace<GradingCoordinator>,
            "grading"
          );
          // Copy out of the RPC result: steps must return plain data.
          const out = await coordinator.gradeAnswers(p.jobId, rows.results);
          return { graded: out.graded, ruleMismatches: [...out.ruleMismatches] };
        }
      );
      graded += r.graded;
      ruleMismatches.push(...r.ruleMismatches);
    }
    return { jobId: p.jobId, judged: graded, ruleMismatches, model: JUDGE_MODEL };
  }
}
