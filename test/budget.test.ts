import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { CONTEXT_BUDGET_TOKENS as B } from "../src/config";
import type { MemoryAgent } from "../src/memory/agent";
import { estimateMessageTokens, fitToBudget } from "../src/memory/tokens";
import { estimateCall, filler, scriptedModel, userMessage } from "./helpers";

// The fairness rule: every design gets the same maximum number of tokens per
// model call. These tests measure what actually reached the (mock) model.

const text = (role: "user" | "assistant", t: string): ModelMessage => ({
  role,
  content: [{ type: "text", text: t }]
});

describe("fitToBudget", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    text(i % 2 ? "assistant" : "user", `message number ${i} `.repeat(10))
  );

  it("keeps the newest messages and drops the oldest", () => {
    const fit = fitToBudget({ system: "sys", messages: many, toolTokens: 0 }, 300);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(300);
    expect(fit.messages.at(-1)).toBe(many.at(-1));
    expect(fit.droppedMessages).toBeGreaterThan(0);
    expect(fit.messages).toEqual(many.slice(fit.droppedMessages));
  });

  it("counts the system prompt and tool definitions against the budget", () => {
    const plain = fitToBudget({ system: "", messages: many, toolTokens: 0 }, 300);
    const heavy = fitToBudget({ system: "x".repeat(400), messages: many, toolTokens: 50 }, 300);
    expect(heavy.messages.length).toBeLessThan(plain.messages.length);
    expect(heavy.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it("never drops the newest message, even when it alone is over budget", () => {
    const huge = text("user", "y".repeat(10_000));
    const fit = fitToBudget({ system: "", messages: [huge], toolTokens: 0 }, 100);
    expect(fit.messages).toEqual([huge]);
    expect(fit.estimatedTokens).toBeGreaterThan(100);
  });

  it("never starts the window with an orphaned tool result", () => {
    const toolResult: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "set_context",
          output: { type: "text", value: "ok" }
        }
      ]
    };
    const last = text("user", "hello");
    const budget = estimateMessageTokens(toolResult) + estimateMessageTokens(last);
    const fit = fitToBudget(
      { system: "", messages: [text("user", "a".repeat(400)), toolResult, last], toolTokens: 0 },
      budget
    );
    expect(fit.messages[0].role).not.toBe("tool");
  });
});

const designs = [
  { name: "cutoff", ns: () => env.CutoffAgent, tools: [] as string[] },
  { name: "builtin", ns: () => env.BuiltinAgent, tools: ["set_context"] },
  { name: "search", ns: () => env.SearchAgent, tools: [] as string[] }
];

describe.each(designs)("equal context budget: $name", ({ name, ns, tools }) => {
  it("never sends the model more than the budget, and fills it once history is long", async () => {
    const stub = await getAgentByName(ns(), `budget-${name}`);
    const calls = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      // Built-in: the model saves a fact first (a second model call in the
      // same turn, now carrying the tool call and result), then answers.
      const model = scriptedModel(
        name === "builtin"
          ? [
              {
                toolCall: {
                  toolName: "set_context",
                  input: { label: "memory", content: "Dog: Biscuit" }
                }
              },
              { text: "Noted!" }
            ]
          : []
      );
      agent.modelOverride = model;
      await agent.addMessages(filler(120));
      const result = await agent.saveMessages([
        userMessage("My dog is called Biscuit. What do you think about dogs?")
      ]);
      expect(result.status).toBe("completed");
      return model.doStreamCalls.map((c) => ({
        tokens: estimateCall(c as never),
        tools: (c.tools ?? []).map((t) => ("name" in t ? t.name : ""))
      }));
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.tokens).toBeLessThanOrEqual(B);
      // Only the design's own tools: never the workspace file tools.
      expect(call.tools.sort()).toEqual([...tools].sort());
    }
    // History is far longer than the budget, so no design should leave much
    // of it unused. Built-in dips to about 85% right after a compaction.
    expect(calls[0].tokens).toBeGreaterThan(B * 0.8);
  });
});
