import { describe, expect, it } from "vitest";
import type { AskStep } from "../src/experiment/conversation";
import { abstains, grade, mentionedAsPast, mentions, normalize } from "../src/experiment/grader";

function ask(over: Partial<AskStep>): AskStep {
  return {
    kind: "ask",
    id: "q",
    question: "?",
    type: "simple",
    expected: [["Biscuit"]],
    outdated: [],
    dependsOn: [],
    ...over
  };
}

describe("normalize and mentions", () => {
  it("evens out case, accents, punctuation, numbers and ordinals", () => {
    expect(normalize("Café, 2,291 on March 14th!")).toBe("cafe 2291 on march 14");
    expect(normalize("You have THREE kids.")).toBe("you have 3 kids");
    expect(normalize("**Biscuit**")).toBe("biscuit");
  });

  it("matches whole words only", () => {
    expect(mentions("Your dog is Rex.", "Rex")).toBe(true);
    expect(mentions("Your dog is Rexford.", "Rex")).toBe(false);
    expect(mentions("Flight UA2291", "2291")).toBe(false);
    expect(mentions("Flight UA 2291", "UA 2291")).toBe(true);
  });
});

describe("abstains", () => {
  it.each([
    "You never told me your cat's name.",
    "I don't know your cat's name — you haven't mentioned it.",
    "You didn't mention having a cat.",
    "That hasn't been shared in our conversation.",
    "I'm not sure; I have no information about a cat.",
    "I can't recall you telling me that."
  ])("recognizes: %s", (answer) => {
    expect(abstains(answer)).toBe(true);
  });

  it.each(["Your cat is called Luna.", "It's Biscuit!"])("does not fire on: %s", (answer) => {
    expect(abstains(answer)).toBe(false);
  });
});

describe("grade: fact questions", () => {
  it("right when the expected answer appears", () => {
    expect(grade(ask({}), "Your dog's name is Biscuit! 🐶").verdict).toBe("right");
  });

  it("accepts any listed spelling", () => {
    const q = ask({ type: "exact", expected: [["2291", "UA 2291"]] });
    expect(grade(q, "It's flight UA 2,291.").verdict).toBe("right");
  });

  it("wrong when missing, when it abstains, or when empty", () => {
    expect(grade(ask({}), "Your dog is called Max.").verdict).toBe("wrong");
    expect(grade(ask({}), "You never told me.").verdict).toBe("wrong");
    expect(grade(ask({}), "   ").verdict).toBe("wrong");
  });
});

describe("grade: changed facts", () => {
  const q = ask({ type: "changed", expected: [["Austin"]], outdated: ["Toronto"] });

  it("right with only the current value", () => {
    expect(grade(q, "You live in Austin.").verdict).toBe("right");
  });

  it("right when the old value is framed as past", () => {
    expect(grade(q, "You moved from Toronto to Austin.").verdict).toBe("right");
    expect(grade(q, "You live in Austin now; you used to live in Toronto.").verdict).toBe("right");
    expect(mentionedAsPast("Toronto, but not anymore", "Toronto")).toBe(true);
    expect(mentionedAsPast("You live in Toronto.", "Toronto")).toBe(false);
  });

  it("wrong with only the old value", () => {
    expect(grade(q, "You live in Toronto.").verdict).toBe("wrong");
  });

  it("wrong when both appear as current, or when it asks which is current", () => {
    const g = grade(q, "You live in Toronto and Austin.");
    expect(g.verdict).toBe("wrong");
    expect(g.reasons[0]).toContain("Toronto");
    expect(grade(q, "You mentioned both Austin and Toronto. Which city do you live in now?").verdict).toBe("wrong");
  });

  it('counts "X, not Y" as right, and a negated expected value as missing', () => {
    const job = ask({ type: "changed", expected: [["paramedic"]], outdated: ["nurse"] });
    expect(grade(job, "You're a paramedic now, not a nurse.").verdict).toBe("right");
    expect(grade(job, "You're not a paramedic; you're a nurse.").verdict).toBe("wrong");
  });
});

describe("grade: combine", () => {
  const q = ask({ type: "combine", expected: [["Priya"], ["Lisbon"]] });

  it("right only with every fact", () => {
    expect(grade(q, "Priya lives in Lisbon.").verdict).toBe("right");
  });

  it("wrong when a part is missing", () => {
    const g = grade(q, "Your sister is Priya.");
    expect(g.verdict).toBe("wrong");
    expect(g.reasons[0]).toContain("1 of 2");
    expect(grade(q, "No idea, sorry.").verdict).toBe("wrong");
  });
});

describe("grade: never said", () => {
  const q = ask({ type: "never", expected: [], outdated: ["Biscuit"] });

  it("right when it says it was never told", () => {
    expect(grade(q, "You never told me your cat's name.").verdict).toBe("right");
  });

  it("wrong when it makes something up or reuses another fact", () => {
    expect(grade(q, "Your cat is called Luna.").verdict).toBe("wrong");
    const reused = grade(q, "Your cat is Biscuit.");
    expect(reused.verdict).toBe("wrong");
    expect(reused.reasons[0]).toContain("Biscuit");
  });

  it("right when it says never told and mentions the other item as context", () => {
    expect(grade(q, "You haven't mentioned a cat, only your dog Biscuit.").verdict).toBe("right");
  });
});

// The 12 pilot answers the user hand-labelled (labels/pilot-b-review-001.csv).
// These tuned grader v2, so they guard against regressions but are not used
// to measure grader agreement.
describe("grader v2 matches the user's labels on the tuning set", () => {
  const never = (outdated: string) => ask({ type: "never", expected: [], outdated: [outdated] });
  const cases: [string, ReturnType<typeof ask>, string, "right" | "wrong"][] = [
    ["1", ask({ type: "combine", expected: [["90"], ["Olivetta"]] }),
      "The memory doesn't include your grandmother's age, but you mentioned her party is at Olivetta. Would you like to add her age or clarify other details?", "wrong"],
    ["2", never("Biscuit"), "I don't have information about your cat's name. The details you've shared so far are about your dog, Biscuit, and your location in Toronto. Would you like to share your cat's name? 😊", "right"],
    ["3", never("Biscuit"), "I don't have any information about a cat in our conversation. You've only mentioned your dog, Biscuit. Let me know if you'd like to share more about a cat!", "right"],
    ["4", never("Biscuit"), "I don’t know your cat’s name—your messages only mention your dog, Biscuit, and your sister, Priya. 🐾 Let me know if you’d like to share more!", "right"],
    ["5", never("Biscuit"), "I don't have information about your cat's name, as you've only mentioned your dog's name, Biscuit. Let me know if you'd like to share more details!", "right"],
    ["6", never("Mochi"), "You haven't mentioned having a dog. You've only shared that you have a cat named Mochi. 🐱", "right"],
    ["7", never("Mochi"), "I don't have information about a dog in our conversation. You've only mentioned a cat named Mochi. Would you like to add details about a dog or clarify?", "right"],
    ["8", never("Mochi"), "You haven't mentioned having a dog. I only know you have a cat named Mochi. Let me know if you need help with anything else!", "right"],
    ["9", never("Mochi"), "I don't have information about your dog's name, as you haven't mentioned a dog before. You've only shared that you have a cat named Mochi. Let me know if you'd like to add more details! 😊", "right"],
    ["10", never("Mochi"), "I don't have information about a dog—your pet is a cat named Mochi. Let me know how else I can help! 😊", "right"],
    ["11", ask({ type: "changed", expected: [["paramedic"]], outdated: ["nurse"] }),
      "You mentioned you're a paramedic now, not a nurse. Let me know if you need help with anything else! 😊", "right"],
    ["12", ask({ type: "changed", expected: [["Austin"]], outdated: ["Toronto"] }),
      "You mentioned both Austin and Toronto in our conversation. Could you clarify which city you currently live in?", "wrong"]
  ];
  it.each(cases)("item %s", (_n, question, answer, label) => {
    expect(grade(question, answer).verdict).toBe(label);
  });
});
