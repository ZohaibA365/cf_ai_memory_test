// Diagnostic for the built-in design's compaction summarizer: how much of the
// output allowance goes to thinking versus summary text, with and without
// Qwen3's /no_think switch. Logs its cost.
//
//   npm run debug:summary

import { generateText } from "ai";
import { getPlatformProxy } from "wrangler";
import { createChatModel } from "../src/ai/model";
import { MODEL_ID } from "../src/config";
import { loadFillerPoolFromDisk } from "./filler-disk";
import { logCost } from "./cost-log";
import { CostMeter } from "./cost-meter";

const transcript = loadFillerPoolFromDisk()
  .slice(0, 12)
  .map((p) => `user: ${p.user}\nassistant: ${p.assistant}`)
  .join("\n");
const base =
  "Summarize this conversation for later reference. Keep every fact the user stated about themselves.\n\n" +
  `User: My dog is called Biscuit and I live in Toronto.\n${transcript}`;

const variants = [
  { name: "cap 400", maxOutputTokens: 400, prompt: base },
  { name: "cap 2000", maxOutputTokens: 2000, prompt: base },
  { name: "cap 400 + /no_think", maxOutputTokens: 400, prompt: `${base}\n\n/no_think` }
];

async function main() {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
  const meter = new CostMeter("debug-summary");
  try {
    const model = createChatModel(proxy.env.AI);
    for (const v of variants) {
      const r = await generateText({ model, prompt: v.prompt, maxOutputTokens: v.maxOutputTokens });
      meter.add(MODEL_ID, r.usage);
      console.log(
        `${v.name.padEnd(20)} finish=${r.finishReason.padEnd(7)} out=${r.usage.outputTokens} ` +
          `reasoning chars=${(r.reasoningText ?? "").length} summary chars=${r.text.trim().length} ` +
          `mentions Biscuit=${/biscuit/i.test(r.text)}`
      );
    }
  } finally {
    await proxy.dispose();
    logCost(meter, "summarizer thinking check");
  }
}

await main();
