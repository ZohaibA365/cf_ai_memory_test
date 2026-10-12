// Diagnostic: captures the raw SSE events Workers AI streams for the
// experiment model, before any provider parsing, so stream-format problems
// (like duplicated chunks) can be seen directly. Writes
// results/debug-stream.json and logs its cost.
//
//   npm run debug:stream -- "Repeat exactly: flight UA 2291 on March 14."

import { mkdirSync, writeFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { MODEL_ID } from "../src/config";
import { logCost } from "./cost-log";
import { CostMeter } from "./cost-meter";

const prompt = process.argv[2] ?? "Repeat exactly: my flight is UA 2291, leaving on March 14.";

async function main() {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" });
  const meter = new CostMeter("debug-stream");
  const events: unknown[] = [];
  try {
    const stream = (await proxy.env.AI.run(MODEL_ID as never, {
      messages: [{ role: "user", content: prompt }],
      stream: true
    } as never)) as unknown as ReadableStream<Uint8Array>;
    const text = await new Response(stream).text();
    for (const line of text.split("\n")) {
      const data = line.replace(/^data:\s?/, "").trim();
      if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        events.push({ unparsed: data });
      }
    }
    const usage = [...events].reverse().find((e) => (e as { usage?: unknown }).usage) as
      | { usage: { prompt_tokens?: number; completion_tokens?: number } }
      | undefined;
    meter.add(MODEL_ID, {
      inputTokens: usage?.usage.prompt_tokens ?? 0,
      outputTokens: usage?.usage.completion_tokens ?? 0
    });
  } finally {
    await proxy.dispose();
    logCost(meter, "raw stream capture");
  }
  mkdirSync("results", { recursive: true });
  writeFileSync("results/debug-stream.json", JSON.stringify({ model: MODEL_ID, prompt, events }, null, 2) + "\n");

  // Summarize what each event carries.
  for (const e of events as Record<string, unknown>[]) {
    const delta = (e.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0]?.delta;
    console.log(
      JSON.stringify({
        response: e.response,
        content: delta?.content,
        reasoning: delta?.reasoning_content ?? delta?.reasoning
      })
    );
  }
}

await main();
