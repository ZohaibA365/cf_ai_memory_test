import { simulateReadableStream, type ModelMessage, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { estimateMessageTokens, estimateTextTokens } from "../src/memory/tokens";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 }
};

export type ScriptedReply =
  | { text: string }
  | { toolCall: { toolName: string; input: Record<string, unknown> } };

/**
 * A fake model. Each chat call streams the next scripted reply ("ok" once the
 * script runs out); summary calls (doGenerate) return `summary`, or throw if
 * `summary` is an Error.
 */
export function scriptedModel(
  replies: ScriptedReply[] = [],
  summary: string | Error = "Summary: the user chatted about filler topics."
) {
  let next = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const reply = replies[next++] ?? { text: "ok" };
      const chunks =
        "text" in reply
          ? [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: reply.text },
              { type: "text-end" as const, id: "t" }
            ]
          : [
              {
                type: "tool-call" as const,
                toolCallId: `call-${next}`,
                toolName: reply.toolCall.toolName,
                input: JSON.stringify(reply.toolCall.input)
              }
            ];
      return {
        stream: simulateReadableStream({
          chunks: [
            ...chunks,
            {
              type: "finish" as const,
              finishReason:
                "text" in reply
                  ? { unified: "stop" as const, raw: "stop" }
                  : { unified: "tool-calls" as const, raw: "tool_calls" },
              usage
            }
          ]
        })
      };
    },
    doGenerate: async () => {
      if (summary instanceof Error) throw summary;
      return {
        content: [{ type: "text", text: summary }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: []
      };
    }
  });
}

export function userMessage(text: string, id: string = crypto.randomUUID()): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export function assistantMessage(text: string, id: string = crypto.randomUUID()): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const TOPICS = [
  "the weather this week",
  "a sourdough recipe",
  "how tides work",
  "learning the guitar",
  "a podcast about volcanoes",
  "planning a vegetable garden",
  "chess openings",
  "the history of maps"
];

/** Deterministic unrelated small talk: `pairs` user/assistant exchanges. */
export function filler(pairs: number, prefix = "f"): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    const topic = TOPICS[i % TOPICS.length];
    out.push(
      userMessage(`Can you tell me something interesting about ${topic}? (${i})`, `${prefix}-u-${i}`),
      assistantMessage(
        `Sure! Here is a short note about ${topic}. It is a broad subject with ` +
          `plenty of detail, and people enjoy exploring it in different ways. (${i})`,
        `${prefix}-a-${i}`
      )
    );
  }
  return out;
}

type PromptMessage = { role: string; content: unknown };
type CallTool = { name?: string; description?: string; inputSchema?: unknown };

/**
 * Estimated tokens of what a model call actually received, measured with the
 * same estimator the agent uses for the budget.
 */
export function estimateCall(call: {
  prompt: PromptMessage[];
  tools?: CallTool[];
}): number {
  let total = 0;
  for (const m of call.prompt) {
    total +=
      m.role === "system"
        ? estimateTextTokens(String(m.content))
        : estimateMessageTokens(m as ModelMessage);
  }
  for (const t of call.tools ?? []) {
    total += estimateTextTokens(
      `${t.name} ${t.description ?? ""} ${JSON.stringify(t.inputSchema)}`
    );
  }
  return total;
}

/** All text a model call received, for "did the model see X" checks. */
export function callText(call: { prompt: PromptMessage[] }): string {
  return JSON.stringify(call.prompt);
}
