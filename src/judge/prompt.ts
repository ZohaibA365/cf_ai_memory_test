import { parseCsv } from "../../scripts/labels-lib";

// The AI judge: a second grader that reads one answer and returns right or
// wrong plus a one-line reason. Its only worked examples are the 12 pilot
// answers the user hand-labelled to tune the rule grader
// (labels/pilot-b-review-001.csv). It never sees the 100 blind labels, which
// are what it is measured against.

export { JUDGE_MODEL } from "./config";

export const EXAMPLE_FILE = "labels/pilot-b-review-001.csv";

const files = import.meta.glob("../../labels/pilot-b-review-001.csv", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface JudgeItem {
  question: string;
  /** Accepted answer groups (all needed; any spelling in a group). Empty = never said. */
  expected: string[][];
  /** Values that were true once, or plausible confusions. */
  outdated: string[];
  reply: string;
}

export interface JudgeExample {
  answerId: string;
  question: string;
  expected: string;
  outdated: string;
  reply: string;
  label: "right" | "wrong";
}

/** The 12 tuning examples, straight from the labelled CSV. */
export function loadExamples(): JudgeExample[] {
  const raw = Object.values(files)[0];
  if (!raw) throw new Error(`${EXAMPLE_FILE} is missing`);
  const [head, ...rows] = parseCsv(raw);
  const col = (name: string) => head.indexOf(name);
  return rows.map((r) => {
    const label = r[col("label")].trim();
    if (label !== "right" && label !== "wrong") throw new Error(`example ${r[col("answer_id")]} is not labelled`);
    return {
      answerId: r[col("answer_id")],
      question: r[col("question")],
      expected: r[col("expected")],
      outdated: r[col("outdated")],
      reply: r[col("answer")].trim(),
      label
    };
  });
}

/**
 * One-line reasons for the examples: the user labelled right/wrong only, so
 * each reason restates the grading rule the user gave for that kind of case.
 */
function exampleReason(e: JudgeExample): string {
  if (e.expected.startsWith("(should say")) {
    return e.label === "right"
      ? "Clearly says it was never told; mentioning the other item is only context."
      : "Answers instead of saying it was never told.";
  }
  if (e.label === "right") return "Gives the current value; the old value appears only as rejected (\"not a nurse\").";
  if (/AND/.test(e.expected)) return "Gives only one of the facts asked for; a combined answer missing a part is wrong.";
  return "Gives both the old and the new value as possible and asks which is current.";
}

export function describeExpected(expected: string[][]): string {
  if (expected.length === 0) return "(should say it was never told)";
  return expected.map((g) => g.join(" or ")).join(" AND ");
}

export const JUDGE_RULES = `You grade one answer from a chat assistant. The user told the assistant some facts earlier in a long conversation, then asked a question. Decide whether the reply answers the question correctly.

Rules:
- Correct answer: the reply must state every part of the correct answer (parts joined by AND; any one spelling separated by "or" is fine). Extra friendly text is fine.
- Never told: when the correct answer is "(should say it was never told)", the reply is right if it clearly says it was never told or does not know. Mentioning another item as context is fine. It is wrong if it gives an answer instead, such as the confusable value.
- Changed facts: the reply is right if it gives the current value. Mentioning the old value is fine only if it is clearly rejected or in the past ("a paramedic now, not a nurse", "moved from Toronto"). Giving both old and new as possible, or asking which one is current, is wrong.
- Combined facts: missing any part is wrong.
- Saying it does not know, when a correct answer exists, is wrong.

Reply with exactly two lines and nothing else:
VERDICT: right
REASON: <one short sentence>
(or VERDICT: wrong)`;

function formatItem(question: string, expected: string, outdated: string, reply: string): string {
  return [
    `Question: ${question}`,
    `Correct answer: ${expected}`,
    `Outdated or confusable values: ${outdated || "(none)"}`,
    `Reply: ${reply}`
  ].join("\n");
}

/** System prompt: rules plus the 12 labelled examples. */
export function judgeSystemPrompt(examples: JudgeExample[] = loadExamples()): string {
  const shown = examples
    .map((e, i) => `Example ${i + 1}\n${formatItem(e.question, e.expected, e.outdated, e.reply)}\nVERDICT: ${e.label}\nREASON: ${exampleReason(e)}`)
    .join("\n\n");
  return `${JUDGE_RULES}\n\nLabelled examples:\n\n${shown}`;
}

/** User prompt for one item. Never includes any human label or rule verdict. */
export function judgeUserPrompt(item: JudgeItem): string {
  return `${formatItem(item.question, describeExpected(item.expected), item.outdated.join(" | "), item.reply.trim())}\n\nGrade this reply.`;
}

export interface JudgeVerdict {
  verdict: "right" | "wrong";
  reason: string;
}

/** Strict parse of "VERDICT: right|wrong" and "REASON: …"; null if malformed. */
export function parseVerdict(text: string): JudgeVerdict | null {
  const v = /^\s*\**VERDICT\**\s*:\s*\**\s*(right|wrong)\b/im.exec(text);
  if (!v) return null;
  const r = /^\s*\**REASON\**\s*:\s*\**\s*(.+)$/im.exec(text);
  return { verdict: v[1].toLowerCase() as "right" | "wrong", reason: (r?.[1] ?? "").trim().slice(0, 300) };
}
