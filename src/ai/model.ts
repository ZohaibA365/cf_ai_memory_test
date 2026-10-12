import { extractReasoningMiddleware, wrapLanguageModel, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { MODEL_ID } from "../config";
import { dedupeWorkersAI } from "./dedupe-binding";

/**
 * The chat model every design uses. Two fixes on top of the provider:
 * - the AI binding is wrapped so streamed text and tool calls are not doubled
 *   (see dedupe-binding.ts);
 * - Qwen3 sometimes writes its reasoning inline as "<think>…</think>" text
 *   (seen after a tool call), so that text is moved into reasoning parts and
 *   never shown or graded as part of the answer.
 */
export function createChatModel(ai: Ai, modelId: string = MODEL_ID) {
  return wrapLanguageModel({
    model: createWorkersAI({ binding: dedupeWorkersAI(ai) })(modelId as never),
    middleware: extractReasoningMiddleware({ tagName: "think" })
  });
}

/**
 * Removes the model's earlier reasoning from history before it is resent, so
 * old thinking never takes budget away from conversation. Applied the same
 * way for every design.
 */
export function withoutReasoning(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content = m.content.filter((p) => p.type !== "reasoning");
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}
