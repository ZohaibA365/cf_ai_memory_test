// One-time generator for the shared filler pool (data/filler.json): short,
// impersonal user/assistant exchanges on everyday topics. The output is
// committed so every run of the experiment uses exactly the same text.
// Re-running it replaces the pool, which changes the experiment; only do
// that before the full run.
//
//   npm run generate:filler                 # regenerate data/filler.json
//   npm run generate:filler -- --measure 4  # cost check only, writes no filler
//
// Uses the experiment model through the remote AI binding (billed). Every run
// appends its neuron cost to results/model-costs.jsonl. The original run
// (2026-10-12) did not record usage; `--measure` reruns the same prompt on a
// few evenly spaced topics and logs an estimate for it, scaled to 40 topics.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateText } from "ai";
import { appendCostRecords, logCost } from "./cost-log";
import { CostMeter } from "./cost-meter";
import { getPlatformProxy } from "wrangler";
import { createChatModel } from "../src/ai/model";
import { MODEL_ID } from "../src/config";
import {
  conversationSchema,
  fillerPairSchema,
  type Conversation,
  type FillerPair
} from "../src/experiment/conversation";
import { answerPhrases, hasPersonalDetail } from "../src/experiment/filler-check";
import { mentions } from "../src/experiment/grader";

const TOPICS = [
  "how rainbows form", "the history of the printing press", "tips for keeping houseplants alive",
  "how bread rises", "why the sky is blue", "the rules of cricket", "how vaccines train the immune system",
  "the planets of the solar system", "how to brew good coffee", "the life cycle of a butterfly",
  "how airplanes stay in the air", "the origins of chess", "how tides work", "making a budget spreadsheet",
  "the history of the bicycle", "how volcanoes erupt", "learning a new language", "the water cycle",
  "how photosynthesis works", "basic knife skills in the kitchen", "the Great Wall of China",
  "how batteries store energy", "choosing a good book to read", "the history of jazz", "how bees make honey",
  "stretching after exercise", "how the internet routes data", "the Roman aqueducts", "composting at home",
  "how lighthouses work", "the basics of photography", "why leaves change color", "how glass is made",
  "the history of the Olympic Games", "how clouds form", "writing a clear email", "the deep ocean",
  "how maps are made", "the invention of the telephone", "how to fold a paper crane"
];
const PAIRS_PER_TOPIC = 10;

function loadConversations(): Conversation[] {
  return readdirSync("data/conversations")
    .filter((f) => f.endsWith(".json"))
    .map((f) => conversationSchema.parse(JSON.parse(readFileSync(`data/conversations/${f}`, "utf8"))));
}

function parsePairs(text: string): FillerPair[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown[];
    return raw.flatMap((r) => {
      const parsed = fillerPairSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

const measureIndex = process.argv.indexOf("--measure");
const measureTopics = measureIndex === -1 ? 0 : Number(process.argv[measureIndex + 1] ?? 4);

/** Evenly spaced topics, so a measurement is not just the first few. */
function sampleTopics(n: number): string[] {
  const step = TOPICS.length / n;
  return Array.from({ length: n }, (_, i) => TOPICS[Math.floor(i * step)]);
}

async function main() {
  // Never let filler mention an answer from any existing conversation.
  const blocked = loadConversations().flatMap(answerPhrases);
  const topics = measureTopics > 0 ? sampleTopics(measureTopics) : TOPICS;
  const meter = new CostMeter(measureTopics > 0 ? "generate-filler --measure" : "generate-filler");
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
  const model = createChatModel(proxy.env.AI);
  const pairs: FillerPair[] = [];
  try {
    for (const topic of topics) {
      let kept: FillerPair[] = [];
      for (let attempt = 1; attempt <= 3 && kept.length < PAIRS_PER_TOPIC; attempt++) {
        const { text, usage } = await generateText({
          model,
          prompt:
            `Write ${PAIRS_PER_TOPIC} short exchanges between a curious user and a friendly assistant about ${topic}. ` +
            "Each exchange is one general-knowledge question from the user and a 1-3 sentence answer. " +
            "The user must never share anything about themselves: no names, pets, family, friends, jobs, " +
            "where they live, plans, dates, codes or numbers about their life. " +
            'Reply with only a JSON array like [{"user": "...", "assistant": "..."}].'
        });
        meter.add(MODEL_ID, usage);
        const fresh = parsePairs(text).filter(
          (p) =>
            !hasPersonalDetail(p.user) &&
            !hasPersonalDetail(p.assistant) &&
            !blocked.some((phrase) => mentions(p.user, phrase) || mentions(p.assistant, phrase))
        );
        kept = [...kept, ...fresh].slice(0, PAIRS_PER_TOPIC);
      }
      console.log(`${topic}: ${kept.length} pairs`);
      pairs.push(...kept);
    }
  } finally {
    await proxy.dispose();
    logCost(meter, measureTopics > 0 ? `${topics.length} sample topics` : `${topics.length} topics`);
  }

  if (measureTopics > 0) {
    logOriginalRunEstimate(meter, topics.length);
    return;
  }
  writeFileSync(
    "data/filler.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL_ID, pairs }, null, 2) + "\n"
  );
  console.log(`\n${pairs.length} pairs written to data/filler.json`);
}

/** Scales a measurement up to the original 40-topic run and logs it as an estimate. */
function logOriginalRunEstimate(meter: CostMeter, measured: number) {
  const original = JSON.parse(readFileSync("data/filler.json", "utf8")) as { generatedAt: string };
  const factor = TOPICS.length / measured;
  const records = meter.records().map((r) => ({
    ...r,
    script: "generate-filler",
    ranAt: original.generatedAt,
    calls: Math.round(r.calls * factor),
    inputTokens: Math.round(r.inputTokens * factor),
    outputTokens: Math.round(r.outputTokens * factor),
    neurons: Math.round(r.neurons * factor * 10) / 10,
    usd: Math.round(r.usd * factor * 1e6) / 1e6,
    basis: "estimated" as const,
    note: `original run did not record usage; scaled from a ${measured}-topic measurement on ${new Date().toISOString().slice(0, 10)}`
  }));
  appendCostRecords(records);
  const n = records.reduce((s, r) => s + r.neurons, 0);
  console.log(`Estimated cost of the original ${TOPICS.length}-topic run: ${n.toFixed(0)} neurons (logged as estimated)`);
}

await main();
