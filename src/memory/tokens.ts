import { asSchema, type ModelMessage, type ToolSet } from "ai";

// One token estimator shared by every design, so the equal budget is measured
// the same way for all of them. It is a heuristic (about 4 characters per
// token). The model-reported input tokens recorded after each call are the
// ground truth, and the analysis checks them against the budget.

const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null) return String(part);
  const p = part as Record<string, unknown>;
  if (p.type === "text" || p.type === "reasoning") return String(p.text ?? "");
  if (p.type === "tool-call") return `${p.toolName} ${JSON.stringify(p.input)}`;
  if (p.type === "tool-result") return `${p.toolName} ${JSON.stringify(p.output)}`;
  return JSON.stringify(p);
}

export function messageText(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map(partText).join("\n");
}

export function estimateMessageTokens(message: ModelMessage): number {
  return estimateTextTokens(messageText(message)) + MESSAGE_OVERHEAD_TOKENS;
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
  const fixed = estimateTextTokens(input.system) + input.toolTokens;
  const kept: ModelMessage[] = [];
  let used = fixed;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(input.messages[i]);
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(input.messages[i]);
    used += cost;
  }
  // A tool result must never lead the window without its tool call.
  while (kept.length > 1 && kept[0].role === "tool") {
    used -= estimateMessageTokens(kept.shift()!);
  }
  return {
    system: input.system,
    messages: kept,
    estimatedTokens: used,
    droppedMessages: input.messages.length - kept.length
  };
}
