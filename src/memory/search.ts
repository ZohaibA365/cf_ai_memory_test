import type { ModelMessage } from "ai";
import { SEARCH } from "../config";
import type { MemoryDesign } from "./design";
import { estimateTextTokens, messageText } from "./tokens";

// Search: keep everything, and before each reply look up past messages that
// share words with the user's latest message. Matches go into the system
// prompt (in their own slice of the budget) and recent messages fill the
// rest.
//
// Sessions' search() treats its whole query as one exact phrase, so a natural
// question ("What's my dog's name?") would almost never match the message
// that planted the fact. Instead we search each keyword separately (porter
// stemming still applies) and rank messages by how many keywords they hit.

const STOPWORDS = new Set(
  (
    "a about after again all also am an and any are as at be because been " +
    "before being but by can could did do does doing for from had has have " +
    "having he her here hers him his how i if in into is it its just know " +
    "like me mine my myself no not now of on once only or our out over said " +
    "say she should so some tell than that the their them then there these " +
    "they this those to told too up us very was we were what when where " +
    "which while who whom why will with would you your yours remember"
  ).split(" ")
);

/** Content words from a message, in order, at most 8. */
export function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 8);
}

export interface Snippet {
  id: string;
  role: string;
  content: string;
  createdAt: string | null;
  hits: number;
}

const HEADING =
  "RELEVANT EARLIER MESSAGES (oldest first; if two disagree, the later one " +
  "is current):";

function latestUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messageText(messages[i]);
  }
  return "";
}

export function renderSnippets(snippets: Snippet[]): string {
  return snippets
    .map((s) => `[${s.createdAt ?? "earlier"}] ${s.role}: ${s.content}`)
    .join("\n");
}

export const searchDesign: MemoryDesign = {
  name: "search",
  activeTools: [],
  contextBlocks: () => [],
  configureSession: (session) => session,

  async prepareTurn({ system, messages, session }) {
    const query = latestUserText(messages);
    // Messages the model will see anyway are not worth a snippet.
    const recent = new Set(messages.slice(-6).map(messageText));

    const found = new Map<string, Snippet & { bestRank: number }>();
    for (const term of keywords(query)) {
      const results = await session.search(term, { limit: 20 });
      results.forEach((r, rank) => {
        if (recent.has(r.content)) return;
        const prev = found.get(r.id);
        if (prev) {
          prev.hits += 1;
          prev.bestRank = Math.min(prev.bestRank, rank);
        } else {
          found.set(r.id, {
            id: r.id,
            role: r.role,
            content: r.content,
            createdAt: null,
            hits: 1,
            bestRank: rank
          });
        }
      });
    }

    const ranked = [...found.values()].sort(
      (a, b) => b.hits - a.hits || a.bestRank - b.bestRank
    );
    const chosen: Snippet[] = [];
    let used = estimateTextTokens(HEADING);
    for (const s of ranked) {
      if (chosen.length >= SEARCH.maxResults) break;
      const cost = estimateTextTokens(`${s.role}: ${s.content}`) + 8;
      if (used + cost > SEARCH.snippetTokens) continue;
      chosen.push(s);
      used += cost;
    }
    if (chosen.length === 0) {
      return { system, messages, notes: { query, retrieved: [] } };
    }

    // Show matches in the order they were said, so updates read as updates.
    for (const s of chosen) {
      const stored = await session.getMessage(s.id);
      const created = stored?.createdAt;
      s.createdAt = created ? new Date(created).toISOString() : null;
    }
    chosen.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    return {
      system: `${system}\n\n${HEADING}\n${renderSnippets(chosen)}`,
      messages,
      notes: { query, keywords: keywords(query), retrieved: chosen }
    };
  },

  inspect: async () => ({
    note: "Keeps every message; retrieves matches for each new question."
  })
};
