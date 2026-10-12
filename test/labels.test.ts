import { describe, expect, it } from "vitest";
import {
  agreement,
  describeExpected,
  labelsToSql,
  parseCsv,
  readLabels,
  sampleForLabeling,
  toLabelCsv,
  type AnswerRow
} from "../scripts/labels-lib";

function row(i: number, type: string, design: string): AnswerRow {
  return {
    id: `id${i}`,
    design,
    question_type: type,
    question: `Question ${i}?`,
    expected: JSON.stringify([["Biscuit"]]),
    outdated: "[]",
    answer: `Answer ${i}`
  };
}

const types = ["simple", "changed", "exact", "combine", "never"];
const designs = ["cutoff", "builtin", "search"];
const rows = types.flatMap((t, ti) => designs.flatMap((d, di) => Array.from({ length: 20 }, (_, k) => row(ti * 1000 + di * 100 + k, t, d))));

describe("sampleForLabeling", () => {
  it("spreads the sample evenly over question type and design", () => {
    const picked = sampleForLabeling(rows, 30, 1);
    expect(picked).toHaveLength(30);
    const counts = new Map<string, number>();
    for (const r of picked) counts.set(`${r.question_type}|${r.design}`, (counts.get(`${r.question_type}|${r.design}`) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 2)).toBe(true);
  });

  it("is reproducible with the same seed and different with another", () => {
    const ids = (seed: number) => sampleForLabeling(rows, 20, seed).map((r) => r.id);
    expect(ids(1)).toEqual(ids(1));
    expect(ids(1)).not.toEqual(ids(2));
  });

  it("returns everything when asked for more than exists", () => {
    expect(sampleForLabeling(rows.slice(0, 5), 100, 1)).toHaveLength(5);
  });
});

describe("blind CSV", () => {
  it("hides the design and round-trips awkward text", () => {
    const awkward = { ...row(1, "combine", "builtin"), answer: 'She said "hi",\nthen left.', expected: JSON.stringify([["Priya"], ["marine biologist", "biologist"]]) };
    const csv = toLabelCsv([awkward]);
    expect(csv).not.toContain("builtin");
    const [header, values] = parseCsv(csv);
    expect(header).toEqual(["answer_id", "question", "expected", "outdated", "answer", "label", "note"]);
    expect(values[4]).toBe('She said "hi",\nthen left.');
    expect(values[2]).toBe("Priya AND marine biologist or biologist");
  });

  it("describes never-said questions plainly", () => {
    expect(describeExpected("[]")).toBe("(should say it was never told)");
  });
});

describe("readLabels", () => {
  const csv = (labels: string[]) =>
    toLabelCsv([row(1, "simple", "cutoff"), row(2, "simple", "cutoff"), row(3, "simple", "cutoff")])
      .split("\r\n")
      .map((line, i) => (i === 0 || !line ? line : line.replace(/,,$/, `,${labels[i - 1]},`)))
      .join("\r\n");

  it("accepts full words and single letters, skipping blanks", () => {
    const r = readLabels(csv(["Right", "w", ""]));
    expect(r.errors).toEqual([]);
    expect(r.blank).toBe(1);
    expect(r.labels.map((l) => l.label)).toEqual(["right", "wrong"]);
  });

  it("reports labels it does not understand", () => {
    expect(readLabels(csv(["maybe", "", ""])).errors[0]).toMatch(/row 2/);
  });
});

describe("labelsToSql", () => {
  it("escapes quotes in notes", () => {
    const sql = labelsToSql([{ answerId: "a1", label: "right", note: "it's fine" }], "me", "b1", "2026-10-12");
    expect(sql).toContain("'it''s fine'");
  });
});

describe("agreement", () => {
  it("computes percent agreement and Cohen's kappa", () => {
    const pairs = [
      { rule: "right", human: "right" },
      { rule: "right", human: "right" },
      { rule: "wrong", human: "wrong" },
      { rule: "wrong", human: "right" }
    ];
    const a = agreement(pairs);
    expect(a.agreement).toBe(0.75);
    // Expected agreement = 0.5*0.75 + 0.5*0.25 = 0.5, so kappa = 0.5.
    expect(a.kappa).toBeCloseTo(0.5, 5);
  });
});
