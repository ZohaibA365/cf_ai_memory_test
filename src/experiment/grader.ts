import type { AskStep } from "./conversation";

// Rule-based grader, version 2. The rules were tuned against 12 hand-labelled
// pilot answers (labels/pilot-b-review-001.csv), so grader agreement must be
// measured on separate hand labels from the main run.
//
// - Fact questions (simple, exact, changed, combine): right when every
//   expected group is stated (not negated) and no outdated value is given as
//   current. An outdated value framed as past or negated is fine ("you moved
//   from Toronto to Austin", "a paramedic now, not a nurse"). Giving both old
//   and new values as current, or asking which one is current, is wrong. A
//   combine answer missing any part is wrong.
// - "never" questions: right when the answer clearly says it was never told,
//   even if it mentions the other item as context ("only your dog, Biscuit");
//   wrong when it answers instead, e.g. with the confusable value.
//
// The rules above settle every case, so v2 never returns "unclear"; the
// verdict type keeps it for answers a future rule cannot settle.

export const GRADER_VERSION = 2;

export type Verdict = "right" | "wrong" | "unclear";

export interface Grade {
  verdict: Verdict;
  reasons: string[];
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20"
};

/**
 * Lowercase, strip accents and markdown, turn "2,291" into "2291", "14th"
 * into "14", small number words into digits, and collapse everything that is
 * not a letter or digit into single spaces.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(" ")
    .trim();
}

/** Whole-word (or whole-phrase) match on normalized text. */
export function mentions(answer: string, phrase: string): boolean {
  const a = ` ${normalize(answer)} `;
  const p = normalize(phrase);
  return p.length > 0 && a.includes(` ${p} `);
}

// Ways the assistant says it was never told. Matched on normalized text, so
// no apostrophes ("didnt", "havent").
const ABSTAIN_PATTERNS = [
  /\b(you )?(never|didnt|did not|havent|have not|hasnt|has not|wasnt|was not) (been )?(told|tell|mentioned|mention|said|say|shared|share|given|give|provided|provide)\b/,
  /\b(not|never) (been )?(mentioned|told|shared|said|provided|given)\b/,
  /\b(i )?(dont|do not) (know|have|recall|remember)\b/,
  /\bno (information|record|mention|memory|details?)\b/,
  /\b(isnt|is not|wasnt|was not) (something )?(mentioned|in our conversation|stated)\b/,
  /\b(cant|cannot|can not|unable to) (recall|find|remember|tell|say)\b/,
  /\bnot sure\b/
];

// Words that mark an outdated value as past ("moved from Toronto", "used to
// live in Toronto", "Toronto, but not anymore").
const PAST_BEFORE = /\b(from|used to|previously|formerly|originally|before|no longer|left|was|were|old|earlier|instead of|rather than)\b/;
const PAST_AFTER = /\b(anymore|any more|no longer|previously|before|earlier|originally|in the past)\b/;

const ARTICLES = new Set(["a", "an", "the", "in", "at"]);

/** Word positions where `phrase` occurs in the normalized answer. */
function occurrences(answer: string, phrase: string): { words: string[]; at: number[]; length: number } {
  const words = normalize(answer).split(" ");
  const target = normalize(phrase).split(" ");
  const at: number[] = [];
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((w, j) => words[i + j] === w)) at.push(i);
  }
  return { words, at, length: target.length };
}

/** "not X", "not a X": the mention is negated. */
function negatedAt(words: string[], i: number): boolean {
  if (words[i - 1] === "not") return true;
  return ARTICLES.has(words[i - 1]) && words[i - 2] === "not";
}

/**
 * True when every mention of `phrase` is framed as past ("moved from
 * Toronto") or negated ("not a nurse"), i.e. never given as current.
 */
export function mentionedAsPast(answer: string, phrase: string): boolean {
  const { words, at, length } = occurrences(answer, phrase);
  if (at.length === 0) return false;
  return at.every((i) => {
    if (negatedAt(words, i)) return true;
    const before = words.slice(Math.max(0, i - 5), i).join(" ");
    const after = words.slice(i + length, i + length + 3).join(" ");
    return PAST_BEFORE.test(before) || PAST_AFTER.test(after);
  });
}

/** True when `phrase` is stated at least once without being negated. */
export function affirms(answer: string, phrase: string): boolean {
  const { words, at } = occurrences(answer, phrase);
  return at.some((i) => !negatedAt(words, i));
}

export function abstains(answer: string): boolean {
  const a = normalize(answer);
  return ABSTAIN_PATTERNS.some((re) => re.test(a));
}

export function grade(question: AskStep, answer: string): Grade {
  if (!answer.trim()) return { verdict: "wrong", reasons: ["empty answer"] };
  const outdatedHits = question.outdated.filter((o) => mentions(answer, o));

  if (question.type === "never") {
    if (abstains(answer)) {
      return {
        verdict: "right",
        reasons: outdatedHits.length
          ? [`says it was never told (mentions ${outdatedHits.join(", ")} only as context)`]
          : ["says it was never told"]
      };
    }
    return {
      verdict: "wrong",
      reasons: outdatedHits.length
        ? [`answers with ${outdatedHits.join(", ")} instead of saying it was never told`]
        : ["answers instead of saying it was never told"]
    };
  }

  const missing = question.expected.filter((group) => !group.some((alt) => affirms(answer, alt)));
  const outdatedAsCurrent = outdatedHits.filter((o) => !mentionedAsPast(answer, o));

  if (missing.length === 0 && outdatedAsCurrent.length === 0) {
    return {
      verdict: "right",
      reasons: outdatedHits.length
        ? [`contains every expected fact; mentions ${outdatedHits.join(", ")} only as past or negated`]
        : ["contains every expected fact"]
    };
  }
  if (missing.length === 0) {
    return {
      verdict: "wrong",
      reasons: [`gives both the current value and outdated ${outdatedAsCurrent.join(", ")}`]
    };
  }
  if (outdatedAsCurrent.length > 0) {
    return { verdict: "wrong", reasons: [`gives outdated ${outdatedAsCurrent.join(", ")}`] };
  }
  if (abstains(answer)) {
    return { verdict: "wrong", reasons: ["says it does not know"] };
  }
  const found = question.expected.length - missing.length;
  return {
    verdict: "wrong",
    reasons: [
      found > 0 ? `found only ${found} of ${question.expected.length} expected facts` : "no expected fact found",
      `missing: ${missing.map((g) => g[0]).join(", ")}`
    ]
  };
}
