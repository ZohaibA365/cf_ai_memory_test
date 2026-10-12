// One-time generator for the shared filler pool (data/filler.json): short,
// impersonal user/assistant exchanges on everyday topics. The output is
// committed so every run of the experiment uses exactly the same text.
// Re-running it replaces the pool, which changes the experiment; only do
// that before the full run.
//
//   npm run generate:filler
//
// Uses the experiment model through the remote AI binding (billed, roughly
// a few thousand neurons in total).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateText } from "ai";
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

async function main() {
  // Never let filler mention an answer from any existing conversation.
  const blocked = loadConversations().flatMap(answerPhrases);
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
  const model = createChatModel(proxy.env.AI);
  const pairs: FillerPair[] = [];
  try {
    for (const topic of TOPICS) {
      let kept: FillerPair[] = [];
      for (let attempt = 1; attempt <= 3 && kept.length < PAIRS_PER_TOPIC; attempt++) {
        const { text } = await generateText({
          model,
          prompt:
            `Write ${PAIRS_PER_TOPIC} short exchanges between a curious user and a friendly assistant about ${topic}. ` +
            "Each exchange is one general-knowledge question from the user and a 1-3 sentence answer. " +
            "The user must never share anything about themselves: no names, pets, family, friends, jobs, " +
            "where they live, plans, dates, codes or numbers about their life. " +
            'Reply with only a JSON array like [{"user": "...", "assistant": "..."}].'
        });
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
  }
  writeFileSync(
    "data/filler.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL_ID, pairs }, null, 2) + "\n"
  );
  console.log(`\n${pairs.length} pairs written to data/filler.json`);
}

await main();
