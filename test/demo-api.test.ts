import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FAST_FORWARD } from "../src/config";
import type { MemoryAgent } from "../src/memory/agent";
import { quantile, resultsFor } from "../src/results";

describe("fast-forward (demo page)", () => {
  it("adds small talk without model calls, continuing from the last call", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "ff-basic");
    const out = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const first = await agent.fastForward(3);
      const second = await agent.fastForward(2);
      return {
        first,
        second,
        ids: agent.messages.map((m) => m.id),
        steps: agent.metrics().filter((m) => m.kind === "step").length
      };
    });
    expect(out.first).toMatchObject({ added: 3, used: 3 });
    expect(out.second).toMatchObject({ added: 2, used: 5 });
    expect(out.ids).toHaveLength(10);
    expect(out.ids.every((id) => id.startsWith("ff-"))).toBe(true);
    expect(out.steps).toBe(0);
  });

  it("caps pairs per call and per agent", async () => {
    const stub = await getAgentByName(env.SearchAgent, "ff-caps");
    const results = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const calls = [];
      for (let i = 0; i < 12; i++) calls.push(await agent.fastForward(1000));
      return calls;
    });
    expect(results[0].added).toBe(FAST_FORWARD.maxPairsPerCall);
    expect(results.at(-1)).toMatchObject({ added: 0, used: FAST_FORWARD.maxPairsPerAgent });
  });

  it("is a POST endpoint that rejects bad input", async () => {
    const base = "http://example.com/agents/cutoff-agent/ff-http/fast-forward";
    expect((await exports.default.fetch(base)).status).toBe(405);
    const bad = await exports.default.fetch(base, { method: "POST", body: JSON.stringify({ pairs: -1 }) });
    expect(bad.status).toBe(400);
    const ok = await exports.default.fetch(base, { method: "POST", body: JSON.stringify({ pairs: 2 }) });
    expect(await ok.json()).toMatchObject({ added: 2 });
  });
});

describe("results API", () => {
  async function seed() {
    const db = env.DB;
    const now = new Date().toISOString();
    const runs = [
      ["r-cut", "cutoff"],
      ["r-search", "search"]
    ];
    for (const [id, design] of runs) {
      await db
        .prepare(
          `INSERT INTO runs (id, experiment_id, conversation_id, design, repeat, model, budget_tokens,
             filler_scale, status, started_at, compaction_input_tokens, compaction_output_tokens)
           VALUES (?, 'full-1', 'main-01', ?, 1, 'm', 2000, 0.5, 'done', ?, 0, 0)`
        )
        .bind(id, design, now)
        .run();
      for (const [i, ms] of [[0, 1000], [1, 3000]] as const) {
        await db
          .prepare(
            `INSERT INTO turns (run_id, step_index, step_id, kind, history_messages, latency_ms, model_calls,
               input_tokens, output_tokens, neurons, status, created_at)
             VALUES (?, ?, 's', 'ask', 0, ?, 1, 1000, 100, 0, 'completed', ?)`
          )
          .bind(id, i, ms, now)
          .run();
      }
    }
    const answer = (id: string, run: string, type: string, verdict: string) =>
      db
        .prepare(
          `INSERT INTO answers (id, run_id, question_id, question_type, question, expected, outdated, answer,
             rule_verdict, rule_reasons, needs_review, created_at)
           VALUES (?, ?, ?, ?, 'q', '[]', '[]', 'a', ?, '[]', 0, ?)`
        )
        .bind(id, run, id, type, verdict, now)
        .run();
    await answer("a1", "r-cut", "simple", "wrong");
    await answer("a2", "r-cut", "never", "right");
    await answer("a3", "r-search", "simple", "right");
    await answer("a4", "r-search", "exact", "wrong");
    // A hand label overrides the grader: a4 becomes right.
    await db
      .prepare(`INSERT INTO human_labels (answer_id, labeler, label, batch, labeled_at) VALUES ('a4', 'user', 'right', 'b', ?)`)
      .bind(now)
      .run();
  }

  it("summarizes accuracy, latency and cost, with hand labels overriding the grader", async () => {
    await seed();
    const r = await resultsFor(env.DB, "full-1");
    expect(r.runs).toBe(2);
    expect(r.humanLabels).toBe(1);
    const cut = r.designs.find((d) => d.design === "cutoff")!;
    const search = r.designs.find((d) => d.design === "search")!;
    expect(cut.fact).toEqual({ right: 0, decided: 1 });
    expect(cut.never).toEqual({ right: 1, decided: 1 });
    expect(search.fact).toEqual({ right: 2, decided: 2 });
    expect(search.medianMs).toBe(3000);
    expect(search.neuronsPerRun).toBeGreaterThan(0);
    expect(r.byType.find((t) => t.design === "search" && t.type === "exact")).toMatchObject({ right: 1, decided: 1 });
  });

  it("only serves public experiments", async () => {
    const res = await exports.default.fetch("http://example.com/api/results?experiment=pilot-b");
    expect(res.status).toBe(404);
  });

  it("computes quantiles", () => {
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(quantile([], 0.9)).toBe(0);
  });
});
