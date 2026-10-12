// Scoring for the model tool-call smoke test (scripts/model-smoke.ts). Kept
// free of Node and Wrangler imports so it can be unit tested in Workers.

export interface SmokeCase {
  id: string;
  message: string;
  /** Substring (case-insensitive) the saved memory must contain. */
  expect: string;
}

export const SMOKE_CASES: SmokeCase[] = [
  { id: "pet", message: "By the way, my dog is called Biscuit.", expect: "biscuit" },
  { id: "move", message: "I just moved from Toronto to Austin last week.", expect: "austin" },
  { id: "number", message: "My flight number is UA 2291, leaving on March 14.", expect: "2291" },
  { id: "health", message: "Heads up: I'm allergic to peanuts.", expect: "peanut" },
  { id: "family", message: "My sister Priya lives in Lisbon.", expect: "priya" }
];

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
}

export interface TrialResult {
  model: string;
  caseId: string;
  trial: number;
  toolCalls: ToolCallRecord[];
  text: string;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** A trial passes when the model saved the expected fact to the memory block. */
export function trialPassed(trial: TrialResult, expected: string): boolean {
  if (trial.error) return false;
  return trial.toolCalls.some((call) => {
    if (call.toolName !== "set_context") return false;
    const input = call.input as { label?: unknown; content?: unknown } | null;
    return (
      input?.label === "memory" &&
      typeof input.content === "string" &&
      input.content.toLowerCase().includes(expected.toLowerCase())
    );
  });
}

export interface ModelSummary {
  model: string;
  trials: number;
  passed: number;
  passRate: number;
  errors: number;
  emptyReplies: number;
  medianLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(model: string, trials: TrialResult[], cases: SmokeCase[]): ModelSummary {
  const expectedById = new Map(cases.map((c) => [c.id, c.expect]));
  const passed = trials.filter((t) => trialPassed(t, expectedById.get(t.caseId) ?? "")).length;
  return {
    model,
    trials: trials.length,
    passed,
    passRate: trials.length ? passed / trials.length : 0,
    errors: trials.filter((t) => t.error).length,
    emptyReplies: trials.filter((t) => !t.error && !t.text.trim()).length,
    medianLatencyMs: median(trials.map((t) => t.latencyMs)),
    inputTokens: trials.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: trials.reduce((s, t) => s + t.outputTokens, 0)
  };
}

/** "Reliable" means at least 90% of planted facts saved, with no errors. */
export const RELIABLE_PASS_RATE = 0.9;

export function isReliable(s: ModelSummary): boolean {
  return s.passRate >= RELIABLE_PASS_RATE && s.errors === 0;
}
