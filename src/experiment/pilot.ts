import type { Conversation } from "./conversation";
import { mentions } from "./grader";

// Pilot analysis helpers (stage 4). Pure functions; scripts/pilot-report.ts
// feeds them rows from D1.

// ---- Fact loss in the built-in design's memory block -------------------

export interface Fact {
  /** Stable id: question id + expected group (or "old:" + outdated value). */
  id: string;
  alternatives: string[];
  /** Step index of the message that states the fact. */
  saidAt: number;
  /** Step index of the change that makes this fact outdated, if any. */
  outdatedAt: number | null;
}

/**
 * The facts a memory should hold, derived from the questions: each expected
 * answer group that a depended-on message states, plus each outdated value a
 * planted message states (which may be dropped once it is changed).
 */
export function factsFor(conversation: Conversation): Fact[] {
  const index = new Map<string, number>();
  conversation.steps.forEach((s, i) => {
    if (s.kind !== "filler") index.set(s.id, i);
  });
  const sayText = (id: string) => {
    const s = conversation.steps[index.get(id) ?? -1];
    return s?.kind === "say" ? s.text : "";
  };
  const facts = new Map<string, Fact>();
  for (const step of conversation.steps) {
    if (step.kind !== "ask" || step.type === "never") continue;
    step.expected.forEach((group, g) => {
      for (const dep of step.dependsOn) {
        if (group.some((alt) => mentions(sayText(dep), alt))) {
          facts.set(`${step.id}:${g}`, {
            id: `${step.id}:${g}`,
            alternatives: group,
            saidAt: index.get(dep)!,
            outdatedAt: null
          });
          break;
        }
      }
    });
    const change = step.dependsOn
      .map((d) => conversation.steps[index.get(d) ?? -1])
      .find((s) => s?.kind === "say" && s.purpose === "change");
    for (const old of step.outdated) {
      for (const dep of step.dependsOn) {
        const s = conversation.steps[index.get(dep) ?? -1];
        if (s?.kind === "say" && s.purpose !== "change" && mentions(s.text, old)) {
          facts.set(`old:${old}`, {
            id: `old:${old}`,
            alternatives: [old],
            saidAt: index.get(dep)!,
            outdatedAt: change && change.kind !== "filler" ? index.get(change.id)! : null
          });
        }
      }
    }
  }
  return [...facts.values()];
}

export interface Snapshot {
  stepIndex: number;
  memoryBlock: string;
}

export interface FactOutcome {
  fact: Fact;
  /** Ever present in the block after it was said. */
  saved: boolean;
  /** Present, then missing at a later turn while it still applied. */
  lost: boolean;
  /** Missing from the final block while it still applied. */
  missingAtEnd: boolean;
}

export function factLoss(facts: Fact[], snapshots: Snapshot[]): FactOutcome[] {
  const ordered = [...snapshots].sort((a, b) => a.stepIndex - b.stepIndex);
  return facts.map((fact) => {
    const applies = (s: Snapshot) => fact.outdatedAt === null || s.stepIndex < fact.outdatedAt;
    const present = (s: Snapshot) => fact.alternatives.some((a) => mentions(s.memoryBlock, a));
    let saved = false;
    let lost = false;
    for (const s of ordered) {
      if (s.stepIndex < fact.saidAt || !applies(s)) continue;
      if (present(s)) saved = true;
      else if (saved) lost = true;
    }
    const last = ordered.at(-1);
    const stillApplies = fact.outdatedAt === null;
    return {
      fact,
      saved,
      lost,
      missingAtEnd: saved && stillApplies && !!last && !present(last)
    };
  });
}

// ---- Choosing the conversation length ----------------------------------

export interface ScaleResult {
  scale: number;
  /** Fact-question accuracy (right / decided), "never" questions excluded. */
  cutoff: number;
  /** The same for the designs that should keep remembering. */
  others: Record<string, number>;
}

export interface LengthChoice {
  scale: number | null;
  reason: string;
}

/**
 * The shortest scale where cut-off gets at most half of the fact questions
 * right, unless every design collapses there too (no other design above
 * half), in which case that scale is skipped.
 */
export function pickLength(results: ScaleResult[]): LengthChoice {
  const sorted = [...results].sort((a, b) => a.scale - b.scale);
  for (const r of sorted) {
    if (r.cutoff > 0.5) continue;
    const best = Math.max(...Object.values(r.others));
    if (best > 0.5) {
      return {
        scale: r.scale,
        reason: `cut-off ${(100 * r.cutoff).toFixed(0)}% ≤ 50%, best other design ${(100 * best).toFixed(0)}% > 50%`
      };
    }
  }
  const failing = sorted.filter((r) => r.cutoff <= 0.5);
  return {
    scale: null,
    reason: failing.length
      ? "cut-off fails at some scale, but every design collapses there too"
      : "cut-off never drops to 50% or below in the scales tried"
  };
}
