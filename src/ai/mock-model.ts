import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

// A fake model for tests of the whole pipeline (runner, agents, D1) without
// calling Workers AI. Selected only when MODEL_MODE is "mock", which only the
// test config sets. It repeats the user's latest message back, so answers are
// deterministic and grading has something to work on.

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 }
};

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    return m.content
      .map((p: { type?: string; text?: string }) => (p.type === "text" ? p.text : ""))
      .join("");
  }
  return "";
}

export function createMockModel() {
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: async ({ prompt }) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: `Mock reply to: ${lastUserText(prompt)}` },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }
        ]
      })
    }),
    doGenerate: async () => ({
      content: [{ type: "text", text: "Mock summary of the earlier conversation." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: []
    })
  });
}
