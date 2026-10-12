import { fillerFor, type Conversation, type FillerPair } from "./conversation";
import { mentions } from "./grader";

// Checks that keep the filler honest: small talk must not contain personal
// details about the user (which would give the memory designs extra facts to
// confuse), and must not mention any answer a conversation asks about (which
// would let a design "remember" something it was never told).

const PERSONAL = [
  /\bmy (dog|cat|pet|sister|brother|wife|husband|partner|son|daughter|kids?|mom|mum|dad|mother|father|grand(mother|father|ma|pa)|friend|boss|job|flight|address|birthday|name|code|password|phone|apartment|house)\b/i,
  /\bi('m| am) (allergic|a |an |training|moving|from)\b/i,
  /\bi (live|moved|work|was born|play the)\b/i,
  /\bmy name is\b/i
];

export function hasPersonalDetail(text: string): boolean {
  return PERSONAL.some((re) => re.test(text));
}

/** Every answer-like phrase a conversation's questions depend on. */
export function answerPhrases(conversation: Conversation): string[] {
  const phrases = new Set<string>();
  for (const step of conversation.steps) {
    if (step.kind !== "ask") continue;
    for (const group of step.expected) for (const alt of group) phrases.add(alt);
    for (const o of step.outdated) phrases.add(o);
  }
  return [...phrases];
}

export interface Leak {
  phrase: string;
  text: string;
}

/** Filler in this conversation that mentions one of its answers. */
export function answerLeaks(
  conversation: Conversation,
  pool: FillerPair[],
  scale = 1
): Leak[] {
  const phrases = answerPhrases(conversation);
  const leaks: Leak[] = [];
  for (const block of fillerFor(conversation, pool, scale)) {
    for (const pair of block) {
      for (const text of [pair.user, pair.assistant]) {
        for (const phrase of phrases) {
          if (mentions(text, phrase)) leaks.push({ phrase, text });
        }
      }
    }
  }
  return leaks;
}
