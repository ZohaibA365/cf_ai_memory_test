import { streamText, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createChatModel, withoutReasoning } from "../src/ai/model";

// What Qwen3 streamed live after a tool call: reasoning inline as text, in
// dual-format chunks (both native `response` and OpenAI `choices[0].delta`).
function fakeAi(pieces: string[]): Ai {
  const sse =
    pieces
      .map((p) => `data: ${JSON.stringify({ response: p, choices: [{ delta: { content: p } }] })}\n\n`)
      .join("") +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return {
    run: async () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        }
      })
  } as unknown as Ai;
}

describe("createChatModel", () => {
  it("moves inline <think> text out of the answer, without doubling", async () => {
    const result = streamText({
      model: createChatModel(fakeAi(["<thi", "nk>\nI should save", " this.\n</think>\n\n", "Saved", " it!"])),
      prompt: "hi"
    });
    expect((await result.text).trim()).toBe("Saved it!");
    expect(await result.reasoningText).toContain("I should save this.");
  });
});

describe("withoutReasoning", () => {
  it("drops reasoning parts and reasoning-only messages from history", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "long thinking" },
          { type: "text", text: "Hello!" }
        ]
      },
      { role: "assistant", content: [{ type: "reasoning", text: "only thinking" }] },
      { role: "assistant", content: "plain string reply" }
    ];
    expect(withoutReasoning(history)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "assistant", content: "plain string reply" }
    ]);
  });
});
