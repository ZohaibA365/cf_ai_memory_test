import type { AskStep } from "./conversation";

// Rule-based grader. A clear right or wrong answer gets that verdict; an
// answer the rules cannot settle is "unclear" and goes to manual review.
//
// - Fact questions (simple, exact, changed, combine): right when every
//   expected group matches and no outdated value appears. If an outdated
//   value also appears, it is still right when every mention is framed as
//   past ("you moved from Toronto to Austin"); otherwise it is unclear.
// - "never" questions: right when the answer says it was never told, and
//   names none of the listed confusions; wrong when it confidently answers.

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

/** True when every mention of `phrase` is framed as being in the past. */
export function mentionedAsPast(answer: string, phrase: string): boolean {
  const words = normalize(answer).split(" ");
  const target = normalize(phrase).split(" ");
  let found = false;
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.some((w, j) => words[i + j] !== w)) continue;
    found = true;
    const before = words.slice(Math.max(0, i - 5), i).join(" ");
    const after = words.slice(i + target.length, i + target.length + 3).join(" ");
    if (!PAST_BEFORE.test(before) && !PAST_AFTER.test(after)) return false;
  }
  return found;
}

export function abstains(answer: string): boolean {
  const a = normalize(answer);
  return ABSTAIN_PATTERNS.some((re) => re.test(a));
}

export function grade(question: AskStep, answer: string): Grade {
  if (!answer.trim()) return { verdict: "wrong", reasons: ["empty answer"] };
  const outdatedHits = question.outdated.filter((o) => mentions(answer, o));

  if (question.type === "never") {
    const abstained = abstains(answer);
    if (abstained && outdatedHits.length === 0) {
      return { verdict: "right", reasons: ["says it was never told"] };
    }
    if (abstained) {
      return {
        verdict: "unclear",
        reasons: [`says it was never told but mentions ${outdatedHits.join(", ")}`]
      };
    }
    return {
      verdict: "wrong",
      reasons: outdatedHits.length
        ? [`answers with ${outdatedHits.join(", ")} instead of saying it was never told`]
        : ["answers instead of saying it was never told"]
    };
  }

  const missing = question.expected.filter((group) => !group.some((alt) => mentions(answer, alt)));
  const allExpected = missing.length === 0;

  if (allExpected && outdatedHits.length === 0) {
    return { verdict: "right", reasons: ["contains every expected fact"] };
  }
  if (allExpected && outdatedHits.every((o) => mentionedAsPast(answer, o))) {
    return {
      verdict: "right",
      reasons: [`contains the expected answer; mentions ${outdatedHits.join(", ")} only as past`]
    };
  }
  if (allExpected) {
    return {
      verdict: "unclear",
      reasons: [`contains the expected answer and also ${outdatedHits.join(", ")}`]
    };
  }
  if (outdatedHits.length > 0) {
    return { verdict: "wrong", reasons: [`gives outdated ${outdatedHits.join(", ")}`] };
  }
  if (abstains(answer)) {
    return { verdict: "wrong", reasons: ["says it does not know"] };
  }
  // Partially right on a combine question, or no recognizable answer at all:
  // a person should look.
  const found = question.expected.length - missing.length;
  return {
    verdict: found > 0 ? "unclear" : "wrong",
    reasons: [
      found > 0
        ? `found ${found} of ${question.expected.length} expected facts`
        : "no expected fact found",
      `missing: ${missing.map((g) => g[0]).join(", ")}`
    ]
  };
}
