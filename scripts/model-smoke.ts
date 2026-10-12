// Model tool-call smoke test. Picks the cheapest Workers AI model that
// reliably saves facts with set_context, which the built-in memory design
// depends on. Runs from Node against the real (remote, billed) AI binding.
//
//   npm run smoke:models            # all candidates, 3 trials per case
//   npm run smoke:models -- 1       # 1 trial per case (cheaper)
//
// Uses the real set_context tool and system prompt rendering from
// agents/context with the built-in design's memory block, so the model sees
// what it would see in the agent. Results go to results/model-smoke.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { ContextBlocks } from "agents/context";
import { generateText, stepCountIs } from "ai";
import { getPlatformProxy } from "wrangler";
import { createChatModel } from "../src/ai/model";
import { logCost } from "./cost-log";
import { CostMeter } from "./cost-meter";
import { SYSTEM_PROMPT } from "../src/config";
import { builtinDesign } from "../src/memory/builtin";
import { MODEL_PRICES, neurons, neuronsToUsd, PRICING_DATE } from "../src/pricing";
import {
  isReliable,
  RELIABLE_PASS_RATE,
  SMOKE_CASES,
  summarize,
  type TrialResult
} from "./smoke-score";

const trialsPerCase = Number(process.argv[2] ?? 3);

// Cheapest first by a blend of 10 input tokens per output token, roughly the
// shape of a chat turn with history.
const candidates = Object.entries(MODEL_PRICES)
  .sort(
    ([, a], [, b]) =>
      a.inputNeuronsPerM * 10 + a.outputNeuronsPerM - (b.inputNeuronsPerM * 10 + b.outputNeuronsPerM)
  )
  .map(([id]) => id);

function memoryBlocks() {
  let stored = "";
  const memoryConfig = builtinDesign.contextBlocks()[0];
  return new ContextBlocks([
    { label: "instructions", provider: { get: async () => SYSTEM_PROMPT } },
    {
      ...memoryConfig,
      provider: {
        get: async () => stored || null,
        set: async (content: string) => {
          stored = content;
        }
      }
    }
  ]);
}

async function runTrial(ai: Ai, model: string, caseIndex: number, trial: number): Promise<TrialResult> {
  const testCase = SMOKE_CASES[caseIndex];
  const blocks = memoryBlocks();
  const system = await blocks.freezeSystemPrompt();
  const tools = await blocks.tools();
  const started = Date.now();
  const base = {
    model,
    caseId: testCase.id,
    trial,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0
  };
  try {
    const result = await generateText({
      model: createChatModel(ai, model),
      system,
      messages: [
        { role: "user", content: "Hi! Can you help me keep track of a few things?" },
        { role: "assistant", content: "Of course! Tell me what you'd like me to remember." },
        { role: "user", content: testCase.message }
      ],
      tools,
      stopWhen: stepCountIs(3)
    });
    return {
      ...base,
      toolCalls: result.steps.flatMap((s) =>
        s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input }))
      ),
      text: result.text,
      error: null,
      latencyMs: Date.now() - started,
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0
    };
  } catch (error) {
    return {
      ...base,
      toolCalls: [],
      text: "",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started
    };
  }
}

async function main() {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
  const ai = proxy.env.AI;
  const allTrials: TrialResult[] = [];
  const summaries = [];
  const meter = new CostMeter("model-smoke");
  try {
    for (const model of candidates) {
      const trials: TrialResult[] = [];
      for (let c = 0; c < SMOKE_CASES.length; c++) {
        for (let t = 0; t < trialsPerCase; t++) {
          const trial = await runTrial(ai, model, c, t);
          meter.add(model, trial);
          trials.push(trial);
        }
      }
      const summary = summarize(model, trials, SMOKE_CASES);
      const n = neurons(model, summary.inputTokens, summary.outputTokens);
      summaries.push({ ...summary, neurons: Math.round(n), usd: neuronsToUsd(n), reliable: isReliable(summary) });
      allTrials.push(...trials);
      console.log(
        `${model}: ${summary.passed}/${summary.trials} saved, ${summary.errors} errors, ` +
          `${summary.emptyReplies} empty replies, median ${summary.medianLatencyMs} ms, ` +
          `${Math.round(n)} neurons`
      );
    }
  } finally {
    await proxy.dispose();
    logCost(meter, `${trialsPerCase} trials per case`);
  }

  const chosen = summaries.find((s) => s.reliable)?.model ?? null;
  console.log(
    chosen
      ? `\nCheapest reliable model (>= ${RELIABLE_PASS_RATE * 100}% saved, no errors): ${chosen}`
      : "\nNo candidate was reliable."
  );
  mkdirSync("results", { recursive: true });
  writeFileSync(
    "results/model-smoke.json",
    JSON.stringify(
      { ranAt: new Date().toISOString(), pricingDate: PRICING_DATE, trialsPerCase, chosen, summaries, trials: allTrials },
      null,
      2
    ) + "\n"
  );
}

await main();
