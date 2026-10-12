import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/config";
import type { ChatAgent } from "../src/server";

// A fake model that streams one fixed reply, so tests never call Workers AI.
function mockModel(reply: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: reply },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 12,
                noCache: 12,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 4, text: 4, reasoning: 0 }
            }
          }
        ]
      })
    })
  });
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text" as const, text }]
  };
}

function textOf(message: { parts: Array<{ type: string; text?: string }> }) {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

describe("ChatAgent", () => {
  it("answers a message and keeps both sides of the chat", async () => {
    const stub = await getAgentByName(env.ChatAgent, "smoke-test");

    const outcome = await runInDurableObject(stub, async (agent: ChatAgent) => {
      const model = mockModel("Hello there!");
      agent.modelOverride = model;
      const result = await agent.saveMessages([userMessage("Hi")]);
      return {
        status: result.status,
        error: result.error,
        transcript: agent.messages.map((m) => ({
          role: m.role,
          text: textOf(m)
        })),
        promptSentToModel: JSON.stringify(model.doStreamCalls[0]?.prompt)
      };
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("completed");
    expect(outcome.transcript).toEqual([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello there!" }
    ]);
    expect(outcome.promptSentToModel).toContain(SYSTEM_PROMPT);
  });

  it("keeps separate instances separate", async () => {
    const a = await getAgentByName(env.ChatAgent, "visitor-a");
    const b = await getAgentByName(env.ChatAgent, "visitor-b");

    await runInDurableObject(a, async (agent: ChatAgent) => {
      agent.modelOverride = mockModel("ok");
      await agent.saveMessages([userMessage("My dog is called Rex.")]);
    });

    const bMessages = await runInDurableObject(
      b,
      async (agent: ChatAgent) => agent.messages.length
    );
    expect(bMessages).toBe(0);
  });
});
