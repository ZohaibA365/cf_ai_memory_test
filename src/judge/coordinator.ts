import { Agent } from "agents";
import type { AskStep } from "../experiment/conversation";
import { loadConversations } from "../experiment/data";
import { grade, GRADER_VERSION } from "../experiment/grader";
import { neurons } from "../pricing";
import { Judge } from "./agent";

// The grading coordinator: receives answers, runs the rule grader itself,
// delegates each answer to its judge sub-agent, and records both verdicts in
// judge_verdicts. A second opinion only: it never writes to answers or
// human_labels, so the headline results stay the rule grader's (with hand
// labels overriding). Fed by the JudgeRunner Workflow.

export interface AnswerToGrade {
  id: string;
  conversationId: string;
  questionId: string;
  question: string;
  /** JSON, as stored in answers. */
  expected: string;
  outdated: string;
  answer: string;
  /** The rule verdict stored when the run was graded. */
  storedRuleVerdict: string;
}

export interface GradeBatchResult {
  graded: number;
  /** Answers where the coordinator's rule grade differs from the stored one. */
  ruleMismatches: string[];
}

/** Answers judged at once; gpt-oss-120b allows 300 requests per minute. */
const CONCURRENCY = 10;

let questions: Map<string, AskStep> | undefined;
function questionFor(conversationId: string, questionId: string): AskStep {
  questions ??= new Map(
    loadConversations().flatMap((c) =>
      c.steps.flatMap((s) => (s.kind === "ask" ? [[`${c.id}/${s.id}`, s] as const] : []))
    )
  );
  const q = questions.get(`${conversationId}/${questionId}`);
  if (!q) throw new Error(`${conversationId}: no question ${questionId}`);
  return q;
}

export class GradingCoordinator extends Agent<Env> {
  /** The judge sub-agent; spawned on first use, then reused. */
  judge() {
    return this.dynamicAgents.get(Judge, "judge");
  }

  async gradeAnswers(jobId: string, answers: AnswerToGrade[]): Promise<GradeBatchResult> {
    const judge = await this.judge();
    const graded: { a: AnswerToGrade; rule: ReturnType<typeof grade>; j: Awaited<ReturnType<Judge["judge"]>> }[] = [];
    for (let i = 0; i < answers.length; i += CONCURRENCY) {
      const wave = answers.slice(i, i + CONCURRENCY);
      graded.push(
        ...(await Promise.all(
          wave.map(async (a) => {
            const rule = grade(questionFor(a.conversationId, a.questionId), a.answer);
            // The judge sees exactly what is stored for the answer.
            const j = await judge.judge({
              question: a.question,
              expected: JSON.parse(a.expected) as string[][],
              outdated: JSON.parse(a.outdated) as string[],
              reply: a.answer
            });
            return { a, rule, j: { ...j } };
          })
        ))
      );
    }
    const db = this.env.DB;
    const now = new Date().toISOString();
    await db.batch(
      graded.map(({ a, rule, j }) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO judge_verdicts (answer_id, model, job_id, verdict, reason, attempts,
               input_tokens, output_tokens, neurons, rule_verdict, grader_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(a.id, j.model, jobId, j.verdict, j.reason, j.attempts, j.inputTokens, j.outputTokens,
            neurons(j.model, j.inputTokens, j.outputTokens), rule.verdict, GRADER_VERSION, now)
      )
    );
    return {
      graded: graded.length,
      ruleMismatches: graded.filter(({ a, rule }) => rule.verdict !== a.storedRuleVerdict).map(({ a }) => a.id)
    };
  }
}
