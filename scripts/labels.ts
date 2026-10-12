// Hand-labeling round trip.
//
//   npm run labels -- export --experiment pilot-1 [--n 100] [--seed 1] [--unclear]
//   npm run labels -- import labels/pilot-1-001.csv [--labeler you]
//
// Export writes a blind CSV (no design, no rule verdict): fill in the label
// column with right / wrong / unclear (or r / w / u) in any spreadsheet and
// save as CSV. --unclear exports every answer the rules flagged for review
// instead of a sample. Import loads the labels into D1, where they override
// the rule verdict in results.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { executeFile, query, sqlString } from "./d1";
import { labelsToSql, readLabels, sampleForLabeling, toLabelCsv, type AnswerRow } from "./labels-lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function exportBatch() {
  const experiment = arg("experiment");
  if (!experiment) throw new Error("export needs --experiment <id>");
  const n = Number(arg("n") ?? 100);
  const seed = Number(arg("seed") ?? 1);
  const unclearOnly = process.argv.includes("--unclear");
  const rows = query<AnswerRow>(
    `SELECT a.id, r.design, a.question_type, a.question, a.expected, a.outdated, a.answer
     FROM answers a JOIN runs r ON r.id = a.run_id
     WHERE r.experiment_id = ${sqlString(experiment)}
       ${unclearOnly ? "AND a.needs_review = 1" : ""}
       AND a.id NOT IN (SELECT answer_id FROM human_labels)`
  );
  const picked = unclearOnly ? rows : sampleForLabeling(rows, n, seed);
  mkdirSync("labels", { recursive: true });
  let k = 1;
  const path = () => `labels/${experiment}-${unclearOnly ? "review" : "sample"}-${String(k).padStart(3, "0")}.csv`;
  while (existsSync(path())) k++;
  writeFileSync(path(), toLabelCsv(picked));
  console.log(`Wrote ${picked.length} answers (of ${rows.length} unlabeled) to ${path()}`);
}

function importBatch() {
  const file = process.argv[3];
  if (!file || !existsSync(file)) throw new Error("import needs a CSV path");
  const labeler = arg("labeler") ?? "labeler-1";
  const parsed = readLabels(readFileSync(file, "utf8"));
  if (parsed.errors.length > 0) {
    console.error(parsed.errors.join("\n"));
    process.exit(1);
  }
  const batch = file.split("/").pop()!.replace(/\.csv$/, "");
  const sqlPath = `labels/.${batch}.sql`;
  writeFileSync(sqlPath, labelsToSql(parsed.labels, labeler, batch, new Date().toISOString()));
  executeFile(sqlPath);
  console.log(`Imported ${parsed.labels.length} labels from ${file} (${parsed.blank} left blank)`);
}

const command = process.argv[2];
if (command === "export") exportBatch();
else if (command === "import") importBatch();
else {
  console.error("Usage: npm run labels -- export --experiment <id> | import <file.csv>");
  process.exit(1);
}
