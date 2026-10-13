import { describe, expect, it } from "vitest";

// Regression guard: an effect written as `useEffect(() => expr, ...)` returns
// expr's value, and React later calls a non-undefined value as the cleanup.
// `scrollIntoView()` returns a Promise in newer browsers, which crashed the
// demo page the moment a message was sent. Effects must use a block body.
const sources = import.meta.glob("../src/client/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("client effects", () => {
  it("never use an expression body", () => {
    const offenders = Object.entries(sources).flatMap(([file, code]) =>
      [...code.matchAll(/use(?:Layout)?Effect\(\s*\(\)\s*=>(?!\s*\{)/g)].map((m) => `${file}: ${code.slice(m.index, m.index! + 60)}`)
    );
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
