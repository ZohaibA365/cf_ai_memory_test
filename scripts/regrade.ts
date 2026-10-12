// Re-grades stored answers with the current grader rules (no model calls),
// e.g. after the grader changed. Prints how many verdicts changed.
//
//   npm run regrade -- pilot-b,pilot-c,pilot-d

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { conversationSchema, type AskStep, type Conversation } from "../src/experiment/conversation";
import { grade, GRADER_VERSION } from "../src/experiment/grader";
import { executeFile, query, sqlString } from "./d1";

const ids = process.argv[2]?.split(",");
if (!ids?.length) {
  console.error("Usage: npm run regrade -- <experiment id>[,<experiment id>...]");
  process.exit(1);
}

const conversations = new Map<string, Conversation>();
function questionFor(conversationId: string, questionId: string): AskStep {
  if (!conversations.has(conversationId)) {
    conversations.set(
      conversationId,
      conversationSchema.parse(JSON.parse(readFileSync(`data/conversations/${conversationId}.json`, "utf8")))
    );
  }
  const step = conversations.get(conversationId)!.steps.find((s) => s.kind === "ask" && s.id === questionId);
  if (!step || step.kind !== "ask") throw new Error(`${conversationId}: no question ${questionId}`);
  return step;
}

const rows = query<{ id: string; conversation_id: string; question_id: string; answer: string; rule_verdict: string }>(
  `SELECT a.id, r.conversation_id, a.question_id, a.answer, a.rule_verdict
   FROM answers a JOIN runs r ON r.id = a.run_id
   WHERE r.experiment_id IN (${ids.map(sqlString).join(", ")})`
);

const changes = new Map<string, number>();
const statements: string[] = [];
for (const row of rows) {
  const g = grade(questionFor(row.conversation_id, row.question_id), row.answer);
  const key = `${row.rule_verdict} -> ${g.verdict}`;
  changes.set(key, (changes.get(key) ?? 0) + 1);
  statements.push(
    `UPDATE answers SET rule_verdict = ${sqlString(g.verdict)}, rule_reasons = ${sqlString(JSON.stringify(g.reasons))}, ` +
      `needs_review = ${g.verdict === "unclear" ? 1 : 0}, grader_version = ${GRADER_VERSION} WHERE id = ${sqlString(row.id)};`
  );
}
mkdirSync("labels", { recursive: true });
const path = "labels/.regrade.sql";
writeFileSync(path, statements.join("\n") + "\n");
executeFile(path);

console.log(`Re-graded ${rows.length} answers in ${ids.join(", ")} with grader v${GRADER_VERSION}:`);
for (const [k, n] of [...changes].sort()) console.log(`  ${k.padEnd(18)} ${n}`);
