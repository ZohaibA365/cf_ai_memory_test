import { describe, expect, it } from "vitest";
import {
  conversationSchema,
  fillerFor,
  offsetFor,
  QUESTION_TYPES,
  type Conversation
} from "../src/experiment/conversation";
import { loadConversations, loadFillerPool } from "../src/experiment/data";
import { answerLeaks, hasPersonalDetail } from "../src/experiment/filler-check";

const conversations = loadConversations();
const pool = loadFillerPool();

describe("committed test data", () => {
  it("has the three seed conversations, each covering every question type", () => {
    expect(conversations.map((c) => c.id)).toEqual(["seed-01", "seed-02", "seed-03"]);
    for (const c of conversations) {
      const types = new Set(c.steps.flatMap((s) => (s.kind === "ask" ? [s.type] : [])));
      expect([...types].sort()).toEqual([...QUESTION_TYPES].sort());
    }
  });

  it("has a filler pool with no personal details", () => {
    expect(pool.length).toBeGreaterThanOrEqual(300);
    const personal = pool.filter((p) => hasPersonalDetail(p.user) || hasPersonalDetail(p.assistant));
    expect(personal).toEqual([]);
  });

  // The pilot may stretch conversations, so check longer versions too.
  it.each([1, 2, 4])("never leaks an answer into a conversation's filler (scale %d)", (scale) => {
    for (const c of conversations) {
      expect(answerLeaks(c, pool, scale), c.id).toEqual([]);
    }
  });
});

describe("conversation schema", () => {
  const base: Conversation = {
    id: "t",
    title: "t",
    steps: [
      { kind: "say", id: "s", text: "My dog is Rex.", purpose: "plant" },
      { kind: "filler", pairs: 2 },
      { kind: "ask", id: "q", question: "Dog?", type: "simple", expected: [["Rex"]], outdated: [], dependsOn: ["s"] }
    ]
  };
  const issues = (c: unknown) => {
    const r = conversationSchema.safeParse(c);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("accepts a valid conversation", () => {
    expect(issues(base)).toEqual([]);
  });

  it("rejects a question with no small talk before it", () => {
    const steps = [base.steps[0], base.steps[2]];
    expect(issues({ ...base, steps }).join()).toMatch(/right after a filler step/);
  });

  it("rejects depending on something not yet said", () => {
    const steps = [base.steps[1], base.steps[2], base.steps[0]];
    expect(issues({ ...base, steps }).join()).toMatch(/not said before it/);
  });

  it("enforces per-type rules", () => {
    const ask = base.steps[2];
    const withAsk = (over: object) => ({ ...base, steps: [base.steps[0], base.steps[1], { ...ask, ...over }] });
    expect(issues(withAsk({ type: "never" })).join()).toMatch(/no expected answer/);
    expect(issues(withAsk({ type: "changed" })).join()).toMatch(/outdated value/);
    expect(issues(withAsk({ type: "combine" })).join()).toMatch(/two or more facts/);
  });
});

describe("fillerFor", () => {
  const pool3 = [
    { user: "a", assistant: "A" },
    { user: "b", assistant: "B" },
    { user: "c", assistant: "C" }
  ];
  const conv: Conversation = {
    id: "x",
    title: "x",
    steps: [
      { kind: "filler", pairs: 2 },
      { kind: "say", id: "s", text: "hi", purpose: "chat" },
      { kind: "filler", pairs: 2 }
    ]
  };

  it("takes consecutive pairs from a stable offset, wrapping around", () => {
    const start = offsetFor("x", 3);
    const blocks = fillerFor(conv, pool3);
    const flat = blocks.flat().map((p) => p.user);
    expect(blocks.map((b) => b.length)).toEqual([2, 2]);
    expect(flat).toEqual([0, 1, 2, 3].map((i) => pool3[(start + i) % 3].user));
    expect(fillerFor(conv, pool3)).toEqual(blocks);
  });

  it("scales block sizes for the pilot", () => {
    expect(fillerFor(conv, pool3, 2.5).map((b) => b.length)).toEqual([5, 5]);
  });
});
