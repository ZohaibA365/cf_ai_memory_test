// Pure helpers for hand-labeling (scripts/labels.ts): stratified sampling,
// CSV in and out, and turning labels into SQL. No Node imports, so they are
// unit tested in the Workers test pool.

export interface AnswerRow {
  id: string;
  design: string;
  question_type: string;
  question: string;
  expected: string; // JSON groups
  outdated: string; // JSON list
  answer: string;
}

/** Small seeded PRNG (mulberry32), so a sample can be reproduced. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Up to `n` answers spread evenly over (question type × design), then
 * shuffled so the order gives nothing away.
 */
export function sampleForLabeling<T extends AnswerRow>(rows: T[], n: number, seed: number): T[] {
  const random = rng(seed);
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.question_type}|${row.design}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const queues = [...groups.keys()].sort().map((k) => shuffle(groups.get(k)!, random));
  const picked: T[] = [];
  while (picked.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      if (picked.length >= n) break;
      const next = q.shift();
      if (next) picked.push(next);
    }
  }
  return shuffle(picked, random);
}

/** "Priya AND marine biologist", with " or " between accepted spellings. */
export function describeExpected(expectedJson: string): string {
  const groups = JSON.parse(expectedJson) as string[][];
  if (groups.length === 0) return "(should say it was never told)";
  return groups.map((g) => g.join(" or ")).join(" AND ");
}

export const CSV_COLUMNS = ["answer_id", "question", "expected", "outdated", "answer", "label", "note"] as const;

/** Blind rows: no design, no rule verdict. */
export function toLabelCsv(rows: AnswerRow[]): string {
  const lines = rows.map((r) =>
    [
      r.id,
      r.question,
      describeExpected(r.expected),
      (JSON.parse(r.outdated) as string[]).join(" | "),
      r.answer,
      "",
      ""
    ]
      .map(csvField)
      .join(",")
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV: quoted fields may contain commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface ParsedLabel {
  answerId: string;
  label: "right" | "wrong" | "unclear";
  note: string;
}

export interface LabelParseResult {
  labels: ParsedLabel[];
  blank: number;
  errors: string[];
}

/** Reads a filled-in CSV. Blank labels are skipped, bad ones reported. */
export function readLabels(csv: string): LabelParseResult {
  const [header, ...rows] = parseCsv(csv);
  const col = (name: string) => header?.indexOf(name) ?? -1;
  const idCol = col("answer_id");
  const labelCol = col("label");
  const noteCol = col("note");
  if (idCol === -1 || labelCol === -1) {
    return { labels: [], blank: 0, errors: ["missing answer_id or label column"] };
  }
  const result: LabelParseResult = { labels: [], blank: 0, errors: [] };
  rows.forEach((r, i) => {
    const raw = (r[labelCol] ?? "").trim().toLowerCase();
    if (!raw) {
      result.blank++;
      return;
    }
    const label = ({ r: "right", w: "wrong", u: "unclear" } as Record<string, string>)[raw] ?? raw;
    if (label !== "right" && label !== "wrong" && label !== "unclear") {
      result.errors.push(`row ${i + 2}: label "${raw}" must be right, wrong or unclear`);
      return;
    }
    result.labels.push({ answerId: r[idCol].trim(), label, note: (r[noteCol] ?? "").trim() });
  });
  return result;
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function labelsToSql(labels: ParsedLabel[], labeler: string, batch: string, labeledAt: string): string {
  return labels
    .map(
      (l) =>
        `INSERT OR REPLACE INTO human_labels (answer_id, labeler, label, note, batch, labeled_at) ` +
        `VALUES (${q(l.answerId)}, ${q(labeler)}, ${q(l.label)}, ${q(l.note)}, ${q(batch)}, ${q(labeledAt)});`
    )
    .join("\n");
}

/** Agreement between the rule grader and a human, for the analysis. */
export function agreement(pairs: { rule: string; human: string }[]) {
  const n = pairs.length;
  if (n === 0) return { n, agreement: 0, kappa: 0 };
  const cats = ["right", "wrong", "unclear"];
  const agree = pairs.filter((p) => p.rule === p.human).length / n;
  const expected = cats.reduce((sum, c) => {
    const pr = pairs.filter((p) => p.rule === c).length / n;
    const ph = pairs.filter((p) => p.human === c).length / n;
    return sum + pr * ph;
  }, 0);
  const kappa = expected === 1 ? 1 : (agree - expected) / (1 - expected);
  return { n, agreement: agree, kappa };
}
