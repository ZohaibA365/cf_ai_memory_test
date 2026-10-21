import type { ModelMessage } from "ai";

// The text of a message, as the token estimate sees it. Kept apart from
// tokens.ts (which loads the WebAssembly module) so Node scripts can use it.

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null) return String(part);
  const p = part as Record<string, unknown>;
  if (p.type === "text" || p.type === "reasoning") return String(p.text ?? "");
  if (p.type === "tool-call") return `${p.toolName} ${JSON.stringify(p.input)}`;
  if (p.type === "tool-result") return `${p.toolName} ${JSON.stringify(p.output)}`;
  return JSON.stringify(p);
}

/** All of a message's text, its parts joined with "\n". */
export function messageText(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map(partText).join("\n");
}

/**
 * `messageText(message).length` without building the string: the parts'
 * lengths plus one per "\n" separator. The budget needs only lengths, and
 * joining every message's parts on every call would cost more than the fit.
 */
export function messageTextLength(message: ModelMessage): number {
  const { content } = message;
  if (typeof content === "string") return content.length;
  if (content.length === 0) return 0;
  let length = content.length - 1;
  for (const part of content) {
    // join() writes null and undefined as "", so they count as empty here too.
    const text: string | null | undefined = partText(part);
    length += text == null ? 0 : text.length;
  }
  return length;
}
