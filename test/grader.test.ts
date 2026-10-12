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

  it("unclear when both appear as current", () => {
    const g = grade(q, "You live in Toronto and Austin.");
    expect(g.verdict).toBe("unclear");
    expect(g.reasons[0]).toContain("Toronto");
  });
});

describe("grade: combine", () => {
  const q = ask({ type: "combine", expected: [["Priya"], ["Lisbon"]] });

  it("right only with every fact", () => {
    expect(grade(q, "Priya lives in Lisbon.").verdict).toBe("right");
  });

  it("unclear with some facts, wrong with none", () => {
    expect(grade(q, "Your sister is Priya.").verdict).toBe("unclear");
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

  it("unclear when it abstains but mentions a confusable fact", () => {
    expect(
      grade(q, "You haven't mentioned a cat, only your dog Biscuit.").verdict
    ).toBe("unclear");
  });
});
