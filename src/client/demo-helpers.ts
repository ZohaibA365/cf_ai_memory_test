// Pure helpers for the demo page (no React, no DOM), so they can be tested.

export const DESIGNS = [
  { key: "cutoff", agent: "CutoffAgent", path: "cutoff-agent", label: "Cut-off", blurb: "Keeps only the newest messages that fit." },
  { key: "builtin", agent: "BuiltinAgent", path: "builtin-agent", label: "Built-in memory", blurb: "Think's memory block plus summaries." },
  { key: "search", agent: "SearchAgent", path: "search-agent", label: "Search", blurb: "Keeps everything; looks up matches per question." }
] as const;
export type DesignKey = (typeof DESIGNS)[number]["key"];

export const DESIGN_LABEL: Record<string, string> = Object.fromEntries(DESIGNS.map((d) => [d.key, d.label]));

// ---- Chat rendering ------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string }>;
}

export type ChatItem =
  | { kind: "message"; id: string; role: string; text: string }
  | { kind: "filler"; id: string; exchanges: number; pairs: string[] }
  | { kind: "summary"; id: string };

/** "1 exchange", "2 exchanges". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The transcript as shown in a demo column: fast-forwarded small talk (ids
 * "ff-…") collapses into one item per run of it, and a compaction summary
 * (Think shows it as a message with an id starting "compaction_") becomes a
 * marker instead of looking like something the assistant said.
 */
export function chatItems(messages: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.id.startsWith("compaction_")) {
      items.push({ kind: "summary", id: m.id });
      continue;
    }
    if (m.id.startsWith("ff-")) {
      // Count exchanges by pair id ("ff-<block>:<i>"), so a pair split by a
      // summary still counts once on each side.
      const pair = m.id.replace(/:[ua]$/, "");
      const last = items.at(-1);
      if (last?.kind === "filler") {
        if (!last.pairs.includes(pair)) last.pairs.push(pair);
        last.exchanges = last.pairs.length;
      } else {
        items.push({ kind: "filler", id: m.id, exchanges: 1, pairs: [pair] });
      }
      continue;
    }
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) items.push({ kind: "message", id: m.id, role: m.role, text });
  }
  return items;
}

// ---- Memory panel ----------------------------------------------------------

export interface InspectSnapshot {
  design: string;
  budgetTokens: number;
  memory: Record<string, unknown>;
  lastTurn: {
    estimatedTokens?: number;
    messagesSent?: number;
    messagesDropped?: number;
    notes?: { keywords?: string[]; retrieved?: { role: string; content: string }[] };
  } | null;
}

export interface MemoryView {
  context: string | null;
  sections: { title: string; body: string; empty?: string }[];
}

/** What each design is currently holding, in plain words. */
export function memoryView(s: InspectSnapshot): MemoryView {
  const t = s.lastTurn;
  const context = t
    ? `Last reply saw ${t.messagesSent ?? 0} messages` +
      (t.messagesDropped ? ` (${t.messagesDropped} older ones dropped)` : "") +
      ` · ~${t.estimatedTokens ?? 0} of ${s.budgetTokens} tokens`
    : null;
  if (s.design === "builtin") {
    const block = String(s.memory.memoryBlock ?? "");
    const summary = s.memory.latestSummary ? String(s.memory.latestSummary) : "";
    return {
      context,
      sections: [
        { title: "Memory block", body: block, empty: "Nothing saved yet." },
        { title: `Summary of older messages (${Number(s.memory.compactions ?? 0)} so far)`, body: summary, empty: "No summary yet." }
      ]
    };
  }
  if (s.design === "search") {
    const retrieved = t?.notes?.retrieved ?? [];
    const keywords = t?.notes?.keywords ?? [];
    return {
      context,
      sections: [
        {
          title: keywords.length ? `Looked up: ${keywords.join(", ")}` : "Looked up",
          body: retrieved.map((r) => `${r.role}: ${r.content.trim()}`).join("\n"),
          empty: "Nothing retrieved for the last message."
        }
      ]
    };
  }
  return { context, sections: [{ title: "Memory", body: "", empty: "Only the newest messages; anything older is gone." }] };
}

// ---- Chart helpers -------------------------------------------------------

/** Clean axis ticks from 0 to at least `max` (1, 2 or 5 × 10^n steps). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export function pct(right: number, decided: number): number {
  return decided ? (100 * right) / decided : 0;
}

/** 1,284 → "1.3K", 950 → "950". */
export function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

// ---- "Try it" and headline numbers ------------------------------------------

/** The one-click Toronto → Austin test: a fact, small talk, a change, small talk, the question. */
export type TryStep = { label: string } & ({ action: "send"; text: string } | { action: "fast-forward" });
export const TRY_STEPS: readonly TryStep[] = [
  { label: "Tell it where you live", action: "send", text: "I live in Toronto." },
  { label: "Fast-forward", action: "fast-forward" },
  { label: "Say you moved", action: "send", text: "I just moved to Austin." },
  { label: "Fast-forward", action: "fast-forward" },
  { label: "Ask where you live", action: "send", text: "Where do I live?" }
];

export interface DesignResult {
  design: string;
  scale: number;
  fact: { right: number; decided: number };
  medianMs: number;
  neuronsPerRun: number;
}

export interface StatTile {
  key: DesignKey;
  label: string;
  factPct: number;
  replySeconds: number;
  neuronsPerRun: number;
}

/** One tile per design at the longest length tested, in the page's design order. */
export function statTiles(rows: DesignResult[]): { scale: number; tiles: StatTile[] } {
  const scale = Math.max(...rows.map((r) => r.scale));
  const tiles = DESIGNS.flatMap((d) => {
    const r = rows.find((x) => x.design === d.key && x.scale === scale);
    return r
      ? [{ key: d.key, label: d.label, factPct: pct(r.fact.right, r.fact.decided), replySeconds: r.medianMs / 1000, neuronsPerRun: r.neuronsPerRun }]
      : [];
  });
  return { scale, tiles };
}
