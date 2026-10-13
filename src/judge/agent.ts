import { Agent } from "agents";
import { generateText, type LanguageModel } from "ai";
import { createMockJudgeModel } from "../ai/mock-model";
import { createChatModel } from "../ai/model";
import { JUDGE_MODEL, judgeSystemPrompt, judgeUserPrompt, parseVerdict, type JudgeItem } from "./prompt";

export interface JudgeResult {
  /** null when the judge's output could not be parsed after a retry. */
  verdict: "right" | "wrong" | null;
  reason: string;
  model: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
}

// Room for gpt-oss-120b's reasoning before the two-line verdict.
const MAX_OUTPUT_TOKENS = 1500;

/** One grading call with one retry on malformed output. Exported for tests. */
export async function judgeWith(model: LanguageModel, item: JudgeItem): Promise<JudgeResult> {
  const system = judgeSystemPrompt();
  const prompt = judgeUserPrompt(item);
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await generateText({ model, system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });
    inputTokens += r.usage.inputTokens ?? 0;
    outputTokens += r.usage.outputTokens ?? 0;
    const v = parseVerdict(r.text);
    if (v) return { ...v, model: JUDGE_MODEL, attempts: attempt, inputTokens, outputTokens };
  }
  return { verdict: null, reason: "unparsed judge output", model: JUDGE_MODEL, attempts: 2, inputTokens, outputTokens };
}

/**
 * The AI judge: a sub-agent (dynamic agent) of GradingCoordinator, which
 * spawns it with this.dynamicAgents.get(Judge, …) and is the only way to
 * reach it. It has no Durable Object binding of its own. Grades one answer
 * per call and holds no state.
 */
export class Judge extends Agent<Env> {
  async judge(item: JudgeItem): Promise<JudgeResult> {
    const model = (this.env.MODEL_MODE as string) === "mock" ? createMockJudgeModel() : createChatModel(this.env.AI, JUDGE_MODEL);
    return judgeWith(model, item);
  }
}
