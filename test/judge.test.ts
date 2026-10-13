import { env, introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../scripts/labels-lib";
import { GRADER_VERSION } from "../src/experiment/grader";
import { judgeWith } from "../src/judge/agent";
import type { GradingCoordinator } from "../src/judge/coordinator";
import {
  describeExpected,
  judgeSystemPrompt,
  judgeUserPrompt,
  loadExamples,
  parseVerdict
} from "../src/judge/prompt";

const csv = import.meta.glob("../labels/*.csv", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const wrangler = import.meta.glob("../wrangler.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const rowsOf = (file: string) => {
  const [head, ...rows] = parseCsv(csv[`../labels/${file}`]);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

describe("judge examples", () => {
  const examples = loadExamples();
  const tuning = rowsOf("pilot-b-review-001.csv");
  const blind = rowsOf("full-1-sample-001.csv");
  const review = rowsOf("full-1-review-001.csv");

  it("are exactly the 12 pilot tuning labels", () => {
    expect(examples).toHaveLength(12);
    expect(examples.map((e) => e.answerId).sort()).toEqual(tuning.map((r) => r.answer_id).sort());
    for (const e of examples) {
      expect(e.label).toBe(tuning.find((r) => r.answer_id === e.answerId)!.label);
    }
  });

  it("never include a full-run hand-labelled answer", () => {
    const fullRun = new Set([...blind, ...review].map((r) => r.answer_id));
    expect(blind).toHaveLength(100);
    expect(examples.filter((e) => fullRun.has(e.answerId))).toEqual([]);
  });

  it("the judge's instructions contain none of the 100 blind replies", () => {
    const system = judgeSystemPrompt();
    for (const e of examples) expect(system).toContain(e.reply);
    const leaked = blind.filter((r) => r.answer.trim().length > 40 && system.includes(r.answer.trim()));
    expect(leaked).toEqual([]);
  });
});

describe("judge prompt for one answer", () => {
  it("shows the question, the correct and outdated answers and the reply, and nothing else", () => {
    const p = judgeUserPrompt({
      question: "Which city do I live in?",
      expected: [["Austin"]],
      outdated: ["Toronto"],
      reply: "  You live in Austin.  "
    });
    expect(p).toBe(
      "Question: Which city do I live in?\nCorrect answer: Austin\nOutdated or confusable values: Toronto\nReply: You live in Austin.\n\nGrade this reply."
    );
    expect(p).not.toMatch(/label|rule|verdict/i);
  });

  it("describes combined and never-said answers", () => {
    expect(describeExpected([["Priya"], ["marine biologist", "biologist"]])).toBe("Priya AND marine biologist or biologist");
    expect(describeExpected([])).toBe("(should say it was never told)");
  });
});

describe("parseVerdict", () => {
  it.each([
    ["VERDICT: right\nREASON: Gives Austin.", { verdict: "right", reason: "Gives Austin." }],
    ["**VERDICT:** Wrong\n**REASON:** Misses the age.", { verdict: "wrong", reason: "Misses the age." }],
    ["Thinking...\nverdict: right", { verdict: "right", reason: "" }]
  ])("parses %j", (text, expected) => {
    expect(parseVerdict(text)).toEqual(expected);
  });

  it("rejects anything else", () => {
    expect(parseVerdict("The answer looks correct.")).toBeNull();
    expect(parseVerdict("VERDICT: maybe")).toBeNull();
  });
});

function scripted(texts: string[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: texts[Math.min(i++, texts.length - 1)] }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 50, text: 50, reasoning: 0 }
      },
      warnings: []
    })
  });
}

const item = { question: "What's my dog's name?", expected: [["Biscuit"]], outdated: [], reply: "Biscuit!" };

describe("judge sub-agent", () => {
  it("returns the verdict and its token usage", async () => {
    const r = await judgeWith(scripted(["VERDICT: right\nREASON: Names the dog."]), item);
    expect(r).toMatchObject({ verdict: "right", reason: "Names the dog.", attempts: 1, inputTokens: 1000, outputTokens: 50 });
  });

  it("retries once on malformed output, then gives up without guessing", async () => {
    const retried = await judgeWith(scripted(["Looks fine to me.", "VERDICT: wrong\nREASON: No."]), item);
    expect(retried).toMatchObject({ verdict: "wrong", attempts: 2, inputTokens: 2000 });
    expect(await judgeWith(scripted(["???"]), item)).toMatchObject({ verdict: null, attempts: 2 });
  });

  it("is not a top-level agent: production has no binding for it", () => {
    const config = Object.values(wrangler)[0];
    expect(config).toMatch(/"class_name": "GradingCoordinator"/);
    expect(config).not.toMatch(/"class_name": "Judge(Agent)?"/);
  });
});

// Real questions from main-01, so the coordinator's rule grader can find them.
const SIMPLE = { id: "q-simple", type: "simple", question: "What's my puppy's name?", expected: '[["Juniper"]]', outdated: "[]" };
const NEVER = { id: "q-never1", type: "never", question: "What breed is my puppy?", expected: "[]", outdated: '["Juniper"]' };

async function seed(experimentId: string, answers: [string, string, typeof SIMPLE, string][], blind: string[]) {
  const now = new Date().toISOString();
  for (const run of new Set(answers.map(([, run]) => run))) {
    await env.DB.prepare(
      `INSERT INTO runs (id, experiment_id, conversation_id, design, repeat, model, budget_tokens, filler_scale, status, started_at)
       VALUES (?, ?, 'main-01', 'search', 1, 'm', 2000, 0.5, 'done', ?)`
    ).bind(run, experimentId, now).run();
  }
  for (const [id, run, q, reply] of answers) {
    // Every stored rule verdict is "right", so a rule re-grade of "wrong" shows up as a mismatch.
    await env.DB.prepare(
      `INSERT INTO answers (id, run_id, question_id, question_type, question, expected, outdated, answer, rule_verdict,
         rule_reasons, needs_review, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'right', '[]', 0, ?)`
    ).bind(id, run, q.id, q.type, q.question, q.expected, q.outdated, reply, now).run();
  }
  for (const id of blind) {
    await env.DB.prepare(
      `INSERT INTO human_labels (answer_id, labeler, label, batch, labeled_at) VALUES (?, 'user', 'right', 'full-1-sample-001', ?)`
    ).bind(id, now).run();
  }
}

describe("GradingCoordinator", () => {
  it("runs the rule grader, delegates to its judge sub-agent and records both verdicts", async () => {
    await seed("gc", [["g1", "gc-run", SIMPLE, "Juniper, of course."], ["g2", "gc-run", NEVER, "It's right that you never told me."]], []);
    const stub = await getAgentByName<Env, GradingCoordinator>(env.GradingCoordinator as never, "gc-test");
    const answers = [
      { id: "g1", conversationId: "main-01", questionId: "q-simple", question: SIMPLE.question, expected: SIMPLE.expected,
        outdated: SIMPLE.outdated, answer: "Juniper, of course.", storedRuleVerdict: "right" },
      { id: "g2", conversationId: "main-01", questionId: "q-never1", question: NEVER.question, expected: NEVER.expected,
        outdated: NEVER.outdated, answer: "It's right that you never told me.", storedRuleVerdict: "right" }
    ];
    expect(await stub.gradeAnswers("gc-job", answers)).toEqual({ graded: 2, ruleMismatches: [] });
    const children = await runInDurableObject(stub, async (c: GradingCoordinator) => c.dynamicAgents.list());
    expect(children.map((c) => [c.className, c.name])).toEqual([["Judge", "judge"]]);
    const rows = await env.DB.prepare(
      "SELECT answer_id, verdict, rule_verdict, grader_version FROM judge_verdicts WHERE job_id = 'gc-job' ORDER BY answer_id"
    ).all();
    // Mock judge: "right" only when the reply contains the word "right".
    expect(rows.results).toEqual([
      { answer_id: "g1", verdict: "wrong", rule_verdict: "right", grader_version: GRADER_VERSION },
      { answer_id: "g2", verdict: "right", rule_verdict: "right", grader_version: GRADER_VERSION }
    ]);
  });
});

describe("JudgeRunner", () => {
  async function runJob(id: string, scope: "blind" | "all", rejudge = false) {
    await using instance = await introspectWorkflowInstance(env.JUDGE_RUNNER, id);
    await env.JUDGE_RUNNER.create({ id, params: { jobId: id, experimentId: "jx", scope, rejudge } });
    await instance.waitForStatus("complete");
    return instance.getOutput() as Promise<{ judged: number; ruleMismatches: string[] }>;
  }

  it("feeds the blind sample, then only what is left, through the coordinator", async () => {
    await seed(
      "jx",
      [
        ["j1", "jr-run-1", SIMPLE, "That is right: Juniper."],
        ["j2", "jr-run-1", NEVER, "You never told me its breed."],
        ["j3", "jr-run-2", SIMPLE, "It's right here: Rex."]
      ],
      ["j1", "j2"]
    );
    expect(await runJob("job-blind", "blind")).toMatchObject({ judged: 2, ruleMismatches: [] });
    // j3's stored rule verdict says right; the coordinator's own rule grade says wrong.
    expect(await runJob("job-all", "all")).toMatchObject({ judged: 1, ruleMismatches: ["j3"] });
    expect((await runJob("job-again", "blind", true)).judged).toBe(2);
    const rows = await env.DB.prepare(
      "SELECT answer_id, verdict, rule_verdict, job_id, neurons FROM judge_verdicts WHERE answer_id LIKE 'j%' ORDER BY answer_id"
    ).all<{ answer_id: string; verdict: string; rule_verdict: string; job_id: string; neurons: number }>();
    expect(rows.results.map((r) => [r.answer_id, r.verdict, r.rule_verdict, r.job_id])).toEqual([
      ["j1", "right", "right", "job-again"],
      ["j2", "wrong", "right", "job-again"],
      ["j3", "right", "wrong", "job-all"]
    ]);
    expect(rows.results.every((r) => r.neurons > 0)).toBe(true);
  });
});
