import { describe, expect, it } from "vitest";
import { chatItems, compact, memoryView, niceTicks, pct, plural } from "../src/client/demo-helpers";

const text = (id: string, role: string, t: string) => ({ id, role, parts: [{ type: "text", text: t }] });

describe("chatItems", () => {
  it("collapses fast-forwarded small talk into one line per run", () => {
    const items = chatItems([
      text("u1", "user", "Hi"),
      text("ff-0:0:u", "user", "q"),
      text("ff-0:0:a", "assistant", "a"),
      text("ff-0:1:u", "user", "q"),
      text("ff-0:1:a", "assistant", "a"),
      text("a1", "assistant", "  Hello!  "),
      text("ff-2:0:u", "user", "q")
    ]);
    expect(items.map((i) => (i.kind === "filler" ? [i.kind, i.exchanges] : [i.kind]))).toEqual([
      ["message"],
      ["filler", 2],
      ["message"],
      ["filler", 1]
    ]);
  });

  it("shows a compaction summary as a marker, not as a message", () => {
    const items = chatItems([
      text("compaction_abc", "assistant", "## Topic\nThe user talked about bread..."),
      text("u2", "user", "Where do I live now?")
    ]);
    expect(items).toEqual([
      { kind: "summary", id: "compaction_abc" },
      { kind: "message", id: "u2", role: "user", text: "Where do I live now?" }
    ]);
    expect(JSON.stringify(items)).not.toContain("bread");
  });

  it("counts a pair split by a summary once on each side, never as 0", () => {
    const items = chatItems([
      text("ff-0:0:u", "user", "q"),
      text("compaction_x", "assistant", "summary"),
      text("ff-0:47:a", "assistant", "a")
    ]);
    expect(items.map((i) => (i.kind === "filler" ? i.exchanges : i.kind))).toEqual([1, "summary", 1]);
  });

  it("skips messages with no text (e.g. only a tool call)", () => {
    expect(chatItems([{ id: "x", role: "assistant", parts: [{ type: "tool-set_context" }] }])).toEqual([]);
  });
});

describe("memoryView", () => {
  const base = { budgetTokens: 2000, lastTurn: { estimatedTokens: 1800, messagesSent: 20, messagesDropped: 7 } };

  it("describes what reached the model", () => {
    const v = memoryView({ ...base, design: "cutoff", memory: {} });
    expect(v.context).toBe("Last reply saw 20 messages (7 older ones dropped) · ~1800 of 2000 tokens");
    expect(v.sections[0].empty).toMatch(/newest messages/);
  });

  it("shows built-in's memory block and summary", () => {
    const v = memoryView({ ...base, design: "builtin", memory: { memoryBlock: "Dog: Biscuit", latestSummary: "S", compactions: 2 } });
    expect(v.sections.map((s) => [s.title, s.body])).toEqual([
      ["Memory block", "Dog: Biscuit"],
      ["Summary of older messages (2 so far)", "S"]
    ]);
  });

  it("shows what search retrieved", () => {
    const v = memoryView({
      ...base,
      design: "search",
      memory: {},
      lastTurn: { ...base.lastTurn, notes: { keywords: ["dog"], retrieved: [{ role: "user", content: "\n\nMy dog is Biscuit " }] } }
    });
    expect(v.sections[0]).toMatchObject({ title: "Looked up: dog", body: "user: My dog is Biscuit" });
  });

  it("handles an agent that has not replied yet", () => {
    expect(memoryView({ design: "search", budgetTokens: 2000, memory: {}, lastTurn: null }).context).toBeNull();
  });
});

describe("chart helpers", () => {
  it("makes clean ticks", () => {
    expect(niceTicks(100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(677)).toEqual([0, 200, 400, 600, 800]);
    expect(niceTicks(0)).toEqual([0]);
  });

  it("formats numbers", () => {
    expect(pct(3, 4)).toBe(75);
    expect(pct(0, 0)).toBe(0);
    expect(compact(950)).toBe("950");
    expect(compact(1284)).toBe("1.3K");
  });

  it("pluralizes", () => {
    expect(plural(1, "exchange")).toBe("1 exchange");
    expect(plural(0, "exchange")).toBe("0 exchanges");
    expect(plural(48, "exchange")).toBe("48 exchanges");
  });
});
