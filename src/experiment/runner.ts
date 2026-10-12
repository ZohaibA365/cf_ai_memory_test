import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { CONTEXT_BUDGET_TOKENS, MODEL_ID } from "../config";
import type { MemoryAgent } from "../memory/agent";
import type { DesignName } from "../memory/design";
import { neurons } from "../pricing";
import { fillerFor } from "./conversation";
import { loadConversations, loadFillerPool } from "./data";
import { grade } from "./grader";

// The experiment runner: one Workflow instance plays one test conversation
// through one memory design once, and records every turn and graded answer
// in D1. Instances are started by scripts/run-experiment.ts, never by a
// public endpoint, so nobody else can spend model budget.
//
// Each step is idempotent: the agent's scoredTurn() returns a saved result on
// retry, filler messages have fixed ids, and D1 writes use natural keys.

export interface RunParams {
  experimentId: string;
  conversationId: string;
  design: DesignName;
  repeat: number;
  fillerScale: number;
}

export const DESIGN_BINDINGS = {
  cutoff: "CutoffAgent",
  builtin: "BuiltinAgent",
  search: "SearchAgent"
} as const satisfies Record<DesignName, keyof Env>;

/** Opaque answer id: hides the run (and so the design) from labelers. */
export async function answerId(runId: string, questionId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${runId}\u0000${questionId}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ExperimentRunner extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const p = event.payload;
    const runId = event.instanceId;
    const db = this.env.DB;
    // All three designs share MemoryAgent's RPC methods.
    const namespace = this.env[DESIGN_BINDINGS[p.design]] as unknown as DurableObjectNamespace<MemoryAgent>;
    const agent = () => getAgentByName<Env, MemoryAgent>(namespace, runId);

    const conversation = loadConversations().find((c) => c.id === p.conversationId);
    if (!conversation) throw new Error(`unknown conversation ${p.conversationId}`);
    const fillerBlocks = fillerFor(conversation, loadFillerPool(), p.fillerScale);

    await step.do("start", async () => {
      await db
        .prepare(
          `INSERT OR IGNORE INTO runs (id, experiment_id, conversation_id, design, repeat, model,
             budget_tokens, filler_scale, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
        )
        .bind(runId, p.experimentId, p.conversationId, p.design, p.repeat, MODEL_ID,
          CONTEXT_BUDGET_TOKENS, p.fillerScale, new Date().toISOString())
        .run();
    });

    try {
      let block = 0;
      for (const [index, s] of conversation.steps.entries()) {
        if (s.kind === "filler") {
          const pairs = fillerBlocks[block++];
          await step.do(`${index} filler`, async () => {
            const stub = await agent();
            // Copy out of the RPC result: steps must return plain data.
            const { messages } = await stub.insertFiller(`f${index}`, pairs);
            return { messages };
          });
          continue;
        }

        const text = s.kind === "say" ? s.text : s.question;
        await step.do(
          `${index} ${s.id}`,
          { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" }, timeout: "10 minutes" },
          async () => {
            const stub = await agent();
            const t = await stub.scoredTurn(`s${index}`, text);
            const now = new Date().toISOString();
            const statements = [
              db
                .prepare(
                  `INSERT OR REPLACE INTO turns (run_id, step_index, step_id, kind, history_messages,
                     latency_ms, model_latency_ms, model_calls, input_tokens, output_tokens,
                     estimated_tokens, neurons, status, recovered, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
                )
                .bind(runId, index, s.id, s.kind, t.historyMessages, t.latencyMs, t.modelLatencyMs,
                  t.modelCalls, t.inputTokens, t.outputTokens, t.estimatedTokens,
                  neurons(MODEL_ID, t.inputTokens, t.outputTokens), t.status, now)
            ];
            if (s.kind === "ask") {
              const g = grade(s, t.answer);
              statements.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO answers (id, run_id, question_id, question_type, question,
                       expected, outdated, answer, rule_verdict, rule_reasons, needs_review, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                  )
                  .bind(await answerId(runId, s.id), runId, s.id, s.type, s.question,
                    JSON.stringify(s.expected), JSON.stringify(s.outdated), t.answer, g.verdict,
                    JSON.stringify(g.reasons), g.verdict === "unclear" ? 1 : 0, now)
              );
            }
            await db.batch(statements);
            return { latencyMs: t.latencyMs, inputTokens: t.inputTokens };
          }
        );
      }

      await step.do("finish", async () => {
        const stub = await agent();
        const m = await stub.runMetrics();
        await db
          .prepare(
            `UPDATE runs SET status = 'done', finished_at = ?, compaction_calls = ?,
               compaction_input_tokens = ?, compaction_output_tokens = ?, compaction_errors = ?,
               compaction_neurons = ? WHERE id = ?`
          )
          .bind(new Date().toISOString(), m.compactionCalls, m.compactionInputTokens,
            m.compactionOutputTokens, m.compactionErrors,
            neurons(MODEL_ID, m.compactionInputTokens, m.compactionOutputTokens), runId)
          .run();
      });
      return { runId, status: "done" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("mark errored", async () => {
        await db
          .prepare(`UPDATE runs SET status = 'errored', error = ?, finished_at = ? WHERE id = ?`)
          .bind(message, new Date().toISOString(), runId)
          .run();
      });
      throw error;
    }
  }
}
