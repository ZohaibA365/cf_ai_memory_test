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
  | { kind: "filler"; id: string; exchanges: number };

/** Collapses fast-forwarded small talk (ids "ff-…") into one item per run of it. */
export function chatItems(messages: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.id.startsWith("ff-")) {
      const last = items.at(-1);
      if (last?.kind === "filler") {
        if (m.role === "user") last.exchanges += 1;
      } else {
        items.push({ kind: "filler", id: m.id, exchanges: m.role === "user" ? 1 : 0 });
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
