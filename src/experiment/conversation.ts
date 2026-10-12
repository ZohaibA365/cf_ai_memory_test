import { z } from "zod";

// The format of a test conversation. A conversation is an ordered list of
// steps the runner plays into an agent:
//
// - "say":    a user message that gets a real model reply (planting a fact,
//             changing one, or ordinary chat). The design sees it as a turn.
// - "filler": unrelated small talk inserted with addMessages(), no model
//             call. `pairs` user/assistant exchanges taken from the shared,
//             pre-generated filler pool (data/filler.json).
// - "ask":    a scored question with a known correct answer.
//
// Answers are matched after normalization (see grader.ts). `expected` is a
// list of groups: every group must match, and a group matches when any one
// of its alternatives appears. That covers simple facts (one group with a
// few spellings) and combined facts (one group per fact).

export const QUESTION_TYPES = ["simple", "changed", "exact", "combine", "never"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const alternatives = z.array(z.string().min(1)).min(1);

const say = z.object({
  kind: z.literal("say"),
  id: z.string().min(1),
  text: z.string().min(1),
  purpose: z.enum(["plant", "change", "chat"])
});

const filler = z.object({
  kind: z.literal("filler"),
  pairs: z.number().int().positive()
});

const ask = z
  .object({
    kind: z.literal("ask"),
    id: z.string().min(1),
    question: z.string().min(1),
    type: z.enum(QUESTION_TYPES),
    /** Groups that must all match. Empty for "never" questions. */
    expected: z.array(alternatives),
    /** Answers that were true once, or plausible confusions. */
    outdated: z.array(z.string().min(1)).default([]),
    /** Ids of the "say" steps this question depends on. */
    dependsOn: z.array(z.string()).default([])
  })
  .superRefine((q, ctx) => {
    if (q.type === "never" && q.expected.length > 0) {
      ctx.addIssue({ code: "custom", message: `${q.id}: a "never" question has no expected answer` });
    }
    if (q.type !== "never" && q.expected.length === 0) {
      ctx.addIssue({ code: "custom", message: `${q.id}: needs at least one expected group` });
    }
    if (q.type === "changed" && q.outdated.length === 0) {
      ctx.addIssue({ code: "custom", message: `${q.id}: a "changed" question needs the outdated value` });
    }
    if (q.type === "combine" && q.expected.length < 2) {
      ctx.addIssue({ code: "custom", message: `${q.id}: a "combine" question needs two or more facts` });
    }
  });

export const stepSchema = z.discriminatedUnion("kind", [say, filler, ask]);

export const conversationSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    /**
     * "pilot" conversations only set parameters (stage 4) and never appear in
     * reported results; the full run uses new "main" conversations, so the
     * experiment is never tuned and reported on the same data.
     */
    split: z.enum(["pilot", "main"]),
    steps: z.array(stepSchema).min(1)
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    const sayIds = new Set<string>();
    c.steps.forEach((step, i) => {
      // Small talk before every question, so one question's answer is not
      // sitting in recent history for the next.
      if (step.kind === "ask" && c.steps[i - 1]?.kind !== "filler") {
        ctx.addIssue({ code: "custom", message: `${step.id} must come right after a filler step` });
      }
    });
    for (const step of c.steps) {
      if (step.kind === "filler") continue;
      if (ids.has(step.id)) ctx.addIssue({ code: "custom", message: `duplicate step id ${step.id}` });
      ids.add(step.id);
      if (step.kind === "say") sayIds.add(step.id);
      // A question may only depend on things already said.
      if (step.kind === "ask") {
        for (const dep of step.dependsOn) {
          if (!sayIds.has(dep)) {
            ctx.addIssue({ code: "custom", message: `${step.id} depends on ${dep}, which is not said before it` });
          }
        }
      }
    }
  });

export type Conversation = z.infer<typeof conversationSchema>;
export type Step = z.infer<typeof stepSchema>;
export type AskStep = Extract<Step, { kind: "ask" }>;

export const fillerPairSchema = z.object({
  user: z.string().min(1),
  assistant: z.string().min(1)
});
export const fillerPoolSchema = z.object({
  generatedAt: z.string(),
  model: z.string(),
  pairs: z.array(fillerPairSchema).min(1)
});
export type FillerPair = z.infer<typeof fillerPairSchema>;

/**
 * The filler pairs a conversation uses, in order. Each conversation starts
 * at its own offset in the pool so conversations don't share small talk, and
 * `scale` lets the pilot stretch every conversation without editing files.
 */
export function fillerFor(
  conversation: Conversation,
  pool: FillerPair[],
  scale = 1
): FillerPair[][] {
  let cursor = offsetFor(conversation.id, pool.length);
  const blocks: FillerPair[][] = [];
  for (const step of conversation.steps) {
    if (step.kind !== "filler") continue;
    const count = Math.max(1, Math.round(step.pairs * scale));
    const block: FillerPair[] = [];
    for (let i = 0; i < count; i++) {
      block.push(pool[cursor % pool.length]);
      cursor++;
    }
    blocks.push(block);
  }
  return blocks;
}

/** Stable offset from the conversation id (FNV-1a hash). */
export function offsetFor(id: string, poolSize: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % poolSize;
}
