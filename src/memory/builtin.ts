import { createCompactFunction } from "agents/sessions";
import { BUILTIN } from "../config";
import type { MemoryDesign } from "./design";
import { messageText } from "./tokens";

// Built-in: Think's own memory. The model keeps a writable "memory" block up
// to date with the set_context tool, and Sessions compaction replaces older
// messages with a summary once history passes a threshold.
//
// The summary arrives as an assistant message whose text is exactly the
// stored summary. We move it into the system prompt so the shared budget
// step, which drops the oldest messages first, can never drop it.

export const MEMORY_LABEL = "memory";
const SUMMARY_HEADING = "SUMMARY OF EARLIER CONVERSATION:";

// Two wordings of the memory block's description. "main" is used for the
// experiment. "shipped" is the original wording, kept as a variant: with it,
// the model sometimes overwrote the whole block with only the newest fact
// (set_context replaces the block by default), so the stage 4 pilot measures
// how often each wording loses facts.
export const MEMORY_DESCRIPTIONS = {
  main:
    "Everything you know about the user: ALL the facts they have told you " +
    "about themselves (names, places, numbers, dates, plans). Save each new " +
    "fact with set_context as soon as you learn it. A write replaces the " +
    "whole block, so every write must include all the facts that still " +
    "apply; change only a fact that has changed.",
  shipped:
    "Facts the user has told you about themselves (names, places, " +
    "numbers, dates, plans). Save each new fact with set_context as soon " +
    "as you learn it, and replace a fact when it changes."
} as const;
export type BuiltinVariant = keyof typeof MEMORY_DESCRIPTIONS;

export function makeBuiltinDesign(variant: BuiltinVariant): MemoryDesign {
  return {
    name: "builtin",
    variant,
    activeTools: ["set_context"],

    contextBlocks: () => [
      {
        label: MEMORY_LABEL,
        description: MEMORY_DESCRIPTIONS[variant],
        maxTokens: BUILTIN.memoryBlockTokens
      }
    ],

    configureSession: (session, hooks) =>
      session
        .onCompaction(
          createCompactFunction({
            summarize: hooks.summarize,
            keepRecentTokens: BUILTIN.keepRecentTokens
          })
        )
        .compactAfter(BUILTIN.compactAfterTokens)
        .onCompactionError(hooks.onCompactionError),

    async prepareTurn({ system, messages, session }) {
      const latest = (await session.getCompactions()).at(-1);
      if (!latest) return { system, messages };
      const at = messages.findIndex(
        (m) => m.role === "assistant" && messageText(m) === latest.summary
      );
      // Not in the active history: that summary no longer applies.
      if (at === -1) return { system, messages };
      return {
        system: `${system}\n\n${SUMMARY_HEADING}\n${latest.summary}`,
        messages: messages.filter((_, i) => i !== at),
        notes: { summaryInPrompt: true }
      };
    },

    async inspect(session) {
      const compactions = await session.getCompactions();
      return {
        memoryBlock: session.getContextBlock(MEMORY_LABEL)?.content ?? "",
        compactions: compactions.length,
        latestSummary: compactions.at(-1)?.summary ?? null
      };
    },

    memoryBlock: (session) => session.getContextBlock(MEMORY_LABEL)?.content ?? ""
  };
}

export const builtinDesign = makeBuiltinDesign("main");
export const builtinShippedDesign = makeBuiltinDesign("shipped");
