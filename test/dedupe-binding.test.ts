import { describe, expect, it } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import { dedupeChunk, dedupeWorkersAI } from "../src/ai/dedupe-binding";

// What Workers AI streams for affected models: every chunk carries the same
// content twice, once in native fields and once in OpenAI `choices[0].delta`.
const toolCall = {
  index: 0,
  id: "call_1",
  type: "function",
  function: { name: "set_context", arguments: '{"label":"memory"}' }
};
const dualFormatChunks = [
  { response: "Hello", choices: [{ delta: { content: "Hello" } }] },
  { response: " world", choices: [{ delta: { content: " world" } }] },
  // Captured live: digit tokens arrive with `response` as a JSON number.
  { response: " ", choices: [{ delta: { content: " " } }] },
  { response: 2, choices: [{ delta: { content: "2" } }] },
  { response: 2, choices: [{ delta: { content: "2" } }] },
  { response: 9, choices: [{ delta: { content: "9" } }] },
  { response: 1, choices: [{ delta: { content: "1" } }] },
  { tool_calls: [toolCall], choices: [{ delta: { tool_calls: [toolCall] } }] },
  {
    response: "",
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  }
];

// Splits the SSE text into 7-byte pieces so lines straddle chunk boundaries.
function sseStream(chunks: object[]): ReadableStream<Uint8Array> {
  const text =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    }
  });
}

function fakeAi(): Ai {
  return { run: async () => sseStream(dualFormatChunks) } as unknown as Ai;
}

async function streamThroughProvider(binding: Ai) {
  const model = createWorkersAI({ binding })("@cf/qwen/qwen3-30b-a3b-fp8");
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    tools: [
      {
        type: "function",
        name: "set_context",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  });
  let text = "";
  const toolInputs: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text-delta") text += value.delta;
    if (value.type === "tool-call") toolInputs.push(value.input);
  }
  return { text, toolInputs };
}

describe("dedupeWorkersAI", () => {
  it("documents the upstream bug: without the wrapper, text is doubled", async () => {
    // If this starts failing, workers-ai-provider has fixed the bug and
    // src/ai/dedupe-binding.ts can be deleted.
    const { text } = await streamThroughProvider(fakeAi());
    expect(text).toBe("HelloHello world world  22229911");
  });

  it("with the wrapper, text and tool-call arguments arrive once", async () => {
    const { text, toolInputs } = await streamThroughProvider(
      dedupeWorkersAI(fakeAi())
    );
    expect(text).toBe("Hello world 2291");
    expect(toolInputs).toEqual(['{"label":"memory"}']);
  });

  it("leaves single-format chunks alone", () => {
    expect(dedupeChunk({ response: "Hi" })).toBeNull();
    expect(dedupeChunk({ choices: [{ delta: { content: "Hi" } }] })).toBeNull();
    // Native text with an empty OpenAI delta must not be dropped.
    expect(
      dedupeChunk({ response: "Hi", choices: [{ delta: { content: "" } }] })
    ).toBeNull();
  });

  it("passes non-run members through to the real binding", async () => {
    const real = {
      run: async () => ({ response: "plain" }),
      gateway: (id: string) => `gateway:${id}`
    } as unknown as Ai;
    const wrapped = dedupeWorkersAI(real);
    expect((wrapped as any).gateway("x")).toBe("gateway:x");
    expect(await wrapped.run("@cf/any" as any, {} as any)).toEqual({
      response: "plain"
    });
  });
});
