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

export const builtinDesign: MemoryDesign = {
  name: "builtin",
  activeTools: ["set_context"],

  contextBlocks: () => [
    {
      label: MEMORY_LABEL,
      description:
        "Facts the user has told you about themselves (names, places, " +
        "numbers, dates, plans). Save each new fact with set_context as soon " +
        "as you learn it, and replace a fact when it changes.",
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
  }
};
