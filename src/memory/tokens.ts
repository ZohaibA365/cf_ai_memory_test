import { asSchema, type ModelMessage, type ToolSet } from "ai";
import { budget as wasm } from "./budget-wasm";
import { messageTextLength } from "./message-text";

export { messageText, messageTextLength } from "./message-text";

// One token estimator shared by every design, so the equal budget is measured
// the same way for all of them. It is a heuristic (about 4 characters per
// token, plus 4 per message). The model-reported input tokens recorded after
// each call are the ground truth, and the analysis checks them against the
// budget.
//
// The counting rules and the budget decision run in Rust (rust/budget,
// compiled to WebAssembly). The estimate depends only on each text's length in
// UTF-16 code units, so this file passes lengths, not text.

/** Estimated tokens for text: ceil(length / 4), length in UTF-16 code units. */
export function estimateTextTokens(text: string): number {
  return wasm.textTokens(text.length);
}

export function estimateMessageTokens(message: ModelMessage): number {
  return wasm.messageTokens(messageTextLength(message));
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** Tokens for the definitions of the tools the model is allowed to call. */
export async function estimateToolTokens(
  tools: ToolSet,
  activeTools: string[]
): Promise<number> {
  let total = 0;
  for (const name of activeTools) {
    const tool = tools[name];
    if (!tool) continue;
    const schema = await asSchema(tool.inputSchema).jsonSchema;
    total += estimateTextTokens(
      `${name} ${tool.description ?? ""} ${JSON.stringify(schema)}`
    );
  }
  return total;
}

export interface BudgetInput {
  system: string;
  messages: ModelMessage[];
  toolTokens: number;
}

export interface BudgetResult {
  system: string;
  messages: ModelMessage[];
  estimatedTokens: number;
  droppedMessages: number;
}

/**
 * Drops the oldest messages until system + messages + tools fit the budget.
 * The newest message is always kept, so a turn can never be emptied; if the
 * system prompt and that one message alone exceed the budget, the result is
 * over budget and `estimatedTokens` says by how much.
 */
export function fitToBudget(input: BudgetInput, budget: number): BudgetResult {
  // A tool result must never lead the window without its tool call, so the
  // Rust side is told which messages are tool results.
  const { start, estimatedTokens } = wasm.fitToBudget(
    input.system.length,
    input.messages.map(messageTextLength),
    input.messages.map((m) => m.role === "tool"),
    input.toolTokens,
    budget
  );
  return {
    system: input.system,
    messages: input.messages.slice(start),
    estimatedTokens,
    droppedMessages: start
  };
}
