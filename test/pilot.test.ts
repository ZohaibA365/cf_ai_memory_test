import { describe, expect, it } from "vitest";
import { loadConversations } from "../src/experiment/data";
import { factLoss, factsFor, pickLength, type Snapshot } from "../src/experiment/pilot";

const seed01 = loadConversations().find((c) => c.id === "seed-01")!;
const stepOf = (id: string) => seed01.steps.findIndex((s) => "id" in s && s.id === id);

describe("factsFor", () => {
  it("lists what seed-01's memory should hold, and what may go out of date", () => {
    const facts = factsFor(seed01);
    const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
    expect(byId["q-dog:0"].saidAt).toBe(stepOf("dog-city"));
    expect(byId["q-city:0"].saidAt).toBe(stepOf("move"));
    expect(byId["q-flight:0"].saidAt).toBe(stepOf("flight"));
    expect(byId["q-sister:0"].saidAt).toBe(stepOf("sister-name"));
    expect(byId["q-sister:1"].saidAt).toBe(stepOf("sister-job"));
    // Toronto applies until the move, then may be dropped.
    expect(byId["old:Toronto"]).toMatchObject({ saidAt: stepOf("dog-city"), outdatedAt: stepOf("move") });
  });
});

describe("factLoss", () => {
  const facts = factsFor(seed01);
  const outcome = (snapshots: Snapshot[], id: string) =>
    factLoss(facts, snapshots).find((o) => o.fact.id === id)!;

  // The memory blocks recorded in stage3-check-5 (built-in, new wording).
  const observed: Snapshot[] = [
    { stepIndex: stepOf("dog-city"), memoryBlock: "my dog is called Biscuit, and I live in Toronto" },
    { stepIndex: stepOf("flight"), memoryBlock: "my dog is called Biscuit, and I live in Toronto. My flight to visit my sister is UA 2291, leaving on March 14." },
    { stepIndex: stepOf("sister-name"), memoryBlock: "my dog is called Biscuit, and I live in Toronto. My flight to visit my sister is UA 2291, leaving on March 14. My sister's name is Priya." },
    { stepIndex: stepOf("move"), memoryBlock: "my dog is called Biscuit, and I live in Austin" },
    { stepIndex: stepOf("sister-job"), memoryBlock: "my dog is called Biscuit, and I live in Austin" }
  ];

  it("counts the facts the move rewrite dropped as lost", () => {
    expect(outcome(observed, "q-flight:0")).toMatchObject({ saved: true, lost: true, missingAtEnd: true });
    expect(outcome(observed, "q-sister:0")).toMatchObject({ saved: true, lost: true, missingAtEnd: true });
  });

  it("does not count dropping an outdated value after its change", () => {
    expect(outcome(observed, "old:Toronto")).toMatchObject({ saved: true, lost: false });
    expect(outcome(observed, "q-city:0")).toMatchObject({ saved: true, lost: false });
  });

  it("separates never saved from lost", () => {
    expect(outcome(observed, "q-sister:1")).toMatchObject({ saved: false, lost: false, missingAtEnd: false });
    expect(outcome(observed, "q-dog:0")).toMatchObject({ saved: true, lost: false });
  });
});

describe("pickLength", () => {
  it("takes the shortest scale where cut-off is at most half right", () => {
    const choice = pickLength([
      { scale: 2, cutoff: 0.1, others: { builtin: 0.7, search: 0.8 } },
      { scale: 0.5, cutoff: 0.8, others: { builtin: 0.9, search: 0.9 } },
      { scale: 1, cutoff: 0.4, others: { builtin: 0.6, search: 0.8 } }
    ]);
    expect(choice.scale).toBe(1);
  });

  it("skips a scale where every design collapses", () => {
    const choice = pickLength([
      { scale: 1, cutoff: 0.5, others: { builtin: 0.5, search: 0.4 } },
      { scale: 2, cutoff: 0.2, others: { builtin: 0.6, search: 0.7 } }
    ]);
    expect(choice.scale).toBe(2);
  });

  it("says so when no scale qualifies", () => {
    expect(pickLength([{ scale: 1, cutoff: 0.9, others: { search: 1 } }]).scale).toBeNull();
  });
});
