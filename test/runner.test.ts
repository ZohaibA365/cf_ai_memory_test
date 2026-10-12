import { env, introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { loadConversations } from "../src/experiment/data";
import { answerId, type RunParams } from "../src/experiment/runner";
import type { MemoryAgent } from "../src/memory/agent";
import { scriptedModel } from "./helpers";

// End to end on the mock model: the real Workflow drives the real agents and
// writes to a local D1 with the real migrations.

async function runToCompletion(id: string, params: RunParams) {
  await using instance = await introspectWorkflowInstance(env.EXPERIMENT_RUNNER, id);
  await env.EXPERIMENT_RUNNER.create({ id, params });
  await instance.waitForStatus("complete");
}

const seed = loadConversations().find((c) => c.id === "seed-01")!;
const scoredSteps = seed.steps.filter((s) => s.kind !== "filler").length;
const questions = seed.steps.filter((s) => s.kind === "ask").length;

describe("experiment runner", () => {
  it("plays a conversation and records every turn and graded answer", async () => {
    const id = "test--seed-01--cutoff--r1";
    await runToCompletion(id, {
      experimentId: "test",
      conversationId: "seed-01",
      design: "cutoff",
      repeat: 1,
      fillerScale: 0.25
    });

    const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
    expect(run).toMatchObject({ status: "done", design: "cutoff", conversation_id: "seed-01" });

    const turns = await env.DB.prepare("SELECT * FROM turns WHERE run_id = ? ORDER BY step_index")
      .bind(id)
      .all<{ kind: string; input_tokens: number; neurons: number; history_messages: number }>();
    expect(turns.results).toHaveLength(scoredSteps);
    expect(turns.results.every((t) => t.input_tokens === 100 && t.neurons > 0)).toBe(true);
    // The conversation grows from turn to turn.
    expect(turns.results.at(-1)!.history_messages).toBeGreaterThan(turns.results[0].history_messages);

    const answers = await env.DB.prepare("SELECT * FROM answers WHERE run_id = ?")
      .bind(id)
      .all<{ id: string; question_id: string; answer: string; rule_verdict: string; needs_review: number }>();
    expect(answers.results).toHaveLength(questions);
    const dog = answers.results.find((a) => a.question_id === "q-dog")!;
    // The mock repeats the question, which is not the answer.
    expect(dog.answer).toContain("What's my dog's name?");
    expect(dog.rule_verdict).toBe("wrong");
    expect(dog.id).toBe(await answerId(id, "q-dog"));
    expect(dog.id).not.toContain("cutoff");
  });

  it("records compaction cost for the built-in design", async () => {
    const id = "test--seed-01--builtin--r1";
    await runToCompletion(id, {
      experimentId: "test",
      conversationId: "seed-01",
      design: "builtin",
      repeat: 1,
      fillerScale: 1
    });
    const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<{
      status: string;
      compaction_calls: number;
      compaction_neurons: number;
      compaction_errors: number;
    }>();
    expect(run?.status).toBe("done");
    expect(run?.compaction_calls).toBeGreaterThan(0);
    expect(run?.compaction_neurons).toBeGreaterThan(0);
    expect(run?.compaction_errors).toBe(0);
  });
});

describe("scoredTurn", () => {
  it("returns the saved result when called again with the same key", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "scored-idempotent");
    const { first, second, users } = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const first = await agent.scoredTurn("s1", "Hello there");
      const second = await agent.scoredTurn("s1", "Hello there");
      return { first, second, users: agent.messages.filter((m) => m.role === "user").length };
    });
    expect(second).toEqual(first);
    expect(users).toBe(1);
  });

  it("rolls back a failed turn so a retry starts clean", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "scored-retry");
    const outcome = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      agent.modelOverride = new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("Workers AI is busy");
        }
      });
      const error = await agent.scoredTurn("s1", "Hi").then(() => null, (e: Error) => e.message);
      const afterFailure = agent.messages.length;
      agent.modelOverride = scriptedModel([{ text: "Hello!" }]);
      const retry = await agent.scoredTurn("s1", "Hi");
      return { error, afterFailure, retry, total: agent.messages.length };
    });
    expect(outcome.error).toMatch(/status error/);
    expect(outcome.afterFailure).toBe(0);
    expect(outcome.retry.answer).toBe("Hello!");
    expect(outcome.total).toBe(2);
  });
});
